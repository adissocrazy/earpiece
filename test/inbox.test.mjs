// The Inbox (the notch panel's Needs you tab): what is listed and in which order, the cleared filter, options read from a plain-text
// question, and the 2-second hold behind every answer.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { buildInbox, quickAnswers, textOptions } from "../src/inbox.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const row = (o) => ({ agentId: "codex", agent: "Codex", project: "api", status: "done", updated: 100, lastLine: "Done.", run: null, ...o });

test("asks holding an agent come first (oldest first), then finished work (newest first)", () => {
  const asks = [
    { id: "b", kind: "permission", agent: "claude-code", session: "s2", at: 20, line: "Allow Bash?", tool: "Bash", detail: "ls", canAlways: true },
    { id: "a", kind: "permission", agent: "claude-code", session: "s1", at: 10, line: "Which?", questions: [{ question: "Which?", text: "Which?", options: [{ label: "A" }, { label: "B" }] }] },
    { id: "soft", kind: "reply", soft: true, agent: "codex", session: "s4", at: 30, line: "Done." },
  ];
  const sessions = [
    row({ agentId: "claude-code", session: "s1", status: "waiting", updated: 10 }), // held by ask a: not listed twice
    row({ session: "s3", updated: 50 }),
    row({ session: "s4", updated: 90 }),
    row({ session: "s5", status: "working", updated: 99 }),
    row({ session: "s6", status: "waiting", updated: 40, lastLine: "Keep it or drop it?" }),
  ];
  const { needs, finished } = buildInbox({ asks, sessions, label: (id) => id.toUpperCase(), now: 100 });
  assert.deepEqual(needs.map((x) => x.id), ["a", "b", "s:codex:s6"]);
  assert.deepEqual(needs.map((x) => x.kind), ["question", "permission", "terminal"]);
  assert.deepEqual(finished.map((x) => x.id), ["s:codex:s4", "s:codex:s3"]);
  assert.equal(finished[0].replyId, "soft", "a finished turn with Reply from the notch open can be replied to");
  assert.equal(needs[1].agent, "CLAUDE-CODE");
});

test("a cleared session stays hidden until it moves on", () => {
  const sessions = [row({ session: "s1", updated: 100 })];
  assert.equal(buildInbox({ sessions, cleared: { "codex:s1": 100 } }).finished.length, 0);
  assert.equal(buildInbox({ sessions: [row({ session: "s1", updated: 101 })], cleared: { "codex:s1": 100 } }).finished.length, 1);
});

test("options are read from a numbered or bulleted list at the end of a question", () => {
  assert.deepEqual(textOptions("Should I:\n1. Keep it\n2) Drop **it**"), ["Keep it", "Drop it"]);
  assert.deepEqual(textOptions("Pick one:\n- Red\n- Blue\nWhich one?"), ["Red", "Blue"]);
  assert.deepEqual(textOptions("Should I keep it?"), []);
  assert.deepEqual(textOptions("1. Only one"), []);
  assert.deepEqual(textOptions("Notes:\n1. a\n2. b\nThen I deploy."), [], "a list followed by more prose isn't a set of options");
  const asks = [{ id: "r", kind: "reply", agent: "codex", session: "x", at: 1, line: "Which?\n1. A\n2. B" }];
  assert.deepEqual(buildInbox({ asks }).needs[0].options, ["A", "B"]);
});

test("every answer is held, Esc takes it back, a new answer sends the waiting one", () => {
  const ctx = { setTimeout: (fn) => (ctx.queue.push(fn), ctx.queue.length), clearTimeout: (i) => (ctx.queue[i - 1] = null), queue: [] };
  vm.runInNewContext(fs.readFileSync(path.join(here, "..", "app", "renderer", "hold.js"), "utf8"), ctx);
  const hold = ctx.createHold(2000, ctx);
  const sent = [];
  hold.start("a", () => sent.push("a"));
  assert.equal(hold.pending(), "a");
  assert.equal(hold.cancel(), true);
  assert.equal(hold.cancel(), false);
  ctx.queue.forEach((f) => f?.());
  assert.deepEqual(sent, []);
  hold.start("b", () => sent.push("b"));
  hold.start("c", () => sent.push("c"));
  assert.deepEqual(sent, ["b"]);
  ctx.queue[1]?.(); // b's timer, had it been left behind, would send c early
  assert.deepEqual(sent, ["b"]);
  ctx.queue.forEach((f) => f?.());
  assert.deepEqual(sent, ["b", "c"], "b's timer was dropped when it was sent early");
  hold.start("d", () => sent.push("d"));
  hold.flush();
  assert.deepEqual(sent, ["b", "c", "d"]);
  assert.equal(hold.pending(), null);
});

test("quick answers: a yes/no question gets Yes / No; a choice (A or B) and statements don't", () => {
  assert.deepEqual(quickAnswers("Tests pass. Should I also open a PR?"), ["Yes", "No"]);
  assert.deepEqual(quickAnswers("Want me to deploy it?"), ["Yes", "No"]);
  assert.deepEqual(quickAnswers("Should I add refunds, or keep it to checkout?"), []);
  assert.deepEqual(quickAnswers("Which layout do you want?"), []);
  assert.deepEqual(quickAnswers("Done, all tests pass."), []);
  assert.deepEqual(quickAnswers("Pick one:\n1. Keep\n2. Drop"), ["Keep", "Drop"], "a list wins");
});

test("stale 'needs you': replied to in the agent → gone; untouched for 3 h → Older", () => {
  const now = 10 * 3600_000;
  const sessions = [
    { agentId: "codex", session: "a", status: "waiting", updated: now - 60_000 },
    { agentId: "codex", session: "b", status: "waiting", updated: now - 60_000 },
    { agentId: "claude-desktop", session: "c", status: "waiting", updated: now - 4 * 3600_000 },
  ];
  const r = buildInbox({ sessions, answered: { "codex:a": now - 30_000, "codex:b": now - 120_000 }, now });
  assert.deepEqual(r.needs.map((x) => x.session), ["b"], "a was answered after it asked; b's last prompt was before");
  assert.deepEqual(r.older.map((x) => x.session), ["c"]);
  assert.equal(buildInbox({ sessions, cleared: { "claude-desktop:c": now - 4 * 3600_000 }, now }).older.length, 0, "opened or cleared: gone until it moves on");
});

test("Codex's session file: the last turn you started", async () => {
  const { lastTurnStart } = await import("../src/codex-seen.mjs");
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ep-codex-")), "rollout-x.jsonl");
  const line = (type, t) => JSON.stringify({ timestamp: new Date(t).toISOString(), type: "event_msg", payload: { type } });
  fs.writeFileSync(f, [line("task_started", 1000), line("task_complete", 2000), line("task_started", 3000), line("token_count", 4000), "{broken"].join("\n"));
  assert.equal(lastTurnStart(f), 3000);
  assert.equal(lastTurnStart(path.join(os.tmpdir(), "nope.jsonl")), 0);
});
