import { createHash } from "node:crypto";

// Remote-agent frames, as pure data. Nothing here talks to the network or the filesystem:
// the relay, the Mac client and the tests all share these checks.
//
// A frame is untrusted until validateFrame() says otherwise. Hub events built from one
// carry a spoken line the bridge has already sanitized. They never carry the raw text.

export const LIMITS = {
  body: 8 * 1024,
  text: 2000,
  line: 200,
  title: 60,
  prompt: 300,
  label: 40,
  name: 32,
  session: 64,
  optionKey: 32,
  options: 3,
  idempotencyKey: 64,
  agents: 10,
  devices: 5,
  openQuestions: 20,
  sessionsShown: 50,
  eventsPerMin: 60,
  eventsBurst: 20,
  eventsPerDay: 2000,
  needsPerMin: 10,
  needsPerDay: 200,
  repliesPerMin: 60,
  pairingPerMin: 10,
  pairingFailures: 5,
  liveCodes: 3,
  codeTtlS: 10 * 60,
  streamS: 110,
  heartbeatS: 15,
  pollWaitS: 25,
  backlogFrames: 500,
  retentionH: 24,
  skewFutureMs: 10 * 60_000,
  skewPastMs: 24 * 3600_000,
  backlogSilentMs: 2 * 60_000,
  voiceCooldownMs: 30_000,
  replyRetryMs: 30_000,
  eventLru: 2000,
  remoteAsks: 10,
};

export const KINDS = ["grokbot", "dots", "openclaw", "hermes", "custom"];
export const SCOPES = ["events:write", "questions:write", "replies:read"];
export const STATUSES = ["working", "needs_you", "done", "error"];
export const SESSION_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
export const OPTION_KEY_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const IDEMPOTENCY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
export const AGENT_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

const EVENT_KEYS = new Set(["v", "session_id", "status", "title", "text", "line", "agent_name", "question", "occurred_at", "seq", "link", "enc"]);
const QUESTION_KEYS = new Set(["id", "prompt", "options", "allow_text", "expires_in_s"]);
const OPTION_KEYS = new Set(["key", "label", "style"]);
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

/** Local ingest must refuse these. The hub id is assigned at pairing, never chosen by a hook. */
export function reservedAgentId(id) {
  return String(id || "").startsWith("remote.");
}

export function hubId(kind, instance) {
  const k = String(kind || "custom");
  const inst = String(instance || "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 32);
  const id = inst ? `remote.${k}.${inst}` : `remote.${k}`;
  return AGENT_ID_RE.test(id) ? id : null;
}

const fail = (message) => ({ ok: false, error: message });

function str(v, max, field) {
  if (v == null) return { ok: true, value: undefined };
  if (typeof v !== "string") return fail(`${field} must be a string`);
  if (CONTROL.test(v)) return fail(`${field} contains a control character`);
  if ([...v].length > max) return fail(`${field} is longer than ${max} characters`);
  return { ok: true, value: v };
}

function unknown(obj, allowed, field) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return fail(`${field} must be an object`);
  for (const k of Object.keys(obj)) if (!allowed.has(k)) return fail(`${field}.${k} is not allowed`);
  return { ok: true };
}

/** Agent POST /agents/events body. Returns { ok, value } or { ok:false, error }. */
export function validateEvent(body, now = Date.now()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("body must be an object");
  const u = unknown(body, EVENT_KEYS, "body");
  if (!u.ok) return u;
  if (body.enc != null) return fail("enc is reserved");
  if (body.v != null && body.v !== 1) return fail("v must be 1");
  if (!SESSION_RE.test(String(body.session_id || ""))) return fail("session_id is invalid");
  if (!STATUSES.includes(body.status)) return fail("status is invalid");
  for (const [field, max] of [["title", LIMITS.title], ["text", LIMITS.text], ["line", LIMITS.line], ["agent_name", LIMITS.name]]) {
    const r = str(body[field], max, field);
    if (!r.ok) return r;
  }
  if (body.question != null && body.status !== "needs_you") return fail("question is only valid with needs_you");
  let question = null;
  if (body.question != null) {
    const q = body.question;
    const qu = unknown(q, QUESTION_KEYS, "question");
    if (!qu.ok) return qu;
    if (typeof q.prompt !== "string" || !q.prompt) return fail("question.prompt is required");
    const pr = str(q.prompt, LIMITS.prompt, "question.prompt");
    if (!pr.ok) return pr;
    if (q.id != null && !SESSION_RE.test(String(q.id))) return fail("question.id is invalid");
    const options = [];
    if (q.options != null) {
      if (!Array.isArray(q.options) || q.options.length > LIMITS.options) return fail("question.options is invalid");
      for (const o of q.options) {
        const ou = unknown(o, OPTION_KEYS, "question.options");
        if (!ou.ok) return ou;
        if (!OPTION_KEY_RE.test(String(o.key || ""))) return fail("question.options.key is invalid");
        const lab = str(o.label, LIMITS.label, "question.options.label");
        if (!lab.ok || !lab.value) return lab.ok ? fail("question.options.label is required") : lab;
        if (o.style != null && !["default", "primary", "danger"].includes(o.style)) return fail("question.options.style is invalid");
        options.push({ key: o.key, label: o.label, ...(o.style ? { style: o.style } : {}) });
      }
    }
    let expires = 86400;
    if (q.expires_in_s != null) {
      if (!Number.isInteger(q.expires_in_s) || q.expires_in_s < 60 || q.expires_in_s > 86400) return fail("question.expires_in_s is invalid");
      expires = q.expires_in_s;
    }
    question = {
      id: q.id || null,
      prompt: q.prompt,
      options,
      allow_text: q.allow_text === true,
      expires_in_s: expires,
    };
  }
  let occurred = null;
  if (body.occurred_at != null) {
    if (typeof body.occurred_at !== "string" || !Number.isFinite(Date.parse(body.occurred_at))) return fail("occurred_at is invalid");
    const t = Date.parse(body.occurred_at);
    if (t < now - LIMITS.skewPastMs) return fail("occurred_at is too old");
    occurred = new Date(Math.min(t, now + 0)).toISOString(); // future skew is clamped by the caller with received_at
    if (t > now + LIMITS.skewFutureMs) occurred = null; // signal clamp
  }
  if (body.seq != null && (!Number.isInteger(body.seq) || body.seq < 0)) return fail("seq is invalid");
  if (body.link != null) {
    const r = str(body.link, 500, "link");
    if (!r.ok) return r;
    if (!/^https:\/\//.test(body.link)) return fail("link must be https");
  }
  return {
    ok: true,
    value: {
      v: 1,
      session_id: body.session_id,
      status: body.status,
      title: body.title || null,
      text: body.text || null,
      line: body.line || null,
      agent_name: body.agent_name || null,
      question,
      occurred_at: body.occurred_at || null,
      occurred_clamped: occurred === null && body.occurred_at != null,
      seq: body.seq ?? null,
      link: body.link || null,
    },
  };
}

/**
 * A device-stream frame the Mac is about to apply. Drops unknown frames rather than throwing.
 * Questions are not rejected for ordering; only a missing id is.
 */
export function validateFrame(frame) {
  if (!frame || typeof frame !== "object") return fail("frame is invalid");
  const kind = frame.frame;
  if (kind === "event") {
    if (!frame.event_id || !frame.session_id || !STATUSES.includes(frame.status)) return fail("event frame is invalid");
    if (!frame.agent?.hub_id || !frame.agent?.agent_id || !KINDS.includes(frame.agent.kind)) return fail("event agent is invalid");
    if (reservedAgentId(frame.agent.hub_id) === false) return fail("event hub_id is invalid");
    return { ok: true, value: frame };
  }
  if (kind === "question_closed" || kind === "pairing" || kind === "agent_revoked" || kind === "plan_lapsed") return { ok: true, value: frame };
  return fail("unknown frame");
}

/** Apply a status only when it is not older than the last one on this session. Questions always pass. */
export function isNewer(frame, prev) {
  if (!prev) return true;
  if (frame.question) return true;
  if (frame.seq != null && prev.seq != null) return frame.seq >= prev.seq;
  const a = Date.parse(frame.occurred_at || frame.received_at || "");
  const b = Date.parse(prev.occurredAt || "");
  if (Number.isFinite(a) && Number.isFinite(b)) return a >= b;
  return true;
}

/**
 * Remote status → hub events. `spoken` is the already-sanitized sentence (name prefix included).
 * `prev.status === "working"` turns a second working update into a silent activity, not another start.
 */
export function toHubEvents(frame, prev, spoken) {
  const agent = frame.agent.hub_id;
  const session = frame.session_id;
  const project = frame.title || frame.agent.name || agent;
  const at = Date.parse(frame.received_at || "") || Date.now();
  const base = { agent, session, project, cwd: null, at };
  switch (frame.status) {
    case "working":
      return [prev?.status === "working" ? { ...base, type: "activity" } : { ...base, type: "turn_start" }];
    case "done":
      return [{ ...base, type: "turn_end", line: spoken }];
    case "needs_you":
      return [{ ...base, type: "needs_input", line: spoken, message: spoken }];
    case "error":
      return [{ ...base, type: "error", line: spoken }];
    default:
      return [];
  }
}

/** The ask the notch already knows how to render (questions → numbered choices). */
export function toAsk(frame, { line, text, prompt } = {}) {
  const name = frame.agent?.name || "Remote";
  const project = frame.title || name;
  const remote = {
    agentId: frame.agent.agent_id,
    kind: frame.agent.kind,
    link: frame.link || null,
    allowText: true,
  };
  const q = frame.question;
  if (!q) {
    return {
      kind: "reply",
      agent: frame.agent.hub_id,
      session: frame.session_id,
      project,
      line: line || prompt || `${name} needs you.`,
      detail: text || "",
      remote,
    };
  }
  let options = Array.isArray(q.options) ? q.options.slice(0, LIMITS.options) : [];
  if (!options.length && !q.allow_text) options = [{ key: "ok", label: "OK", style: "primary" }];
  return {
    kind: "permission",
    canAlways: false,
    agent: frame.agent.hub_id,
    session: frame.session_id,
    project,
    line: line || prompt || q.prompt,
    detail: text || "",
    questions: [{
      question: prompt || q.prompt,
      header: name,
      text: prompt || q.prompt,
      multiSelect: false,
      options: options.map((o) => ({ label: o.label, description: "", style: o.style || "default" })),
    }],
    remote: { ...remote, questionId: q.question_id, options, allowText: q.allow_text === true },
  };
}

/**
 * Map a notch answer back to a relay reply. `index` is 1-based, matching the key the user pressed.
 * A label that isn't one of the options is a free-text reply (the panel's Other box).
 */
export function answerToReply(ask, answer, { via = "notch" } = {}) {
  const remote = ask?.remote || {};
  if (!remote.agentId && !remote.questionId) return null;
  if (answer?.behavior === "choose") {
    const prompt = ask.questions?.[0]?.question;
    const label = String(answer.answers?.[prompt] ?? "").slice(0, LIMITS.text);
    const options = remote.options || [];
    const idx = options.findIndex((o) => o.label === label);
    if (idx >= 0) {
      const opt = options[idx];
      return { question_id: remote.questionId, choice_key: opt.key, text: null, choice: { key: opt.key, label: opt.label, index: idx + 1 }, via };
    }
    if (!label) return null;
    return { question_id: remote.questionId, choice_key: null, text: label, via };
  }
  const text = String(answer?.text ?? "").trim().slice(0, LIMITS.text);
  if (!text) return null;
  if (remote.questionId) return { question_id: remote.questionId, choice_key: null, text, via };
  return { agent_id: remote.agentId, session_id: ask.session, text, via };
}

/** sha256 hex prefix used as the default Idempotency-Key. The relay dedupes on it for 24 h. */
export function idempotencyKey({ session_id, status, question, line, text }) {
  const qid = question?.id || "";
  return createHash("sha256").update([session_id, status, qid, line || "", text || ""].join("|")).digest("hex").slice(0, 32);
}
