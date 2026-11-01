import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tempHome, readLog } from "./helpers.mjs";

const home = tempHome({ quietHours: null, chimes: false, summaryProvider: "none" });
const { createAsks, navItems, MAX_REMOTE_ASKS } = await import("../src/hub/asks.mjs");
const { updateConfig } = await import("../src/config.mjs");
const { ingestEvent } = await import("../src/hub/hub.mjs");
const { getSession } = await import("../src/hub/sessions.mjs");
const { P } = await import("../src/paths.mjs");
const { createRemoteBridge } = await import("../src/remote/bridge.mjs");
const { startHubServer } = await import("../src/hub/server.mjs");
const { buildInbox } = await import("../src/inbox.mjs");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = { agent_id: "agt_1", hub_id: "remote.grokbot", name: "Avery", kind: "grokbot" };

function frame(over = {}) {
  return {
    frame: "event",
    event_id: over.event_id || `e-${Math.random().toString(36).slice(2)}`,
    agent,
    session_id: "callprep",
    status: "done",
    title: "Call prep",
    line: "Tomorrow's three calls are prepped.",
    text: "Mon 19 Oct: briefs are in Drive.",
    received_at: new Date().toISOString(),
    seq: 1,
    ...over,
  };
}

function bridge(extra = {}) {
  const asks = createAsks();
  asks.setUi(true);
  const replies = [];
  const errors = [];
  const b = createRemoteBridge({
    ingestEvent,
    asks,
    sleep: () => Promise.resolve(),
    reply: async (body) => {
      replies.push(body);
      return extra.reply ? extra.reply(body) : { ok: true, reply_id: "rpl_1" };
    },
    onReplyError: (m) => errors.push(m),
    ...extra,
    asks,
  });
  return { b, asks, replies, errors };
}

test("a done frame is stored, carded and spoken with the paired name", async () => {
  const { b } = bridge();
  await b.handleFrame(frame());
  const s = getSession("remote.grokbot", "callprep");
  assert.equal(s.status, "done");
  assert.equal(s.project, "Call prep");
  assert.equal(s.cwd, null);
  assert.equal(s.remote.kind, "grokbot");
  assert.match(s.lastLine, /^Avery, Call prep\./);
  const card = JSON.parse(fs.readFileSync(P.card, "utf8"));
  assert.match(card.line, /^Avery, Call prep\./);
  assert.equal(card.state, "spoken");
  const spoke = readLog(home).filter((l) => l.spoke);
  assert.ok(spoke.some((l) => l.spoke.startsWith("Avery, Call prep.")));
});

test("quiet hours keep the card and skip the voice", async () => {
  updateConfig({ quietHours: { start: "00:00", end: "23:59", allow: ["needs_input"] } });
  const { b } = bridge();
  await b.handleFrame(frame({ event_id: "quiet-1", session_id: "quiet-s", seq: 1 }));
  const card = JSON.parse(fs.readFileSync(P.card, "utf8"));
  assert.equal(card.state, "silent");
  assert.equal(card.reason, "quiet_hours");
  updateConfig({ quietHours: null });
});

test("per-agent voice settings apply to the remote id", async () => {
  const { agentConfig, config } = await import("../src/config.mjs");
  updateConfig({ agents: { "remote.grokbot": { voice: "sophia", label: "Avery" } } });
  const cfg = agentConfig(config(), "remote.grokbot");
  assert.equal(cfg.smallest.voice, "sophia");
  assert.equal(cfg.label, "Avery");
  assert.equal(cfg.announceAgent, true);
});

test("needs_you opens a numbered ask; answering posts the choice key; Esc-undone answers are simply never delivered", async () => {
  const { b, asks, replies } = bridge();
  await b.handleFrame(frame({
    event_id: "q-1",
    session_id: "posts",
    status: "needs_you",
    title: "LinkedIn posts",
    line: "Three posts need your approval.",
    seq: 2,
    question: {
      question_id: "q_1",
      prompt: "Publish the 3 drafted posts?",
      allow_text: true,
      options: [
        { key: "approve_all", label: "Approve all", style: "primary" },
        { key: "review", label: "I'll review first" },
        { key: "skip", label: "Skip this week", style: "danger" },
      ],
    },
  }));
  const open = asks.list();
  assert.equal(open.length, 1);
  assert.equal(open[0].questions[0].options.length, 3);
  const inbox = buildInbox({ asks: open, sessions: [] });
  assert.equal(inbox.needs[0].kind, "question");
  assert.equal(inbox.needs[0].remote, true);
  assert.equal(inbox.needs[0].agentKind, "grokbot");
  // The 2 s undo lives in the renderer. The hub only sees an answer that survived it.
  asks.answer(open[0].id, { behavior: "choose", answers: { "Publish the 3 drafted posts?": "Approve all" } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(replies[0].choice_key, "approve_all");
  assert.equal(replies[0].choice.index, 1);
});

test("a failed reply is reported and the ask is reopened", async () => {
  const { b, asks, errors } = bridge({ reply: async () => ({ ok: false, status: 0, error: "offline" }) });
  await b.handleFrame(frame({
    event_id: "q-fail",
    session_id: "posts-fail",
    status: "needs_you",
    seq: 1,
    question: { question_id: "q_fail", prompt: "Go?", allow_text: false, options: [{ key: "ok", label: "OK" }] },
  }));
  const id = asks.list()[0].id;
  asks.answer(id, { behavior: "choose", answers: { "Go?": "OK" } });
  await new Promise((r) => setTimeout(r, 30));
  assert.match(errors.join(" "), /Couldn't reach Earpiece cloud/);
  assert.equal(asks.list().length, 1);
});

test("question_closed cancels the ask; a duplicate event is not spoken twice", async () => {
  const { b, asks } = bridge();
  const f = frame({
    event_id: "dup-1",
    session_id: "dup",
    status: "needs_you",
    seq: 1,
    question: { question_id: "q_dup", prompt: "Go?", options: [{ key: "ok", label: "OK" }] },
  });
  await b.handleFrame(f);
  assert.equal(asks.size(), 1);
  await b.handleFrame(f);
  assert.equal(asks.size(), 1);
  await b.handleFrame({ frame: "question_closed", question_id: "q_dup", reason: "answered_elsewhere" });
  assert.equal(asks.size(), 0);
});

test("backlog collapses to one spoken line and does not speak stale rows", async () => {
  const { b } = bridge();
  const old = new Date(Date.now() - 60 * 60_000).toISOString();
  for (let i = 0; i < 5; i++) {
    await b.handleFrame(frame({ event_id: `old-${i}`, session_id: `old-${i}`, received_at: old, seq: 1, line: `Done ${i}` }));
  }
  await b.handleFrame(frame({
    event_id: "old-q",
    session_id: "old-q",
    status: "needs_you",
    title: "Question",
    line: "Need you",
    received_at: old,
    seq: 1,
    question: { question_id: "q_old", prompt: "OK?", options: [{ key: "ok", label: "OK" }] },
  }));
  await b.idle();
  const spoke = readLog(home).filter((l) => l.spoke && /question waiting/.test(l.spoke));
  assert.equal(spoke.length, 1);
  assert.match(spoke[0].spoke, /Avery has 1 question waiting/);
  assert.equal(getSession("remote.grokbot", "old-0").status, "done");
  assert.equal(getSession("remote.grokbot", "old-q").status, "waiting");
});

test("voice cooldown silences a second needs_you inside 30s", async () => {
  const { b } = bridge();
  await b.handleFrame(frame({ event_id: "cool-1", session_id: "c1", status: "needs_you", seq: 1, line: "First" }));
  await b.handleFrame(frame({ event_id: "cool-2", session_id: "c2", status: "needs_you", seq: 1, line: "Second" }));
  const card = JSON.parse(fs.readFileSync(P.card, "utf8"));
  assert.equal(card.reason, "remote_cooldown");
  assert.equal(card.state, "silent");
});

test("remote asks are capped and ordered after local ones", () => {
  const asks = createAsks();
  asks.setUi(true);
  const local = asks.open({ kind: "permission", agent: "claude-code", session: "s", line: "Allow?" });
  const remote = [];
  for (let i = 0; i < MAX_REMOTE_ASKS + 1; i++) remote.push(asks.open({ kind: "permission", agent: "remote.grokbot", session: `r${i}`, line: "Q", remote: { agentId: "agt" } }));
  assert.equal(remote.at(-1).capped, true);
  assert.equal(asks.list().filter((a) => a.remote).length, MAX_REMOTE_ASKS);
  const items = navItems(asks.list());
  assert.equal(items[0].id, local.id);
  assert.equal(items[1].remote.agentId, "agt");
});

test("local ingest rejects remote.* ids and src/remote never spawns a process", async () => {
  const net = await import("node:http");
  const hub = await startHubServer({ socket: path.join(home, "hub.sock") });
  const body = JSON.stringify({ agent: "remote.grokbot", type: "info", line: "nope" });
  const posted = await new Promise((resolve, reject) => {
    const req = net.request({ socketPath: hub.socket, path: "/emit", method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    req.on("error", reject);
    req.end(body);
  });
  assert.equal(posted.status, 400);
  assert.match(posted.body, /reserved agent id/);
  await hub.close();
  for (const name of fs.readdirSync(path.join(root, "src/remote"))) {
    if (!name.endsWith(".mjs")) continue;
    const src = fs.readFileSync(path.join(root, "src/remote", name), "utf8");
    assert.equal(src.includes("child_process"), false, name);
    assert.doesNotMatch(src, /\bjumpTo\b/, name);
    assert.doesNotMatch(src, /\bspawn(?:Sync)?\s*\(/, name);
  }
});
