// The hub as a long-running process. The desktop app (and `earpiece serve`) listen on a Unix
// socket; hooks send their payload there with curl instead of starting Node for every event.
// Only the current user can reach the socket (0600, no TCP port).
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { getAdapter } from "../adapters/index.mjs";
import { config } from "../config.mjs";
import { P } from "../paths.mjs";
import { ensureDirs, log } from "../util.mjs";
import { handleCodex, handleHook } from "./entry.mjs";
import { HELD_REPLY_TIMEOUT_MS, MAX_OPEN_ASKS, REPLY_TIMEOUT_MS } from "./asks.mjs";
import { EVENT_TYPES, normalizeEvent } from "./events.mjs";
import { ingestEvent } from "./hub.mjs";
import { HEADER as ORIGIN_HEADER, createOriginTracker } from "./origin.mjs";

const MAX_BODY = 1024 * 1024;
const AGENT_ID = /^[A-Za-z0-9_.-]{1,64}$/;

function isLive(socket) {
  return new Promise((resolve) => {
    const c = net.connect(socket);
    c.once("connect", () => (c.destroy(), resolve(true)));
    c.once("error", () => resolve(false));
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const parse = (raw) => {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
};

/**
 * Start the hub server. Resolves once it is listening.
 * `onEvent(info)` is called after each accepted request (the app uses it to refresh the tray).
 */
export async function startHubServer({ socket = P.socket, deps = {}, onEvent = () => {}, version = "", asks = null, origins = createOriginTracker() } = {}) {
  ensureDirs();
  if (fs.existsSync(socket)) {
    if (await isLive(socket)) throw Object.assign(new Error(`another Earpiece hub is already running on ${socket}`), { code: "EADDRINUSE" });
    fs.rmSync(socket, { force: true }); // left over from a crash
  }
  const pending = new Set();
  const opts = { foreground: true, deps };
  const run = (label, fn) => {
    const p = Promise.resolve()
      .then(fn)
      .catch((e) => log({ error: `hub ${label}: ${e?.message || e}` }))
      .finally(() => (pending.delete(p), onEvent({ route: label })));
    pending.add(p);
  };

  // Fire and forget: work out which terminal this hook came from and keep it on the session record.
  // Never delays the reply and never throws into the request.
  const noteOrigin = (req, agent, payload, fallbackSession = null) => {
    const header = req.headers[ORIGIN_HEADER];
    if (!header || !origins) return;
    try {
      const sessions = new Set();
      for (const ev of getAdapter(agent).toEvents(payload) || []) sessions.add(normalizeEvent(ev, agent).session);
      if (!sessions.size && fallbackSession) sessions.add(fallbackSession);
      for (const s of sessions) origins.note(agent, s, String(header)).catch(() => {});
    } catch {}
  };

  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, "http://earpiece");
      if (req.method === "GET" && url.pathname === "/health") return reply(200, { ok: true, pid: process.pid, version });
      if (req.method !== "POST") return reply(405, { error: "method not allowed" });
      const raw = await readBody(req);
      const hook = /^\/hook\/([^/]+)$/.exec(url.pathname);
      if (hook) {
        const agent = decodeURIComponent(hook[1]);
        if (!AGENT_ID.test(agent)) return reply(400, { error: "bad agent id" });
        const payload = parse(raw);
        // The session moved on by itself (new prompt, the tool ran): questions about it are stale.
        if (asks?.size()) {
          try {
            for (const ev of getAdapter(agent).toEvents(payload) || []) asks.supersede(normalizeEvent(ev, agent));
          } catch {}
        }
        noteOrigin(req, agent, payload);
        run(`hook/${agent}`, () => handleHook(agent, payload, opts));
        return reply(202, { accepted: true });
      }
      // Claude Code's asyncRewake Stop hook: the turn has already ended, nothing waits on this. A reply
      // comes back as plain text; the shim prints it to stderr and exits 2, which wakes the session.
      const replyRoute = /^\/reply\/([^/]+)$/.exec(url.pathname);
      if (replyRoute) {
        const agent = decodeURIComponent(replyRoute[1]);
        if (!AGENT_ID.test(agent)) return reply(400, { error: "bad agent id" });
        const payload = parse(raw);
        const adapter = getAdapter(agent);
        const ask = asks?.available() && config().replyFromNotch === true && asks.size() < MAX_OPEN_ASKS ? adapter.toReply?.(payload) : null;
        if (!ask) {
          res.writeHead(204);
          return res.end();
        }
        noteOrigin(req, agent, payload, ask.session);
        asks.replaceSoft(agent, ask.session);
        const { id, promise } = asks.open(ask, { timeoutMs: REPLY_TIMEOUT_MS });
        res.on("close", () => {
          if (!res.writableEnded) asks.cancel(id, "gone");
        });
        try {
          onEvent({ route: `reply/${agent}` });
        } catch {}
        const text = adapter.replyText?.(await promise);
        if (!res.destroyed) {
          if (text) res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }), res.end(text);
          else res.writeHead(204), res.end();
        }
        return;
      }
      // A blocking hook asks a question and waits. The body is exactly what the hook should print
      // (JSON), or empty with 204 when there is nothing to say, so the shim can pass it straight through.
      const askRoute = /^\/ask\/([^/]+)$/.exec(url.pathname);
      if (askRoute) {
        const agent = decodeURIComponent(askRoute[1]);
        if (!AGENT_ID.test(agent)) return reply(400, { error: "bad agent id" });
        const payload = parse(raw);
        const adapter = getAdapter(agent);
        const cfg = config();
        let ask = asks?.available() && (cfg.answerFromCard === true || cfg.replyFromNotch === true) && asks.size() < MAX_OPEN_ASKS ? adapter.toAsk?.(payload, cfg) : null;
        // Permissions and questions are "Answer from the card"; a reply to any turn is "Reply from the notch".
        if (ask && !(ask.soft ? cfg.replyFromNotch === true : cfg.answerFromCard === true || (ask.kind === "reply" && cfg.replyFromNotch === true))) ask = null;
        // A soft reply here holds the agent (Codex can't be woken later), so only while you're away.
        if (ask?.soft) {
          noteOrigin(req, agent, payload, ask.session);
          if (!(await asks.away(ask))) ask = null;
        }
        if (!ask) {
          res.writeHead(204);
          return res.end();
        }
        noteOrigin(req, agent, payload, ask.session);
        if (ask.soft) asks.replaceSoft(agent, ask.session);
        const { id, promise } = asks.open(ask, ask.soft ? { timeoutMs: HELD_REPLY_TIMEOUT_MS } : undefined);
        // The hook was killed (you answered in the terminal, or the agent gave up): drop the card.
        res.on("close", () => {
          if (!res.writableEnded) asks.cancel(id, "gone");
        });
        try {
          onEvent({ route: `ask/${agent}` });
        } catch {}
        const answer = await promise;
        const out = answer ? adapter.askOutput?.(payload, ask, answer) : null;
        if (!out) {
          if (!res.destroyed) res.writeHead(204), res.end();
          return;
        }
        if (!res.destroyed) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(out));
        }
        return;
      }
      if (url.pathname === "/codex") {
        parse(raw);
        const forwarded = req.headers["x-earpiece-forwarded"] === "1" || req.headers["x-jarvis-forwarded"] === "1";
        if (!forwarded) {
          try {
            noteOrigin(req, "codex", JSON.parse(raw || "{}"));
          } catch {}
        }
        run("codex", () => handleCodex(raw, { forwarded, ...opts }));
        return reply(202, { accepted: true });
      }
      if (url.pathname === "/emit") {
        const body = parse(raw);
        const agent = String(body.agent || "cli");
        if (!AGENT_ID.test(agent)) return reply(400, { error: "bad agent id" });
        if (!EVENT_TYPES.includes(body.type || "info")) return reply(400, { error: `unknown type ${body.type}` });
        const ev = normalizeEvent({ ...body, agent }, agent);
        run("emit", () => ingestEvent(ev, opts));
        return reply(202, { accepted: true });
      }
      return reply(404, { error: "not found" });
    } catch (e) {
      return reply(e.status || 500, { error: e.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => (server.off("error", reject), resolve()));
  });
  fs.chmodSync(socket, 0o600);
  log({ hub: "listening", socket, pid: process.pid });

  return {
    socket,
    server,
    /** Wait for every accepted event to finish (tests, clean shutdown). */
    idle: () => Promise.all([...pending]),
    asks,
    async close() {
      asks?.closeAll(); // waiting hooks get "nothing" and fall back to the terminal prompt
      await new Promise((r) => server.close(r));
      await Promise.all([...pending]);
      fs.rmSync(socket, { force: true });
    },
  };
}
