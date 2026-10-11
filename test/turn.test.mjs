// Jev decides whether a finished turn asks you something, finished, or is a progress note; anything
// short of a sure answer keeps the question-mark rule.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { readLog, tempHome } from "./helpers.mjs";

const home = tempHome({ quietHours: null, chimes: false });
delete process.env.EARPIECE_DRY_RUN;
const { classifyTurn } = await import("../src/summary/turn.mjs");
const { config } = await import("../src/config.mjs");
const { processEvent } = await import("../src/hub/hub.mjs");
const { normalizeEvent } = await import("../src/hub/events.mjs");
const { readCard } = await import("../src/card.mjs");

const jev = (choice, p, status = 200) => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    if (!String(url).includes("typesafe")) throw new Error(`unexpected ${url}`);
    return new Response(JSON.stringify({ answers: { turn: { type: "choice", choice, probabilities: { [choice]: p } } } }), { status });
  };
  return { fetch, calls };
};
const STATUS = "Plan complete and saved. Starting on task one now.";
const QUESTION = "Want me to push it?";

test("no key: the question-mark rule, nothing sent", async () => {
  delete process.env.TYPESAFE_API_KEY;
  const { fetch, calls } = jev("progress", 1);
  assert.equal(await classifyTurn(QUESTION, config(), { fetch }), "ask");
  assert.equal(await classifyTurn(STATUS, config(), { fetch }), "done");
  assert.equal(calls.length, 0);
});

test("with a key: a sure Jev answer wins, an unsure or failed one falls back", async () => {
  process.env.TYPESAFE_API_KEY = "ts-test";
  let j = jev("progress", 0.9);
  assert.equal(await classifyTurn(STATUS, config(), { fetch: j.fetch }), "progress");
  assert.equal(j.calls[0].auth, "Bearer ts-test");
  assert.equal(j.calls[0].body.model, "jev-1.13.0");
  assert.deepEqual(Object.keys(j.calls[0].body.questions.turn.criteria), ["ask", "done", "progress"]);
  assert.equal(await classifyTurn("Plan ready. Shall I start", config(), { fetch: jev("ask", 0.8).fetch }), "ask");
  assert.equal(await classifyTurn(STATUS, config(), { fetch: jev("progress", 0.4).fetch }), "done", "unsure");
  assert.equal(await classifyTurn(QUESTION, config(), { fetch: jev("done", 1, 500).fetch }), "ask", "HTTP error");
  j = jev("progress", 1);
  assert.equal(await classifyTurn(STATUS, { ...config(), summaryProvider: "none" }, { fetch: j.fetch }), "done");
  assert.equal(j.calls.length, 0, "summaryProvider none: nothing leaves the machine");
});

test("a progress turn goes on the card silently and is not spoken", async () => {
  process.env.TYPESAFE_API_KEY = "ts-test";
  fs.rmSync(path.join(home, "card.json"), { force: true });
  const ev = normalizeEvent({ type: "turn_end", project: "shop", text: STATUS, durationMs: 60_000 }, "claude-code");
  const r = await processEvent(ev, { fetch: jev("progress", 0.95).fetch });
  assert.equal(r.skipped, "background");
  const card = readCard();
  assert.equal(card.state, "silent");
  assert.equal(card.reason, "background");
  assert.equal(card.kind, "done");
  assert.ok(!readLog(home).some((e) => e.spoke));
});

test("the card follows the server's verdict on a Stop, else the question mark", async () => {
  const { replyAsk, turnReply } = await import("../src/adapters/ask-util.mjs");
  const stop = { hook_event_name: "Stop", session_id: "s", cwd: "/x/shop" };
  assert.ok(replyAsk("claude-code", { ...stop, last_assistant_message: "Plan ready, your call", _earpieceTurn: "ask" }));
  assert.equal(replyAsk("claude-code", { ...stop, last_assistant_message: QUESTION, _earpieceTurn: "progress" }), null);
  assert.ok(replyAsk("claude-code", { ...stop, last_assistant_message: QUESTION }));
  assert.equal(turnReply("claude-code", { ...stop, last_assistant_message: QUESTION, _earpieceTurn: "done" }).soft, true);
});
