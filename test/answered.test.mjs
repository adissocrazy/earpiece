import assert from "node:assert/strict";
import test from "node:test";
import { tempHome } from "./helpers.mjs";

tempHome();
const { ingest, ingestEvent } = await import("../src/hub/hub.mjs");
const { getSession, updateSession } = await import("../src/hub/sessions.mjs");

const base = { session_id: "s", cwd: "/x/shop" };
const continuedStop = { ...base, hook_event_name: "Stop", stop_hook_active: true, last_assistant_message: "Updated the tests." };

test("a Stop-hook continuation ends the turn only after you answered from the card", async () => {
  updateSession("claude-code", "s", { status: "working", lastEvent: "turn_start" });
  await ingest("claude-code", continuedStop, { foreground: true });
  assert.equal(getSession("claude-code", "s").status, "working", "someone else's Stop-hook loop stays silent");

  await ingestEvent({ type: "turn_start", agent: "claude-code", session: "s", at: Date.now() - 60_000, lastEvent: "answered" });
  await ingest("claude-code", continuedStop, { foreground: true });
  assert.equal(getSession("claude-code", "s").status, "done");
});

test("SessionEnd takes the session off the list", async () => {
  updateSession("claude-code", "s", { status: "waiting" });
  await ingest("claude-code", { ...base, hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
  assert.equal(getSession("claude-code", "s"), null);
});
