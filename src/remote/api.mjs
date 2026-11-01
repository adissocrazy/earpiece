// Device and agent calls shared by the CLI and the Mac app. `fetch` is injected in tests.
// The Mac only ever calls out. Nothing here listens.
import { FUNCTIONS } from "../pro.mjs";
import { readJson, writeJson, ensureDirs } from "../util.mjs";
import { P } from "../paths.mjs";

/** Interim base until api.earpiece.dev exists. EARPIECE_RELAY_URL overrides it (tests, staging). */
export function relayUrl(cfg = {}) {
  const env = process.env.EARPIECE_RELAY_URL;
  const raw = env || cfg?.remote?.relayUrl || `${FUNCTIONS}/relay/v1`;
  return String(raw).replace(/\/$/, "");
}

export function loadRemoteState() {
  return readJson(P.remoteState, {}) || {};
}

export function saveRemoteState(patch) {
  ensureDirs();
  const next = { ...loadRemoteState(), ...patch };
  writeJson(P.remoteState, next);
  return next;
}

async function parse(res) {
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
    err.body = json;
    throw err;
  }
  return json;
}

/**
 * @param {object} o
 * @param {typeof fetch} [o.fetch]
 * @param {() => (string|null|Promise<string|null>)} [o.token] device JWT (ignored for agent calls)
 * @param {string} [o.agentToken]
 * @param {string} o.relayUrl
 */
export function createRemoteApi({ fetch = globalThis.fetch, token = () => null, agentToken = null, relayUrl: base, deviceId = null } = {}) {
  const root = String(base || "").replace(/\/$/, "");

  async function send(path, { method = "GET", body, headers = {}, timeoutMs = 30_000, agent = false } = {}) {
    const h = { Accept: "application/json", ...headers };
    if (agent) {
      if (!agentToken) throw Object.assign(new Error("missing agent token"), { status: 401, code: "invalid_token" });
      h.Authorization = `Bearer ${agentToken}`;
    } else {
      const t = await Promise.resolve(typeof token === "function" ? token() : token);
      if (!t) throw Object.assign(new Error("Remote agents need Earpiece Pro."), { status: 402, code: "pro_required" });
      h.Authorization = `Bearer ${t}`;
      const id = deviceId || loadRemoteState().deviceId;
      if (id) h["X-Earpiece-Device"] = id;
    }
    if (body) h["Content-Type"] = "application/json";
    const res = await fetch(`${root}${path}`, {
      method,
      headers: h,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return parse(res);
  }

  return {
    relayUrl: root,
    // No auth: a signed-out doctor check still learns whether the relay is up.
    async health() {
      const res = await fetch(`${root}/health`, { signal: AbortSignal.timeout(4000) });
      return parse(res);
    },
    async registerDevice({ name, platform = "macos", app_version }) {
      const json = await send("/devices", { method: "POST", body: { name, platform, app_version } });
      if (json?.device_id) saveRemoteState({ deviceId: json.device_id });
      return json;
    },
    createCode: (body) => send("/pairing/codes", { method: "POST", body }),
    approve: (claimId, body) => send(`/pairing/claims/${encodeURIComponent(claimId)}/approve`, { method: "POST", body }),
    deny: (claimId) => send(`/pairing/claims/${encodeURIComponent(claimId)}/deny`, { method: "POST", body: {} }),
    listAgents: () => send("/device/agents"),
    renameAgent: (id, body) => send(`/device/agents/${encodeURIComponent(id)}`, { method: "PATCH", body }),
    revokeAgent: (id) => send(`/device/agents/${encodeURIComponent(id)}`, { method: "DELETE" }),
    rotateAgent: (id) => send(`/device/agents/${encodeURIComponent(id)}/rotate`, { method: "POST", body: {} }),
    testAgent: (id) => send(`/device/agents/${encodeURIComponent(id)}/test`, { method: "POST", body: {} }),
    listDevices: () => send("/device/devices"),
    removeDevice: (id) => send(`/device/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),
    openQuestions: () => send("/device/open-questions"),
    events: (cursor, wait = 25) => {
      const q = new URLSearchParams({ wait: String(wait) });
      if (cursor) q.set("cursor", cursor);
      return send(`/device/events?${q}`, { timeoutMs: (Number(wait) + 10) * 1000 });
    },
    reply: (body) => send("/device/replies", { method: "POST", body }),
    ack: (cursor) => send("/device/ack", { method: "POST", body: { cursor } }),
    emit: (body, idempotencyKey) => send("/agents/events", {
      method: "POST",
      agent: true,
      body,
      headers: { "Idempotency-Key": idempotencyKey, "User-Agent": "earpiece-remote-js/1.0 (grokbot)" },
    }),
    agentReplies: ({ cursor, wait = 0, session_id, limit } = {}) => {
      const q = new URLSearchParams();
      if (cursor) q.set("cursor", cursor);
      q.set("wait", String(wait));
      if (session_id) q.set("session_id", session_id);
      if (limit) q.set("limit", String(limit));
      return send(`/agents/replies?${q}`, { agent: true, timeoutMs: (Number(wait) + 10) * 1000 });
    },
    ackReplies: (reply_ids) => send("/agents/replies/ack", { method: "POST", agent: true, body: { reply_ids } }),
    whoami: () => send("/agents/me", { agent: true }),
  };
}

/** POST /pairing/claim with no Authorization header. */
export async function claimPairing({ fetch = globalThis.fetch, relayUrl: base, body }) {
  const res = await fetch(`${String(base).replace(/\/$/, "")}/pairing/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "earpiece-remote-js/1.0 (grokbot)" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return parse(res);
}

/** GET a claim with the claim secret. Long-polls when wait > 0. */
export async function pollClaim({ fetch = globalThis.fetch, relayUrl: base, claimId, secret, wait = 25 }) {
  const res = await fetch(`${String(base).replace(/\/$/, "")}/pairing/claims/${encodeURIComponent(claimId)}?wait=${wait}`, {
    headers: { Accept: "application/json", "X-Claim-Secret": secret },
    signal: AbortSignal.timeout((wait + 10) * 1000),
  });
  return parse(res);
}
