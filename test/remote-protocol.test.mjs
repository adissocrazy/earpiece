import assert from "node:assert/strict";
import test from "node:test";
import { tempHome } from "./helpers.mjs";

tempHome();
const { LIMITS, answerToReply, idempotencyKey, isNewer, reservedAgentId, toAsk, toHubEvents, validateEvent, validateFrame } = await import("../src/remote/protocol.mjs");
const { agentConfig, config } = await import("../src/config.mjs");

const base = { v: 1, session_id: "callprep-2026-10-19", status: "done", title: "Call prep", line: "Tomorrow is ready." };

test("validateEvent accepts a done event and rejects bad fields", () => {
  assert.equal(validateEvent(base).ok, true);
  assert.equal(validateEvent({ ...base, status: "nope" }).ok, false);
  assert.match(validateEvent({ ...base, title: "x".repeat(61) }).error, /title/);
  assert.match(validateEvent({ ...base, line: "x".repeat(201) }).error, /line/);
  assert.match(validateEvent({ ...base, text: "x".repeat(2001) }).error, /text/);
  assert.match(validateEvent({ ...base, session_id: "has space" }).error, /session_id/);
  assert.match(validateEvent({ ...base, link: "http://example.com" }).error, /https/);
  assert.match(validateEvent({ ...base, enc: { v: 1 } }).error, /enc/);
  assert.match(validateEvent({ ...base, extra: 1 }).error, /not allowed/);
  assert.match(validateEvent({ ...base, line: "bad\u0000line" }).error, /control/);
  assert.equal(validateEvent({ ...base, question: { prompt: "Yes?" } }).error.includes("question"), true);
  const ask = validateEvent({
    ...base,
    status: "needs_you",
    question: { id: "q1", prompt: "Publish?", options: [{ key: "yes", label: "Yes", style: "primary" }, { key: "no", label: "No", style: "danger" }], allow_text: true, expires_in_s: 3600 },
  });
  assert.equal(ask.ok, true);
  assert.equal(ask.value.question.options.length, 2);
  assert.match(validateEvent({ ...base, status: "needs_you", question: { prompt: "x", options: [{ key: "a", label: "A" }, { key: "b", label: "B" }, { key: "c", label: "C" }, { key: "d", label: "D" }] } }).error, /options/);
  const future = new Date(Date.now() + 11 * 60_000).toISOString();
  assert.equal(validateEvent({ ...base, occurred_at: future }).value.occurred_clamped, true);
  const stale = new Date(Date.now() - LIMITS.skewPastMs - 1000).toISOString();
  assert.match(validateEvent({ ...base, occurred_at: stale }).error, /old/);
});

test("status maps onto hub events, and a second working update is activity", () => {
  const frame = { agent: { hub_id: "remote.grokbot", name: "Avery" }, session_id: "s", status: "working", title: "Call prep" };
  assert.equal(toHubEvents(frame, null, "")[0].type, "turn_start");
  assert.equal(toHubEvents(frame, { status: "working" }, "")[0].type, "activity");
  const done = toHubEvents({ ...frame, status: "done" }, { status: "working" }, "Avery, Call prep. Ready.");
  assert.equal(done[0].type, "turn_end");
  assert.equal(done[0].line, "Avery, Call prep. Ready.");
  assert.equal(done[0].cwd, null);
  assert.equal(toHubEvents({ ...frame, status: "needs_you" }, null, "Avery needs you: look")[0].type, "needs_input");
  assert.equal(toHubEvents({ ...frame, status: "error" }, null, "Avery, Call prep. Failed.")[0].type, "error");
});

test("options round-trip through an ask and back to a reply key", () => {
  const frame = {
    agent: { hub_id: "remote.grokbot", agent_id: "agt_1", name: "Avery", kind: "grokbot" },
    session_id: "posts-week-43",
    status: "needs_you",
    title: "LinkedIn posts",
    link: "https://publish.buffer.com/drafts",
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
  };
  const ask = toAsk(frame, { line: "Avery, LinkedIn posts. Three posts need your approval.", prompt: "Publish the 3 drafted posts?" });
  assert.equal(ask.kind, "permission");
  assert.equal(ask.canAlways, false);
  assert.equal(ask.questions[0].options[2].style, "danger");
  const answer = { behavior: "choose", answers: { "Publish the 3 drafted posts?": "Approve all" } };
  const reply = answerToReply(ask, answer);
  assert.equal(reply.choice_key, "approve_all");
  assert.equal(reply.choice.index, 1);
  assert.equal(reply.question_id, "q_1");
  const typed = answerToReply(ask, { behavior: "choose", answers: { "Publish the 3 drafted posts?": "hold the Thursday one" } });
  assert.equal(typed.choice_key, null);
  assert.match(typed.text, /Thursday/);
  const bare = toAsk({ ...frame, question: null }, { line: "Avery needs you: look" });
  assert.equal(bare.kind, "reply");
  assert.equal(answerToReply(bare, { text: "ship it" }).session_id, "posts-week-43");
  const ack = toAsk({ ...frame, question: { question_id: "q_2", prompt: "OK?", options: [], allow_text: false } }, { prompt: "OK?" });
  assert.equal(ack.questions[0].options[0].label, "OK");
});

test("ordering keeps the newer seq and still accepts a question that arrives late", () => {
  assert.equal(isNewer({ seq: 2 }, { seq: 1 }), true);
  assert.equal(isNewer({ seq: 1 }, { seq: 2 }), false);
  assert.equal(isNewer({ question: { id: "q" }, seq: 1 }, { seq: 9 }), true);
  assert.equal(isNewer({ occurred_at: "2026-10-18T18:00:00Z" }, { occurredAt: "2026-10-18T17:00:00Z" }), true);
  assert.equal(validateFrame({ frame: "event", event_id: "e", session_id: "s", status: "done", agent: { hub_id: "remote.grokbot", agent_id: "agt", kind: "grokbot" } }).ok, true);
  assert.equal(validateFrame({ frame: "event", event_id: "e", session_id: "s", status: "done", agent: { hub_id: "claude-code", agent_id: "agt", kind: "grokbot" } }).ok, false);
  assert.equal(validateFrame({ frame: "plan_lapsed" }).ok, true);
  assert.equal(reservedAgentId("remote.grokbot"), true);
  assert.equal(reservedAgentId("claude-code"), false);
});

test("idempotency key is stable and remote agents are announced with no minimum turn", () => {
  const a = idempotencyKey({ session_id: "s", status: "done", line: "Hi", text: "" });
  const b = idempotencyKey({ session_id: "s", status: "done", line: "Hi", text: "" });
  assert.equal(a, b);
  assert.equal(a.length, 32);
  assert.notEqual(a, idempotencyKey({ session_id: "s", status: "done", line: "Different", text: "" }));
  const cfg = agentConfig(config(), "remote.grokbot");
  assert.equal(cfg.minTurnSeconds, 0);
  assert.equal(cfg.announceAgent, true);
  assert.equal(agentConfig({ ...config(), announceAgent: false, agents: { "remote.grokbot": { minTurnSeconds: 12 } } }, "remote.grokbot").announceAgent, true);
  assert.equal(agentConfig(config(), "codex").announceAgent, false);
});
