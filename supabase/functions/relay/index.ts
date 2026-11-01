// Earpiece relay. Agents POST events; the Mac holds an outbound stream and POSTs replies.
// verify_jwt is false: agent tokens are not Supabase JWTs, so this function checks auth itself.
// The Mac only connects out. Nothing here calls back to a laptop.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { qrSvg } from "./qr.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const VERSION = "1";
const DOCS = "https://earpiece.dev/docs/remote-agents#errors";
const KINDS = new Set(["grokbot", "dots", "openclaw", "hermes", "custom"]);
const SCOPES = ["events:write", "questions:write", "replies:read"];
const RESERVED = new Set(["claude", "claudecode", "codex", "earpiece", "system", "terminal", "macos"]);
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const proCache = new Map<string, { ok: boolean; at: number }>();
const deviceStreams = new Map<string, AbortController[]>();
const userStreams = new Map<string, number>();

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const err = (status: number, code: string, message: string, extra: { retry?: number } = {}) =>
  json(status, { error: { code, message, retry_after_s: extra.retry ?? null, docs: DOCS } }, extra.retry ? { "Retry-After": String(extra.retry) } : {});

const fid = (cursor: number) => `c_${String(cursor).padStart(12, "0")}`;
const parseCursor = (s: string | null) => {
  if (!s) return 0;
  const m = /^c_(\d+)$/.exec(s) || /^(\d+)$/.exec(s);
  return m ? Number(m[1]) : 0;
};

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function ulid(prefix: string) {
  const t = Date.now().toString(36).padStart(9, "0");
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let r = "";
  for (const b of bytes) r += CROCKFORD[b % 32];
  return prefix + t + r;
}

function pairingCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (const b of bytes) s += CROCKFORD[b % 32];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}`;
}

function liveToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(43));
  let s = "";
  for (const b of bytes) s += B62[b % 62];
  return `epa_live_${s}`;
}

const normalizeCode = (s: string) => String(s || "").toUpperCase().replace(/[^0-9A-Z]/g, "");

function nameSkeleton(name: string) {
  const map: Record<string, string> = { "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0441": "c", "\u0440": "p", "\u0445": "x", "\u0456": "i", "\u0443": "y" };
  let s = "";
  for (const ch of String(name || "").normalize("NFKC").toLowerCase()) {
    if (/[\s._-]/.test(ch)) continue;
    s += map[ch] || ch;
  }
  return s.replace(/[^a-z]/g, "");
}
const reservedName = (name: string) => RESERVED.has(nameSkeleton(name));

function routeOf(url: URL) {
  const i = url.pathname.indexOf("/v1");
  let path = i >= 0 ? url.pathname.slice(i) : url.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

async function isPro(uid: string) {
  const hit = proCache.get(uid);
  if (hit && Date.now() - hit.at < 60_000) return hit.ok;
  const { data } = await admin.rpc("is_pro", { uid });
  const ok = data === true;
  proCache.set(uid, { ok, at: Date.now() });
  return ok;
}

async function bumpUsage(uid: string, patch: Record<string, number>) {
  const day = new Date().toISOString().slice(0, 10);
  const { data } = await admin.from("remote_usage").select("*").eq("user_id", uid).eq("day", day).maybeSingle();
  const row = { user_id: uid, day, events: 0, questions: 0, replies: 0, http_402: 0, http_429: 0, ...(data || {}) };
  for (const [k, n] of Object.entries(patch)) row[k] = (Number(row[k]) || 0) + n;
  await admin.from("remote_usage").upsert(row);
}

async function rate(bucket: string, windowS: number, limit: number) {
  const { data, error } = await admin.rpc("remote_rate_hit", { p_bucket: bucket, p_window_s: windowS });
  if (error) return { ok: false, error };
  const n = Number(data);
  if (n > limit) return { ok: false, limited: true, retry: windowS };
  return { ok: true, n };
}

async function pushFrame(userId: string, frame: Record<string, unknown>) {
  const { count } = await admin.from("remote_frames").select("cursor", { count: "exact", head: true }).eq("user_id", userId);
  if ((count || 0) >= 500) {
    const drop = (count || 0) - 499;
    const { data: old } = await admin.from("remote_frames").select("cursor").eq("user_id", userId).order("cursor", { ascending: true }).limit(drop);
    if (old?.length) await admin.from("remote_frames").delete().in("cursor", old.map((r) => r.cursor));
  }
  const { data, error } = await admin.from("remote_frames").insert({ user_id: userId, frame }).select("cursor").single();
  if (error || !data) throw new Error(error?.message || "frame insert failed");
  return { cursor: data.cursor as number, id: fid(data.cursor as number) };
}

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
function badControl(v: unknown) {
  return typeof v === "string" && CONTROL.test(v);
}

function validateEvent(body: Record<string, unknown>, now = Date.now()) {
  const allowed = new Set(["v", "session_id", "status", "title", "text", "line", "agent_name", "question", "occurred_at", "seq", "link", "enc"]);
  for (const k of Object.keys(body)) if (!allowed.has(k)) return `body.${k} is not allowed`;
  if (body.enc != null) return "enc is reserved";
  if (body.v != null && body.v !== 1) return "v must be 1";
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(String(body.session_id || ""))) return "session_id is invalid";
  if (!["working", "needs_you", "done", "error"].includes(String(body.status))) return "status is invalid";
  for (const [field, max] of [["title", 60], ["text", 2000], ["line", 200], ["agent_name", 32]] as const) {
    const v = body[field];
    if (v == null) continue;
    if (typeof v !== "string") return `${field} must be a string`;
    if (badControl(v)) return `${field} contains a control character`;
    if ([...v].length > max) return `${field} is longer than ${max} characters`;
  }
  if (body.question != null && body.status !== "needs_you") return "question is only valid with needs_you";
  if (body.occurred_at != null) {
    const t = Date.parse(String(body.occurred_at));
    if (!Number.isFinite(t)) return "occurred_at is invalid";
    if (t < now - 24 * 3600_000) return "stale_event";
  }
  if (body.seq != null && (!Number.isInteger(body.seq) || (body.seq as number) < 0)) return "seq is invalid";
  if (body.link != null && (typeof body.link !== "string" || !body.link.startsWith("https://") || body.link.length > 500)) return "link must be https";
  const q = body.question as Record<string, unknown> | undefined;
  if (q) {
    if (typeof q.prompt !== "string" || !q.prompt || [...q.prompt].length > 300) return "question.prompt is invalid";
    if (badControl(q.prompt)) return "question.prompt contains a control character";
    if (q.id != null && !/^[A-Za-z0-9_.:-]{1,64}$/.test(String(q.id))) return "question.id is invalid";
    if (q.options != null) {
      if (!Array.isArray(q.options) || q.options.length > 3) return "question.options is invalid";
      for (const o of q.options as Record<string, unknown>[]) {
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(String(o.key || ""))) return "question.options.key is invalid";
        if (typeof o.label !== "string" || ![...o.label].length || [...o.label].length > 40) return "question.options.label is invalid";
        if (o.style != null && !["default", "primary", "danger"].includes(String(o.style))) return "question.options.style is invalid";
      }
    }
    if (q.expires_in_s != null && (!Number.isInteger(q.expires_in_s) || (q.expires_in_s as number) < 60 || (q.expires_in_s as number) > 86400)) return "question.expires_in_s is invalid";
  }
  return null;
}

function canon(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
}

async function readJson(req: Request) {
  const raw = await req.text();
  if (raw.length > 8192) return { error: err(413, "payload_too_large", "Body is larger than 8 KB.") };
  if (!raw) return { body: {} as Record<string, unknown> };
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) return { error: err(400, "invalid_request", "Body must be an object.") };
    return { body: body as Record<string, unknown>, raw };
  } catch {
    return { error: err(400, "invalid_request", "Body must be JSON.") };
  }
}

async function userFromJwt(req: Request) {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data.user) return null;
  return data.user;
}

async function agentFromReq(req: Request) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token.startsWith("epa_live_") && !token.startsWith("epa_test_")) return { error: err(401, "invalid_token", "That token is not an Earpiece agent token.") };
  const hash = await sha256(token);
  const { data } = await admin.from("remote_tokens").select("*").eq("token_hash", hash).maybeSingle();
  if (!data) return { error: err(401, "invalid_token", "Unknown agent token.") };
  if (data.revoked_at) return { error: err(401, "token_revoked", "This token was revoked.") };
  if (data.expires_at && Date.parse(data.expires_at) < Date.now()) return { error: err(401, "token_expired", "This token has expired.") };
  const { data: agent } = await admin.from("remote_agents").select("*").eq("id", data.agent_id).maybeSingle();
  if (!agent || agent.status !== "active") return { error: err(401, "token_revoked", "This agent was revoked.") };
  await admin.from("remote_agents").update({ last_used_at: new Date().toISOString() }).eq("id", agent.id);
  return { agent, tokenRow: data };
}

function scopesOf(agent: { scopes: string[] }) {
  return new Set(agent.scopes || []);
}

async function supersedeOpen(agent: { id: string; user_id: string }, sessionId: string, reason = "superseded") {
  const { data: open } = await admin.from("remote_questions").select("*").eq("agent_id", agent.id).eq("session_id", sessionId).eq("status", "open");
  for (const q of open || []) {
    await admin.from("remote_questions").update({ status: reason === "expired" ? "expired" : "superseded" }).eq("id", q.id);
    const replyId = ulid("rpl_");
    await admin.from("remote_replies").insert({
      id: replyId,
      agent_id: agent.id,
      question_id: q.id,
      reply: {
        reply_id: replyId,
        type: reason === "expired" ? "expired" : "superseded",
        question_id: q.id,
        agent_question_id: q.agent_question_id,
        session_id: sessionId,
        choice: null,
        text: null,
      },
    });
    await pushFrame(agent.user_id, { frame: "question_closed", question_id: q.id, reason });
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = routeOf(url);
  const method = req.method;
  if (method === "GET" && path === "/v1/health") return json(200, { ok: true, version: VERSION });

  try {
    if (method === "POST" && path === "/v1/devices") return await postDevice(req);
    if (method === "POST" && path === "/v1/pairing/codes") return await postCode(req);
    if (method === "POST" && path === "/v1/pairing/claim") return await postClaim(req);
    const claim = /^\/v1\/pairing\/claims\/([^/]+)(?:\/(approve|deny))?$/.exec(path);
    if (claim && method === "GET") return await getClaim(req, decodeURIComponent(claim[1]), url);
    if (claim && method === "POST" && claim[2] === "approve") return await approveClaim(req, decodeURIComponent(claim[1]));
    if (claim && method === "POST" && claim[2] === "deny") return await denyClaim(req, decodeURIComponent(claim[1]));
    if (method === "POST" && path === "/v1/agents/events") return await postEvent(req);
    if (method === "GET" && path === "/v1/agents/replies") return await getReplies(req, url);
    if (method === "POST" && path === "/v1/agents/replies/ack") return await ackReplies(req);
    if (method === "GET" && path === "/v1/agents/me") return await agentMe(req);
    if (method === "DELETE" && path === "/v1/agents/token") return await deleteOwnToken(req);
    if (method === "POST" && path === "/v1/agents/token/rotate") return await rotateOwnToken(req);
    if (method === "GET" && path === "/v1/device/stream") return await deviceStream(req);
    if (method === "GET" && path === "/v1/device/events") return await devicePoll(req, url);
    if (method === "POST" && path === "/v1/device/ack") return await deviceAck(req);
    if (method === "POST" && path === "/v1/device/replies") return await deviceReply(req);
    if (method === "GET" && path === "/v1/device/open-questions") return await openQuestions(req);
    if (method === "GET" && path === "/v1/device/agents") return await listAgents(req);
    const agentPath = /^\/v1\/device\/agents\/([^/]+)(?:\/(rotate|test))?$/.exec(path);
    if (agentPath && method === "PATCH") return await patchAgent(req, decodeURIComponent(agentPath[1]));
    if (agentPath && method === "DELETE") return await deleteAgent(req, decodeURIComponent(agentPath[1]));
    if (agentPath && method === "POST" && agentPath[2] === "rotate") return await forceRotate(req, decodeURIComponent(agentPath[1]));
    if (agentPath && method === "POST" && agentPath[2] === "test") return await testAgent(req, decodeURIComponent(agentPath[1]));
    if (method === "GET" && path === "/v1/device/devices") return await listDevices(req);
    const dev = /^\/v1\/device\/devices\/([^/]+)$/.exec(path);
    if (dev && method === "DELETE") return await deleteDevice(req, decodeURIComponent(dev[1]));
    return err(404, "not_found", "Unknown route.");
  } catch (e) {
    console.error(String(e));
    return err(503, "unavailable", "The relay is unavailable. Retry shortly.");
  }
});

async function requireDevice(req: Request, { pro = true } = {}) {
  const user = await userFromJwt(req);
  if (!user) return { error: err(401, "invalid_token", "Sign in to Earpiece first.") };
  const ok = await isPro(user.id);
  if (pro && !ok) {
    await bumpUsage(user.id, { http_402: 1 });
    return { error: err(402, "pro_required", "Remote agents need Earpiece Pro.") };
  }
  const deviceId = req.headers.get("X-Earpiece-Device");
  return { user, pro: ok, deviceId };
}

async function ownDevice(userId: string, deviceId: string | null) {
  if (!deviceId) return { error: err(400, "invalid_request", "X-Earpiece-Device is required.") };
  const { data } = await admin.from("remote_devices").select("*").eq("id", deviceId).eq("user_id", userId).maybeSingle();
  if (!data) return { error: err(404, "not_found", "Unknown device.") };
  await admin.from("remote_devices").update({ last_seen_at: new Date().toISOString() }).eq("id", deviceId);
  return { device: data };
}

async function postDevice(req: Request) {
  const gate = await requireDevice(req);
  if (gate.error) return gate.error;
  const read = await readJson(req);
  if (read.error) return read.error;
  const name = String(read.body.name || "Mac").slice(0, 64);
  const platform = String(read.body.platform || "macos").slice(0, 32);
  const { count } = await admin.from("remote_devices").select("id", { count: "exact", head: true }).eq("user_id", gate.user!.id);
  if ((count || 0) >= 5) return err(409, "limit_reached", "This account already has 5 devices.");
  const id = ulid("dev_");
  const { error } = await admin.from("remote_devices").insert({
    id,
    user_id: gate.user!.id,
    name,
    platform,
    app_version: String(read.body.app_version || "").slice(0, 32) || null,
  });
  if (error) return err(503, "unavailable", "Could not register the device.");
  return json(201, { device_id: id });
}

async function postCode(req: Request) {
  const gate = await requireDevice(req);
  if (gate.error) return gate.error;
  const owned = await ownDevice(gate.user!.id, gate.deviceId || null);
  if (owned.error) return owned.error;
  const read = await readJson(req);
  if (read.error) return read.error;
  const { count } = await admin.from("remote_pairings").select("id", { count: "exact", head: true }).eq("user_id", gate.user!.id).eq("status", "open").gt("expires_at", new Date().toISOString());
  if ((count || 0) >= 3) return err(409, "limit_reached", "You already have 3 live pairing codes.");
  const code = pairingCode();
  const id = ulid("pair_");
  const expires = new Date(Date.now() + 10 * 60_000).toISOString();
  const { error } = await admin.from("remote_pairings").insert({
    id,
    user_id: gate.user!.id,
    device_id: owned.device!.id,
    code_hash: await sha256(normalizeCode(code)),
    expires_at: expires,
    status: "open",
    claim: { label_hint: String(read.body.label_hint || "").slice(0, 32) },
  });
  if (error) return err(503, "unavailable", "Could not create a pairing code.");
  const bare = normalizeCode(code);
  const link = `https://earpiece.dev/pair#${bare}`;
  let qr: { svg: string; modules: string };
  try {
    qr = qrSvg(link);
  } catch {
    qr = { svg: "", modules: "" };
  }
  return json(201, { pairing_id: id, code, expires_at: expires, qr_url: link, qr_svg: qr.svg, qr_modules: qr.modules, relay_url: publicRelay(req) });
}

function publicRelay(req: Request) {
  const env = Deno.env.get("EARPIECE_RELAY_URL");
  if (env) return env.replace(/\/$/, "");
  const u = new URL(req.url);
  return `${u.origin}/functions/v1/relay/v1`;
}

async function postClaim(req: Request) {
  const ip = (req.headers.get("x-forwarded-for") || "0").split(",")[0].trim() || "0";
  const limited = await rate(`claim:${ip}`, 60, 10);
  if (limited.limited) return err(429, "rate_limited", "Too many pairing attempts.", { retry: 60 });
  const read = await readJson(req);
  if (read.error) return read.error;
  const code = normalizeCode(String(read.body.code || ""));
  if (code.length !== 8) return err(410, "code_expired", "That pairing code is not valid.");
  const hash = await sha256(code);
  const { data: pairing } = await admin.from("remote_pairings").select("*").eq("code_hash", hash).maybeSingle();
  if (!pairing || pairing.status !== "open" || Date.parse(pairing.expires_at) < Date.now()) {
    if (pairing?.user_id) await burn(pairing.user_id);
    return err(410, "code_expired", "That pairing code is not valid.");
  }
  const agent = (read.body.agent || {}) as Record<string, unknown>;
  if (!KINDS.has(String(agent.kind))) return err(400, "invalid_request", "agent.kind is invalid");
  const name = String(agent.name || "");
  if (name.length < 1 || [...name].length > 32) return err(400, "invalid_request", "agent.name is invalid");
  if (reservedName(name)) return err(400, "reserved_agent_id", "That name is reserved.");
  const requested = Array.isArray(read.body.requested_scopes) ? (read.body.requested_scopes as string[]).filter((s) => SCOPES.includes(s)) : [...SCOPES];
  const claimId = ulid("clm_");
  const secret = `cls_${liveToken().slice("epa_live_".length)}`;
  const claim = { kind: agent.kind, name, instance: agent.instance || null, version: String(agent.version || "").slice(0, 32), homepage: String(agent.homepage || "").slice(0, 200), requested_scopes: requested };
  const { error } = await admin.from("remote_pairings").update({
    status: "claimed",
    claim_id: claimId,
    claim_secret_hash: await sha256(secret),
    claim,
  }).eq("id", pairing.id).eq("status", "open");
  if (error) return err(410, "code_expired", "That pairing code was already used.");
  await pushFrame(pairing.user_id, { frame: "pairing", claim_id: claimId, agent: claim, requested_scopes: requested, expires_at: pairing.expires_at });
  return json(202, { claim_id: claimId, claim_secret: secret, status: "pending", poll_after_s: 2, expires_at: pairing.expires_at });
}

async function burn(userId: string) {
  const { data } = await admin.from("remote_pairings").select("id, failures").eq("user_id", userId).in("status", ["open", "claimed"]);
  const fails = (data || []).reduce((n, r) => n + (r.failures || 0), 0) + 1;
  if (fails >= 5) {
    await admin.from("remote_pairings").update({ status: "expired", expires_at: new Date().toISOString() }).eq("user_id", userId).in("status", ["open", "claimed"]);
    return;
  }
  if (data?.[0]) await admin.from("remote_pairings").update({ failures: (data[0].failures || 0) + 1 }).eq("id", data[0].id);
}

async function getClaim(req: Request, claimId: string, url: URL) {
  const secret = req.headers.get("X-Claim-Secret") || "";
  const { data: pairing } = await admin.from("remote_pairings").select("*").eq("claim_id", claimId).maybeSingle();
  if (!pairing || (await sha256(secret)) !== pairing.claim_secret_hash) return err(404, "not_found", "Unknown claim.");
  const wait = Math.min(25, Math.max(0, Number(url.searchParams.get("wait") || 0)));
  const deadline = Date.now() + wait * 1000;
  let row = pairing;
  while (row.status === "claimed" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const { data } = await admin.from("remote_pairings").select("*").eq("id", pairing.id).maybeSingle();
    if (!data) return err(410, "code_expired", "That pairing code has expired.");
    row = data;
  }
  if (row.status === "denied") return json(200, { status: "denied" });
  if (row.status !== "approved") return json(200, { status: "pending" });
  const token = row.claim?.token_once;
  if (!token) return err(410, "code_expired", "That claim was already collected.");
  await admin.from("remote_pairings").delete().eq("id", row.id);
  return json(200, {
    status: "approved",
    agent_id: row.agent_id,
    token,
    token_expires_at: null,
    scopes: row.claim?.scopes || row.claim?.requested_scopes || SCOPES,
    relay_url: publicRelay(req),
  });
}

async function approveClaim(req: Request, claimId: string) {
  const gate = await requireDevice(req);
  if (gate.error) return gate.error;
  const read = await readJson(req);
  if (read.error) return read.error;
  const { data: pairing } = await admin.from("remote_pairings").select("*").eq("claim_id", claimId).eq("user_id", gate.user!.id).maybeSingle();
  if (!pairing || pairing.status !== "claimed") return err(404, "not_found", "Unknown claim.");
  if (Date.parse(pairing.expires_at) < Date.now()) return err(410, "code_expired", "That pairing code has expired.");
  const requested: string[] = pairing.claim?.requested_scopes || [...SCOPES];
  const scopes = Array.isArray(read.body.scopes) ? (read.body.scopes as string[]).filter((s) => requested.includes(s)) : requested;
  if (!scopes.length) return err(400, "invalid_request", "scopes must keep at least one requested scope");
  const display = String(read.body.display_name || pairing.claim?.name || "Remote").slice(0, 32);
  if (reservedName(display)) return err(400, "reserved_agent_id", "That name is reserved.");
  const { count } = await admin.from("remote_agents").select("id", { count: "exact", head: true }).eq("user_id", gate.user!.id).eq("status", "active");
  if ((count || 0) >= 10) return err(409, "limit_reached", "This account already has 10 remote agents.");
  let hub = `remote.${pairing.claim.kind}`;
  const instance = String(pairing.claim.instance || "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 32);
  if (instance) hub = `${hub}.${instance}`;
  const { data: clash } = await admin.from("remote_agents").select("id").eq("user_id", gate.user!.id).eq("hub_id", hub).maybeSingle();
  if (clash) hub = `${hub}.${ulid("").slice(-4).toLowerCase()}`;
  const agentId = ulid("agt_");
  const token = liveToken();
  const { error } = await admin.from("remote_agents").insert({
    id: agentId,
    user_id: gate.user!.id,
    kind: pairing.claim.kind,
    name: display,
    instance: instance || null,
    hub_id: hub,
    scopes,
  });
  if (error) return err(409, "limit_reached", "Could not pair that agent.");
  await admin.from("remote_tokens").insert({ token_hash: await sha256(token), agent_id: agentId, prefix: token.slice(0, 13) });
  await admin.from("remote_pairings").update({
    status: "approved",
    agent_id: agentId,
    claim: { ...pairing.claim, scopes, token_once: token, display_name: display, hub_id: hub },
  }).eq("id", pairing.id);
  return json(200, { agent_id: agentId, hub_id: hub, name: display });
}

async function denyClaim(req: Request, claimId: string) {
  const gate = await requireDevice(req);
  if (gate.error) return gate.error;
  const { data } = await admin.from("remote_pairings").select("id, status").eq("claim_id", claimId).eq("user_id", gate.user!.id).maybeSingle();
  if (!data) return err(404, "not_found", "Unknown claim.");
  await admin.from("remote_pairings").update({ status: "denied" }).eq("id", data.id);
  return new Response(null, { status: 204 });
}

async function postEvent(req: Request) {
  const auth = await agentFromReq(req);
  if (auth.error) return auth.error;
  const agent = auth.agent!;
  const key = req.headers.get("Idempotency-Key") || "";
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(key)) return err(400, "invalid_request", "Idempotency-Key is required.");
  const pro = await isPro(agent.user_id);
  if (!pro) {
    await bumpUsage(agent.user_id, { http_402: 1 });
    return err(402, "pro_required", "Remote agents need Earpiece Pro.");
  }
  const read = await readJson(req);
  if (read.error) return read.error;
  const problem = validateEvent(read.body);
  if (problem === "stale_event") return err(400, "stale_event", "occurred_at is too old");
  if (problem) return err(400, "invalid_request", problem);
  const scopes = scopesOf(agent);
  if (read.body.status === "needs_you" && !scopes.has("questions:write")) return err(403, "scope_missing", "This agent cannot ask questions.");
  if (read.body.status !== "needs_you" && !scopes.has("events:write")) return err(403, "scope_missing", "This agent cannot post updates.");
  const minute = await rate(`ev:${agent.id}:m`, 60, 60);
  const burst = await rate(`ev:${agent.id}:b`, 10, 20);
  const day = new Date().toISOString().slice(0, 10);
  const daily = await rate(`ev:${agent.id}:d:${day}`, 86400, 2000);
  if (minute.limited || burst.limited || daily.limited) {
    await bumpUsage(agent.user_id, { http_429: 1 });
    return err(429, "rate_limited", "Too many events.", { retry: 60 });
  }
  if (read.body.status === "needs_you") {
    const qmin = await rate(`q:${agent.id}:m`, 60, 10);
    const qday = await rate(`q:${agent.id}:d:${day}`, 86400, 200);
    if (qmin.limited || qday.limited) return err(429, "rate_limited", "Too many questions.", { retry: 60 });
  }
  const bodyHash = await sha256(canon(read.body));
  const { data: prev } = await admin.from("remote_events").select("*").eq("agent_id", agent.id).eq("idempotency_key", key).maybeSingle();
  if (prev) {
    if (prev.body_hash !== bodyHash) return err(409, "idempotency_conflict", "That Idempotency-Key was used with a different body.");
    return json(202, { ...(prev.frame?.response || {}), duplicate: true });
  }
  let occurred = read.body.occurred_at ? new Date(String(read.body.occurred_at)).toISOString() : new Date().toISOString();
  if (read.body.occurred_at && Date.parse(String(read.body.occurred_at)) > Date.now() + 10 * 60_000) occurred = new Date().toISOString();
  await supersedeOpen(agent, String(read.body.session_id));
  let questionId: string | null = null;
  if (read.body.status === "needs_you" && read.body.question) {
    const { count } = await admin.from("remote_questions").select("id", { count: "exact", head: true }).eq("agent_id", agent.id).eq("status", "open");
    if ((count || 0) >= 20) {
      const { data: oldest } = await admin.from("remote_questions").select("*").eq("agent_id", agent.id).eq("status", "open").order("created_at").limit(1).maybeSingle();
      if (oldest) await supersedeOpen({ id: agent.id, user_id: agent.user_id }, oldest.session_id);
    }
    const q = read.body.question as Record<string, unknown>;
    questionId = ulid("q_");
    const expiresIn = Number(q.expires_in_s || 86400);
    await admin.from("remote_questions").insert({
      id: questionId,
      user_id: agent.user_id,
      agent_id: agent.id,
      session_id: read.body.session_id,
      agent_question_id: q.id || null,
      options: q.options || [],
      allow_text: q.allow_text === true,
      prompt: q.prompt,
      expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    });
  } else if (read.body.status !== "needs_you") {
    /* supersedeOpen already closed questions on this session */
  }
  const eventId = ulid("evt_");
  const received = new Date().toISOString();
  const frame = {
    frame: "event",
    event_id: eventId,
    agent: { agent_id: agent.id, hub_id: agent.hub_id, name: agent.name, kind: agent.kind },
    session_id: read.body.session_id,
    status: read.body.status,
    title: read.body.title || null,
    line: read.body.line || null,
    text: read.body.text || null,
    agent_name: read.body.agent_name || null,
    question: questionId
      ? {
          question_id: questionId,
          id: (read.body.question as Record<string, unknown>)?.id || null,
          prompt: (read.body.question as Record<string, unknown>).prompt,
          options: (read.body.question as Record<string, unknown>).options || [],
          allow_text: (read.body.question as Record<string, unknown>).allow_text === true,
          expires_at: new Date(Date.now() + Number((read.body.question as Record<string, unknown>).expires_in_s || 86400) * 1000).toISOString(),
        }
      : null,
    link: read.body.link || null,
    occurred_at: occurred,
    received_at: received,
    seq: read.body.seq ?? null,
  };
  const pushed = await pushFrame(agent.user_id, frame);
  const response = {
    event_id: eventId,
    session_id: read.body.session_id,
    accepted_at: received,
    delivered: (userStreams.get(agent.user_id) || 0) > 0,
    question_id: questionId,
    agent_question_id: questionId ? (read.body.question as Record<string, unknown>)?.id || null : null,
    duplicate: false,
  };
  await admin.from("remote_events").insert({
    user_id: agent.user_id,
    agent_id: agent.id,
    event_id: eventId,
    idempotency_key: key,
    body_hash: bodyHash,
    frame: { ...frame, response },
    frame_cursor: pushed.cursor,
    received_at: received,
  });
  await bumpUsage(agent.user_id, { events: 1, ...(questionId ? { questions: 1 } : {}) });
  return json(202, response);
}

async function framesAfter(userId: string, cursor: number) {
  const { data } = await admin.from("remote_frames").select("cursor, frame").eq("user_id", userId).gt("cursor", cursor).order("cursor").limit(50);
  return data || [];
}

async function deviceStream(req: Request) {
  const gate = await requireDevice(req);
  if (gate.error) return gate.error;
  const owned = await ownDevice(gate.user!.id, gate.deviceId || null);
  if (owned.error) return owned.error;
  const ctrl = new AbortController();
  const list = deviceStreams.get(owned.device!.id) || [];
  list.push(ctrl);
  while (list.length > 3) list.shift()?.abort();
  deviceStreams.set(owned.device!.id, list);
  userStreams.set(gate.user!.id, (userStreams.get(gate.user!.id) || 0) + 1);
  const encoder = new TextEncoder();
  let cursor = parseCursor(req.headers.get("Last-Event-ID"));
  const stream = new ReadableStream({
    async start(controller) {
      const send = (s: string) => {
        try {
          controller.enqueue(encoder.encode(s));
        } catch {}
      };
      const started = Date.now();
      let lastHb = Date.now();
      try {
        while (Date.now() - started < 110_000 && !ctrl.signal.aborted && !req.signal.aborted) {
          if (Date.now() - lastHb >= 15_000) {
            send(": hb\n\n");
            lastHb = Date.now();
          }
          if (!(await isPro(gate.user!.id))) {
            send(`event: remote\ndata: ${JSON.stringify({ frame: "plan_lapsed" })}\n\n`);
            break;
          }
          const rows = await framesAfter(gate.user!.id, cursor);
          for (const row of rows) {
            send(`id: ${fid(row.cursor)}\nevent: remote\ndata: ${JSON.stringify(row.frame)}\n\n`);
            cursor = row.cursor;
          }
          await new Promise((r) => setTimeout(r, rows.length ? 200 : 1000));
        }
        send(`event: bye\ndata: ${JSON.stringify({ resume: fid(cursor) })}\n\n`);
      } finally {
        const left = (deviceStreams.get(owned.device!.id) || []).filter((c) => c !== ctrl);
        if (left.length) deviceStreams.set(owned.device!.id, left);
        else deviceStreams.delete(owned.device!.id);
        const n = (userStreams.get(gate.user!.id) || 1) - 1;
        if (n > 0) userStreams.set(gate.user!.id, n);
        else userStreams.delete(gate.user!.id);
        try {
          controller.close();
        } catch {}
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

async function devicePoll(req: Request, url: URL) {
  const gate = await requireDevice(req);
  if (gate.error) return gate.error;
  const owned = await ownDevice(gate.user!.id, gate.deviceId || null);
  if (owned.error) return owned.error;
  const wait = Math.min(25, Math.max(0, Number(url.searchParams.get("wait") || 0)));
  let cursor = parseCursor(url.searchParams.get("cursor"));
  const deadline = Date.now() + wait * 1000;
  let rows = await framesAfter(gate.user!.id, cursor);
  while (!rows.length && Date.now() < deadline) {
    if (!(await isPro(gate.user!.id))) return json(200, { frames: [{ id: fid(cursor), data: { frame: "plan_lapsed" } }], next_cursor: fid(cursor) });
    await new Promise((r) => setTimeout(r, 1000));
    rows = await framesAfter(gate.user!.id, cursor);
  }
  const frames = rows.map((row) => ({ id: fid(row.cursor), data: row.frame }));
  const next = rows.length ? fid(rows[rows.length - 1].cursor) : fid(cursor);
  return json(200, { frames, next_cursor: next });
}

async function deviceAck(req: Request) {
  const gate = await requireDevice(req);
  if (gate.error) return gate.error;
  const owned = await ownDevice(gate.user!.id, gate.deviceId || null);
  if (owned.error) return owned.error;
  const read = await readJson(req);
  if (read.error) return read.error;
  const cursor = parseCursor(String(read.body.cursor || ""));
  await admin.from("remote_devices").update({ ack_cursor: cursor }).eq("id", owned.device!.id);
  return new Response(null, { status: 204 });
}

async function deviceReply(req: Request) {
  const gate = await requireDevice(req);
  if (gate.error) return gate.error;
  const owned = await ownDevice(gate.user!.id, gate.deviceId || null);
  if (owned.error) return owned.error;
  const read = await readJson(req);
  if (read.error) return read.error;
  const clientId = String(read.body.client_reply_id || "");
  if (clientId) {
    const { data: dup } = await admin.from("remote_replies").select("id").eq("client_reply_id", clientId).maybeSingle();
    if (dup) return json(201, { reply_id: dup.id });
  }
  if (read.body.question_id) {
    const { data: q } = await admin.from("remote_questions").select("*").eq("id", read.body.question_id).eq("user_id", gate.user!.id).maybeSingle();
    if (!q) return err(404, "not_found", "Unknown question.");
    if (q.status === "answered") return err(409, "already_answered", "Already answered on another device.");
    if (q.status !== "open" || Date.parse(q.expires_at) < Date.now()) return err(410, "question_expired", "That question has expired.");
    const options = (q.options || []) as { key: string; label: string }[];
    const key = read.body.choice_key == null ? null : String(read.body.choice_key);
    const idx = key == null ? -1 : options.findIndex((o) => o.key === key);
    if (key && idx < 0) return err(400, "invalid_request", "choice_key is not one of the options");
    const text = read.body.text == null ? null : String(read.body.text).slice(0, 2000);
    if (!key && !text) return err(400, "invalid_request", "A reply needs a choice or text.");
    const replyId = ulid("rpl_");
    const reply = {
      reply_id: replyId,
      type: key ? "answer" : "text",
      question_id: q.id,
      agent_question_id: q.agent_question_id,
      session_id: q.session_id,
      choice: idx >= 0 ? { key, label: options[idx].label, index: idx + 1 } : null,
      text,
      answered_at: new Date().toISOString(),
      answered_via: ["notch", "panel", "cli"].includes(String(read.body.via)) ? read.body.via : "notch",
      device: { id: owned.device!.id, name: owned.device!.name },
    };
    const { error } = await admin.from("remote_replies").insert({ id: replyId, agent_id: q.agent_id, question_id: q.id, client_reply_id: clientId || null, reply });
    if (error) return err(409, "already_answered", "Already answered on another device.");
    await admin.from("remote_questions").update({ status: "answered" }).eq("id", q.id).eq("status", "open");
    await pushFrame(gate.user!.id, { frame: "question_closed", question_id: q.id, reason: "answered_elsewhere" });
    await bumpUsage(gate.user!.id, { replies: 1 });
    return json(201, { reply_id: replyId });
  }
  const agentId = String(read.body.agent_id || "");
  const text = String(read.body.text || "").slice(0, 2000);
  if (!agentId || !text) return err(400, "invalid_request", "A reply needs question_id or agent_id and text.");
  const { data: agent } = await admin.from("remote_agents").select("*").eq("id", agentId).eq("user_id", gate.user!.id).maybeSingle();
  if (!agent) return err(404, "not_found", "Unknown agent.");
  const replyId = ulid("rpl_");
  await admin.from("remote_replies").insert({
    id: replyId,
    agent_id: agent.id,
    client_reply_id: clientId || null,
    reply: {
      reply_id: replyId,
      type: "text",
      question_id: null,
      session_id: read.body.session_id || null,
      choice: null,
      text,
      answered_at: new Date().toISOString(),
      answered_via: read.body.via || "notch",
      device: { id: owned.device!.id, name: owned.device!.name },
    },
  });
  await bumpUsage(gate.user!.id, { replies: 1 });
  return json(201, { reply_id: replyId });
}

async function openQuestions(req: Request) {
  const gate = await requireDevice(req);
  if (gate.error) return gate.error;
  const { data } = await admin.from("remote_questions").select("*").eq("user_id", gate.user!.id).eq("status", "open");
  const questions = [];
  for (const q of data || []) {
    const { data: agent } = await admin.from("remote_agents").select("id, hub_id, name, kind").eq("id", q.agent_id).maybeSingle();
    if (!agent) continue;
    questions.push({
      question_id: q.id,
      agent: { agent_id: agent.id, hub_id: agent.hub_id, name: agent.name, kind: agent.kind },
      session_id: q.session_id,
      prompt: q.prompt,
      options: q.options,
      allow_text: q.allow_text,
      expires_at: q.expires_at,
      title: agent.name,
      line: q.prompt,
    });
  }
  return json(200, { questions });
}

async function listAgents(req: Request) {
  const gate = await requireDevice(req);
  if (gate.error) return gate.error;
  const { data } = await admin.from("remote_agents").select("*").eq("user_id", gate.user!.id).eq("status", "active").order("created_at");
  const agents = [];
  for (const a of data || []) {
    const { data: tok } = await admin.from("remote_tokens").select("prefix").eq("agent_id", a.id).is("revoked_at", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const { count } = await admin.from("remote_events").select("event_id", { count: "exact", head: true }).eq("agent_id", a.id).gt("received_at", since);
    agents.push({
      agent_id: a.id,
      name: a.name,
      kind: a.kind,
      hub_id: a.hub_id,
      scopes: a.scopes,
      token_prefix: tok?.prefix || null,
      created_at: a.created_at,
      last_used_at: a.last_used_at,
      events_24h: count || 0,
      status: a.status,
    });
  }
  return json(200, { agents });
}

async function patchAgent(req: Request, id: string) {
  const gate = await requireDevice(req);
  if (gate.error) return gate.error;
  const read = await readJson(req);
  if (read.error) return read.error;
  const { data: agent } = await admin.from("remote_agents").select("*").eq("id", id).eq("user_id", gate.user!.id).maybeSingle();
  if (!agent) return err(404, "not_found", "Unknown agent.");
  const patch: Record<string, unknown> = {};
  if (read.body.name != null) {
    const name = String(read.body.name).slice(0, 32);
    if (reservedName(name)) return err(400, "reserved_agent_id", "That name is reserved.");
    patch.name = name;
  }
  if (read.body.scopes != null) {
    const next = (read.body.scopes as string[]).filter((s) => SCOPES.includes(s));
    if (next.some((s) => !(agent.scopes || []).includes(s))) return err(403, "scope_missing", "Scopes can be narrowed, not widened.");
    patch.scopes = next;
  }
  await admin.from("remote_agents").update(patch).eq("id", id);
  return json(200, { agent_id: id, hub_id: agent.hub_id, ...patch });
}

async function deleteAgent(req: Request, id: string) {
  const gate = await requireDevice(req);
  if (gate.error) return gate.error;
  const { data: agent } = await admin.from("remote_agents").select("*").eq("id", id).eq("user_id", gate.user!.id).maybeSingle();
  if (!agent) return err(404, "not_found", "Unknown agent.");
  const now = new Date().toISOString();
  await admin.from("remote_tokens").update({ revoked_at: now }).eq("agent_id", id);
  await admin.from("remote_agents").update({ status: "revoked", revoked_at: now }).eq("id", id);
  await admin.from("remote_questions").update({ status: "revoked" }).eq("agent_id", id).eq("status", "open");
  await admin.from("remote_events").delete().eq("agent_id", id);
  await admin.from("remote_replies").delete().eq("agent_id", id);
  await pushFrame(gate.user!.id, { frame: "agent_revoked", agent_id: id, hub_id: agent.hub_id });
  return new Response(null, { status: 204 });
}

async function forceRotate(req: Request, id: string) {
  const gate = await requireDevice(req);
  if (gate.error) return gate.error;
  const { data: agent } = await admin.from("remote_agents").select("id").eq("id", id).eq("user_id", gate.user!.id).maybeSingle();
  if (!agent) return err(404, "not_found", "Unknown agent.");
  await admin.from("remote_tokens").update({ revoked_at: new Date().toISOString() }).eq("agent_id", id);
  return json(200, { rotated: true });
}

async function testAgent(req: Request, id: string) {
  const gate = await requireDevice(req);
  if (gate.error) return gate.error;
  const { data: agent } = await admin.from("remote_agents").select("*").eq("id", id).eq("user_id", gate.user!.id).eq("status", "active").maybeSingle();
  if (!agent) return err(404, "not_found", "Unknown agent.");
  const eventId = ulid("evt_");
  const received = new Date().toISOString();
  const frame = {
    frame: "event",
    event_id: eventId,
    agent: { agent_id: agent.id, hub_id: agent.hub_id, name: agent.name, kind: agent.kind },
    session_id: "earpiece-test",
    status: "done",
    title: "Earpiece test",
    line: `${agent.name} is connected.`,
    text: null,
    question: null,
    occurred_at: received,
    received_at: received,
    seq: null,
  };
  const pushed = await pushFrame(gate.user!.id, frame);
  await admin.from("remote_events").insert({
    user_id: gate.user!.id,
    agent_id: agent.id,
    event_id: eventId,
    idempotency_key: `test-${eventId}`,
    body_hash: await sha256(eventId),
    frame,
    frame_cursor: pushed.cursor,
  });
  return json(202, { event_id: eventId });
}

async function listDevices(req: Request) {
  const gate = await requireDevice(req);
  if (gate.error) return gate.error;
  const { data } = await admin.from("remote_devices").select("*").eq("user_id", gate.user!.id).order("created_at");
  return json(200, {
    devices: (data || []).map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      last_seen_at: d.last_seen_at,
      created_at: d.created_at,
      this_device: d.id === gate.deviceId,
    })),
  });
}

async function deleteDevice(req: Request, id: string) {
  const gate = await requireDevice(req);
  if (gate.error) return gate.error;
  const { data } = await admin.from("remote_devices").select("id").eq("id", id).eq("user_id", gate.user!.id).maybeSingle();
  if (!data) return err(404, "not_found", "Unknown device.");
  await admin.from("remote_devices").delete().eq("id", id);
  return new Response(null, { status: 204 });
}

async function getReplies(req: Request, url: URL) {
  const auth = await agentFromReq(req);
  if (auth.error) return auth.error;
  const agent = auth.agent!;
  if (!scopesOf(agent).has("replies:read")) return err(403, "scope_missing", "This agent cannot read replies.");
  const wait = Math.min(25, Math.max(0, Number(url.searchParams.get("wait") || 0)));
  if (wait === 0) {
    const limited = await rate(`re:${agent.id}`, 60, 60);
    if (limited.limited) return err(429, "rate_limited", "Too many reply polls.", { retry: 60 });
  }
  const cursor = parseCursor(url.searchParams.get("cursor"));
  if (cursor) await admin.from("remote_replies").update({ acked_at: new Date().toISOString() }).eq("agent_id", agent.id).lte("cursor", cursor).is("acked_at", null);
  const session = url.searchParams.get("session_id");
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 20)));
  const deadline = Date.now() + wait * 1000;
  const load = async () => {
    let q = admin.from("remote_replies").select("*").eq("agent_id", agent.id).is("acked_at", null).gt("cursor", cursor).order("cursor").limit(limit);
    const { data } = await q;
    const replies = (data || [])
      .map((r) => r.reply)
      .filter((r) => !session || r.session_id === session);
    return { rows: data || [], replies };
  };
  let got = await load();
  while (!got.replies.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    got = await load();
  }
  const next = got.rows.length ? fid(got.rows[got.rows.length - 1].cursor) : fid(cursor);
  const body = { replies: got.replies, next_cursor: next, has_more: got.rows.length >= limit };
  if ((req.headers.get("Accept") || "").includes("text/event-stream")) {
    return new Response(`event: replies\ndata: ${JSON.stringify(body)}\n\nevent: bye\ndata: ${JSON.stringify({ resume: next })}\n\n`, {
      headers: { "Content-Type": "text/event-stream" },
    });
  }
  return json(200, body);
}

async function ackReplies(req: Request) {
  const auth = await agentFromReq(req);
  if (auth.error) return auth.error;
  const read = await readJson(req);
  if (read.error) return read.error;
  const ids = Array.isArray(read.body.reply_ids) ? (read.body.reply_ids as string[]) : [];
  if (ids.length) await admin.from("remote_replies").update({ acked_at: new Date().toISOString() }).eq("agent_id", auth.agent!.id).in("id", ids);
  return new Response(null, { status: 204 });
}

async function agentMe(req: Request) {
  const auth = await agentFromReq(req);
  if (auth.error) return auth.error;
  const agent = auth.agent!;
  const pro = await isPro(agent.user_id);
  const { count } = await admin.from("remote_devices").select("id", { count: "exact", head: true }).eq("user_id", agent.user_id).gt("last_seen_at", new Date(Date.now() - 2 * 60_000).toISOString());
  return json(200, {
    agent_id: agent.id,
    name: agent.name,
    kind: agent.kind,
    scopes: agent.scopes,
    owner_plan_ok: pro,
    devices_online: count || 0,
    created_at: agent.created_at,
    last_used_at: agent.last_used_at,
  });
}

async function deleteOwnToken(req: Request) {
  const auth = await agentFromReq(req);
  if (auth.error) return auth.error;
  await admin.from("remote_tokens").update({ revoked_at: new Date().toISOString() }).eq("token_hash", auth.tokenRow!.token_hash);
  await admin.from("remote_replies").delete().eq("agent_id", auth.agent!.id);
  return new Response(null, { status: 204 });
}

async function rotateOwnToken(req: Request) {
  const auth = await agentFromReq(req);
  if (auth.error) return auth.error;
  const token = liveToken();
  const until = new Date(Date.now() + 3600_000).toISOString();
  await admin.from("remote_tokens").update({ expires_at: until }).eq("token_hash", auth.tokenRow!.token_hash);
  await admin.from("remote_tokens").insert({ token_hash: await sha256(token), agent_id: auth.agent!.id, prefix: token.slice(0, 13) });
  return json(200, { token, old_token_valid_until: until });
}
