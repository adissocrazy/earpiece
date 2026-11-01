// Outbound-only connection to the Earpiece relay. SSE over fetch, long-poll after three
// failures, jittered backoff. Never throws to the hub: a dead relay must not touch local agents.
import { ensureDirs, readJson, writeJson } from "../util.mjs";
import { P } from "../paths.mjs";
import { LIMITS } from "./protocol.mjs";

/** Full jitter: 0 .. min(60s, 1s × 2^attempt). `rand` is injected so tests can bound it. */
export function backoffMs(attempt, rand = Math.random(), retryAfterS = null) {
  if (Number.isFinite(retryAfterS) && retryAfterS >= 0) return Math.min(60_000, retryAfterS * 1000);
  const cap = Math.min(60_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.floor(Math.max(0, Math.min(1, rand)) * cap);
}

/** Split an SSE byte stream into blocks. Incomplete trailing data is returned as `rest`. */
export function parseSse(buffer) {
  const events = [];
  let rest = String(buffer || "");
  while (true) {
    const idx = rest.indexOf("\n\n");
    if (idx < 0) break;
    const raw = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    const ev = parseBlock(raw);
    if (ev) events.push(ev);
  }
  return { events, rest };
}

function parseBlock(raw) {
  let id = null;
  let event = "message";
  const data = [];
  let comment = false;
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line || line.startsWith(":")) {
      comment = true;
      continue;
    }
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (!data.length) return comment ? null : null;
  return { id, event, data: data.join("\n") };
}

function cursorOf(id) {
  const m = /^c_(\d+)$/.exec(String(id || ""));
  return m ? Number(m[1]) : null;
}

/**
 * @param {object} o
 * @param {typeof fetch} [o.fetch]
 * @param {() => (string|null|Promise<string|null>)} o.token  Supabase access token, or null when not Pro
 * @param {string} o.relayUrl
 * @param {(frame: object, meta: {id?: string}) => (void|Promise<void>)} o.onFrame
 * @param {(e: object) => void} [o.log]
 * @param {() => number} [o.now]
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @param {() => object} [o.readState]
 * @param {(s: object) => void} [o.writeState]
 */
export function createRemoteClient({
  fetch = globalThis.fetch,
  token,
  relayUrl,
  onFrame,
  log = () => {},
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  readState = () => readJson(P.remoteState, {}),
  writeState = (s) => (ensureDirs(), writeJson(P.remoteState, s)),
} = {}) {
  let stopped = true;
  let loop = null;
  let mode = "off";
  let failures = 0;
  let retryInS = 0;
  let planLapsed = false;
  const base = String(relayUrl || "").replace(/\/$/, "");

  const load = () => {
    try {
      return readState() || {};
    } catch {
      return {};
    }
  };
  const save = (patch) => {
    try {
      const cur = load();
      writeState({ ...cur, ...patch });
    } catch (e) {
      log({ warn: "remote_state", error: String(e?.message || e) });
    }
  };

  async function authHeaders() {
    const t = await Promise.resolve(typeof token === "function" ? token() : token).catch(() => null);
    if (!t) return null;
    const st = load();
    return {
      Authorization: `Bearer ${t}`,
      Accept: "application/json",
      ...(st.deviceId ? { "X-Earpiece-Device": st.deviceId } : {}),
    };
  }

  async function request(path, { method = "GET", body, headers = {}, timeoutMs = 30_000 } = {}) {
    const h = await authHeaders();
    if (!h) {
      const err = new Error("not signed in to Earpiece Pro");
      err.status = 401;
      err.code = "pro_required";
      throw err;
    }
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...h, ...headers, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = new Error(json?.error?.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.code = json?.error?.code || null;
      err.retryAfterS = Number(res.headers.get("retry-after")) || json?.error?.retry_after_s || null;
      err.body = json;
      throw err;
    }
    return json;
  }

  async function deliver(frame, id) {
    try {
      await onFrame?.(frame, { id });
    } catch (e) {
      log({ warn: "remote_frame", error: String(e?.message || e) });
    }
    if (id) save({ cursor: id, lastEventAt: now() });
  }

  async function readSse(cursor) {
    const h = await authHeaders();
    if (!h) {
      const err = new Error("not signed in to Earpiece Pro");
      err.status = 402;
      err.code = "pro_required";
      throw err;
    }
    const res = await fetch(`${base}/device/stream`, {
      headers: { ...h, Accept: "text/event-stream", ...(cursor ? { "Last-Event-ID": cursor } : {}) },
      signal: AbortSignal.timeout((LIMITS.streamS + 15) * 1000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      const err = new Error(json?.error?.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.code = json?.error?.code || null;
      err.retryAfterS = Number(res.headers.get("retry-after")) || null;
      throw err;
    }
    if (!res.body) throw new Error("no stream");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let resume = cursor || null;
    let sawBye = false;
    while (!stopped) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parsed = parseSse(buf);
      buf = parsed.rest;
      for (const ev of parsed.events) {
        if (ev.event === "bye") {
          try {
            resume = JSON.parse(ev.data).resume || ev.id || resume;
          } catch {
            resume = ev.id || resume;
          }
          sawBye = true;
          return { resume, bye: true };
        }
        let frame = null;
        try {
          frame = JSON.parse(ev.data);
        } catch {
          continue;
        }
        const id = ev.id || null;
        await deliver(frame, id);
        if (id) resume = id;
        if (frame?.frame === "plan_lapsed") {
          planLapsed = true;
          return { resume, lapsed: true };
        }
      }
    }
    if (!sawBye) throw Object.assign(new Error("stream closed"), { status: 0 });
    return { resume, bye: true };
  }

  async function readPoll(cursor) {
    const q = new URLSearchParams({ wait: String(LIMITS.pollWaitS) });
    if (cursor) q.set("cursor", cursor);
    const json = await request(`/device/events?${q}`, { timeoutMs: (LIMITS.pollWaitS + 10) * 1000 });
    let last = cursor || null;
    for (const item of json?.frames || []) {
      // { id, data } where data is the same object an SSE `data:` line carries.
      const frame = item?.data?.frame ? item.data : item;
      const id = item?.id || (item?.cursor != null ? `c_${String(item.cursor).padStart(12, "0")}` : null);
      if (frame?.frame) await deliver(frame, id);
      if (id) last = id;
      if (frame?.frame === "plan_lapsed") {
        planLapsed = true;
        return { resume: last, lapsed: true };
      }
    }
    if (json?.next_cursor) last = json.next_cursor;
    return { resume: last };
  }

  const yieldTurn = () => new Promise((r) => setImmediate(r));

  async function connectLoop() {
    failures = 0;
    mode = "sse";
    planLapsed = false;
    while (!stopped) {
      await yieldTurn(); // a relay that closes instantly must not spin the event loop
      if (stopped) return;
      const st = load();
      const cursor = st.cursor || null;
      try {
        const result = mode === "poll" ? await readPoll(cursor) : await readSse(cursor);
        failures = 0;
        retryInS = 0;
        save({ transport: mode, lastConnectAt: now(), lastError: null, retryInS: 0, planLapsed: false });
        if (result?.lapsed || planLapsed) {
          mode = "off";
          save({ transport: "off", planLapsed: true });
          stopped = true;
          return;
        }
        if (result?.resume && result.resume !== cursor) save({ cursor: result.resume });
        if (result?.bye && mode === "sse") continue; // server closed at 110s: reconnect at once
      } catch (e) {
        if (stopped) return;
        const status = e?.status;
        if (status === 402 || e?.code === "pro_required") {
          planLapsed = true;
          try {
            await onFrame?.({ frame: "plan_lapsed" }, {});
          } catch {}
          save({ transport: "off", planLapsed: true, lastError: "pro_required" });
          stopped = true;
          log({ warn: "remote_plan" });
          return;
        }
        failures++;
        if (mode === "sse" && failures >= 3) mode = "poll";
        const wait = backoffMs(failures - 1, Math.random(), e?.retryAfterS);
        retryInS = Math.max(1, Math.round(wait / 1000));
        save({ transport: mode === "poll" ? "poll" : "reconnecting", lastError: String(e?.message || e), retryInS, reconnectsToday: (load().reconnectsToday || 0) + 1 });
        log({ warn: "remote_connect", error: String(e?.message || e), mode, retryInS });
        await sleep(wait);
      }
    }
  }

  return {
    start() {
      if (loop) return;
      stopped = false;
      loop = connectLoop().catch((e) => log({ warn: "remote_loop", error: String(e?.message || e) })).finally(() => (loop = null));
    },
    async stop() {
      stopped = true;
      mode = "off";
      try {
        await loop;
      } catch {}
      loop = null;
    },
    async reply(body) {
      try {
        const json = await request("/device/replies", { method: "POST", body });
        return { ok: true, ...json };
      } catch (e) {
        return { ok: false, status: e?.status || 0, code: e?.code || null, error: e?.message || "request failed", body: e?.body || null };
      }
    },
    async ack(cursor) {
      try {
        await request("/device/ack", { method: "POST", body: { cursor } });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e?.message || "ack failed" };
      }
    },
    async call(path, opts) {
      try {
        const json = await request(path, opts);
        return { ok: true, json };
      } catch (e) {
        return { ok: false, status: e?.status || 0, code: e?.code || null, error: e?.message || "request failed", body: e?.body || null };
      }
    },
    state() {
      const st = load();
      return {
        transport: stopped ? "off" : mode === "poll" ? "poll" : loop ? mode : st.transport || "off",
        retryInS,
        planLapsed,
        deviceId: st.deviceId || null,
        cursor: st.cursor || null,
        lastConnectAt: st.lastConnectAt || null,
        lastError: st.lastError || null,
      };
    },
    /** Test seam: the numeric cursor last stored, if it was a c_ id. */
    cursorNumber: () => cursorOf(load().cursor),
  };
}
