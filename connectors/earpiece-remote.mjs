#!/usr/bin/env node
// Reference connector for a cloud agent (Grok Bot / Avery first). Zero dependencies, Node 18+.
// A reply authorizes only the question_id it answers. Irreversible actions still need the agent's own confirmation.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Kept identical to src/util.mjs SECRET_PATTERNS. test/connector.test.mjs fails if they drift.
export const SECRET_PATTERNS = [
  [/\b(sk|pk|rk)[-_][A-Za-z0-9*_-]{6,}/g, "[redacted]"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[redacted]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\bAIza[0-9A-Za-z_-]{35}/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted]"],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, "$1[redacted]@"],
  [/\b([\w-]*(?:api[_-]?key|secret|token|passw(?:or)?d)[\w-]*)(["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi, "$1$2[redacted]"],
  [/\b(Bearer|key|token)(["':=\s]+)(?=[A-Za-z0-9*._-]*[0-9*])[A-Za-z0-9*._-]{8,}/gi, "$1$2[redacted]"],
  [/epa_(?:live|test)_[A-Za-z0-9]{8,}/g, "[redacted]"],
  [/\bcls_[A-Za-z0-9]{8,}/g, "[redacted]"],
  [/\bwhsec_[A-Za-z0-9]{8,}/g, "[redacted]"],
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g, "[redacted]"],
];

export function redact(s) {
  let out = String(s ?? "");
  for (const [re, sub] of SECRET_PATTERNS) out = out.replace(re, sub);
  return out;
}

const LIMITS = { text: 2000, line: 200, title: 60, prompt: 300, label: 40 };

function clip(s, max) {
  const t = redact(String(s ?? ""));
  if ([...t].length <= max) return t;
  return [...t].slice(0, Math.max(0, max - 1)).join("") + "…";
}

export function prepareEvent(input) {
  const question = input.question
    ? {
        ...(input.question.id ? { id: String(input.question.id).slice(0, 64) } : {}),
        prompt: clip(input.question.prompt, LIMITS.prompt),
        ...(input.question.options ? { options: input.question.options.slice(0, 3).map((o) => ({ key: String(o.key).slice(0, 32), label: clip(o.label, LIMITS.label), ...(o.style ? { style: o.style } : {}) })) } : {}),
        ...(input.question.allow_text ? { allow_text: true } : {}),
        ...(input.question.expires_in_s ? { expires_in_s: input.question.expires_in_s } : {}),
      }
    : undefined;
  const body = {
    v: 1,
    session_id: String(input.session_id),
    status: input.status,
    ...(input.title ? { title: clip(input.title, LIMITS.title) } : {}),
    ...(input.line ? { line: clip(input.line, LIMITS.line) } : {}),
    ...(input.text ? { text: clip(input.text, LIMITS.text) } : {}),
    ...(question ? { question } : {}),
    ...(input.link ? { link: String(input.link) } : {}),
    ...(input.occurred_at ? { occurred_at: input.occurred_at } : {}),
    ...(input.seq != null ? { seq: input.seq } : {}),
  };
  const key = input.idempotency_key || crypto.createHash("sha256").update([body.session_id, body.status, question?.id || "", body.line || "", body.text || ""].join("|")).digest("hex").slice(0, 32);
  return { body, key };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, { method = "GET", token, headers = {}, body, timeoutMs = 30_000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      "User-Agent": "earpiece-remote-js/1.0 (grokbot)",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
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
    err.retryAfterS = Number(res.headers.get("retry-after")) || null;
    throw err;
  }
  return json;
}

function backoff(attempt, retryAfterS) {
  if (Number.isFinite(retryAfterS) && retryAfterS >= 0) return Math.min(60_000, retryAfterS * 1000);
  return Math.floor(Math.random() * Math.min(60_000, 1000 * 2 ** attempt));
}

export class EarpieceRemote {
  constructor(state, file) {
    this.state = state;
    this.file = file;
    this.proWarned = false;
  }

  static stateFile() {
    return process.env.EARPIECE_REMOTE_STATE || path.join(os.homedir(), ".earpiece-remote.json");
  }

  static async load(file = EarpieceRemote.stateFile()) {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!state?.token || !state?.relay_url) throw new Error("not paired");
    return new EarpieceRemote(state, file);
  }

  static async pair({ code, kind = "grokbot", name = "Avery", instance, version = "1.0.0", homepage, relayUrl, stateFile = EarpieceRemote.stateFile(), fetchImpl = fetch } = {}) {
    const base = String(relayUrl || process.env.EARPIECE_RELAY_URL || "").replace(/\/$/, "");
    if (!base) throw new Error("set EARPIECE_RELAY_URL");
    const claim = await request(`${base}/pairing/claim`, {
      method: "POST",
      body: { code, agent: { kind, name, instance, version, homepage }, requested_scopes: ["events:write", "questions:write", "replies:read"] },
    });
    const deadline = Date.parse(claim.expires_at) || Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const wait = Math.min(25, Math.max(1, Math.ceil((deadline - Date.now()) / 1000)));
      const res = await fetchImpl(`${base}/pairing/claims/${encodeURIComponent(claim.claim_id)}?wait=${wait}`, {
        headers: { Accept: "application/json", "X-Claim-Secret": claim.claim_secret },
        signal: AbortSignal.timeout((wait + 10) * 1000),
      });
      const body = await res.json();
      if (body.status === "denied") throw new Error("pairing denied");
      if (body.status === "approved" && body.token) {
        const state = { relay_url: body.relay_url || base, agent_id: body.agent_id, token: body.token };
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
        return new EarpieceRemote(state, stateFile);
      }
    }
    throw new Error("pairing expired");
  }

  outboxFile() {
    return `${this.file}.outbox.jsonl`;
  }

  async flushOutbox() {
    const file = this.outboxFile();
    if (!fs.existsSync(file)) return;
    const rows = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const keep = [];
    for (const row of rows) {
      if (Date.now() - row.at > 24 * 3600_000) continue;
      try {
        await this.#post(row.body, row.key);
      } catch (e) {
        if (e.status && e.status < 500 && e.status !== 429) continue;
        keep.push(row);
      }
    }
    if (keep.length) fs.writeFileSync(file, keep.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
    else fs.rmSync(file, { force: true });
  }

  async #post(body, key) {
    return request(`${this.state.relay_url}/agents/events`, {
      method: "POST",
      token: this.state.token,
      headers: { "Idempotency-Key": key },
      body,
    });
  }

  notePro(e) {
    if (e?.status === 402 && !this.proWarned) {
      this.proWarned = true;
      return "Earpiece Pro needed for notch updates.";
    }
    return null;
  }

  async emit(input) {
    await this.flushOutbox().catch(() => {});
    const { body, key } = prepareEvent(input);
    let attempt = 0;
    for (;;) {
      try {
        return await this.#post(body, key);
      } catch (e) {
        const pro = this.notePro(e);
        if (pro) throw Object.assign(new Error(pro), { status: 402, code: "pro_required" });
        const retry = !e.status || e.status === 429 || e.status >= 500;
        if (!retry || attempt >= 5) {
          if (retry) {
            fs.appendFileSync(this.outboxFile(), JSON.stringify({ at: Date.now(), key, body }) + "\n", { mode: 0o600 });
          }
          throw e;
        }
        await sleep(backoff(attempt++, e.retryAfterS));
      }
    }
  }

  async replies({ wait = 0, session_id, limit = 20 } = {}) {
    const q = new URLSearchParams({ wait: String(wait), limit: String(limit) });
    if (session_id) q.set("session_id", session_id);
    const cursorFile = `${this.file}.cursor`;
    const cursor = fs.existsSync(cursorFile) ? fs.readFileSync(cursorFile, "utf8").trim() : "";
    if (cursor) q.set("cursor", cursor);
    const json = await request(`${this.state.relay_url}/agents/replies?${q}`, {
      token: this.state.token,
      timeoutMs: (Number(wait) + 15) * 1000,
    });
    const seen = new Set();
    const replies = [];
    for (const r of json.replies || []) {
      if (!r.reply_id || seen.has(r.reply_id)) continue;
      seen.add(r.reply_id);
      replies.push(r);
    }
    if (replies.length) {
      await request(`${this.state.relay_url}/agents/replies/ack`, { method: "POST", token: this.state.token, body: { reply_ids: replies.map((r) => r.reply_id) } }).catch(() => {});
    }
    if (json.next_cursor) fs.writeFileSync(cursorFile, json.next_cursor, { mode: 0o600 });
    return replies;
  }

  async waitFor(agentQuestionId, { timeoutMs = 120_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const wait = Math.min(25, Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
      const replies = await this.replies({ wait });
      const hit = replies.find((r) => r.agent_question_id === agentQuestionId);
      if (hit) return hit;
    }
    return null;
  }

  whoami() {
    return request(`${this.state.relay_url}/agents/me`, { token: this.state.token });
  }
}

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith("--")) out[key] = true;
      else out[key] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const f = flags(rest);
  if (cmd === "pair") {
    await EarpieceRemote.pair({ code: f.code, kind: f.kind || "grokbot", name: f.name || "Avery", instance: f.instance, version: f.version || "1.0.0", relayUrl: process.env.EARPIECE_RELAY_URL });
    console.log("Connected to Earpiece. You'll see me in your notch.");
    return;
  }
  if (cmd === "whoami") {
    const ep = await EarpieceRemote.load();
    console.log(JSON.stringify(await ep.whoami()));
    return;
  }
  if (cmd === "emit") {
    const ep = await EarpieceRemote.load();
    const options = [];
    for (let i = 0; i < rest.length; i++) if (rest[i] === "--option" && rest[i + 1]) {
      const raw = rest[++i];
      const eq = raw.indexOf("=");
      if (eq > 0) options.push({ key: raw.slice(0, eq), label: raw.slice(eq + 1) });
    }
    const question = f.prompt ? { prompt: f.prompt, options, allow_text: f["allow-text"] === true } : undefined;
    try {
      const res = await ep.emit({ session_id: f.session, status: f.status, title: f.title, line: f.line, text: f.text, link: f.link, question, idempotency_key: f["idempotency-key"] });
      console.log(JSON.stringify(res));
    } catch (e) {
      if (e.status === 402) console.log(e.message);
      else throw e;
    }
    return;
  }
  if (cmd === "replies") {
    const ep = await EarpieceRemote.load();
    const replies = await ep.replies({ wait: Number(f.wait || 0) });
    console.log(JSON.stringify(replies));
    return;
  }
  console.error("usage: earpiece-remote.mjs pair|whoami|emit|replies");
  process.exitCode = 2;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) main(process.argv.slice(2)).catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
