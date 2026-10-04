// Quitting the Mac app turns Earpiece off: while ~/.earpiece/app-closed.json exists nothing is spoken
// or summarised (hooks still update the session list), and `earpiece on` / reopening clears it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { tempHome } from "./helpers.mjs";

const home = tempHome({ quietHours: null, chimes: false, ttsProviders: ["smallest"] });
process.env.SMALLEST_API_KEY = "test-smallest";
process.env.OPENAI_API_KEY = "test-openai";
delete process.env.EARPIECE_DRY_RUN;
const { P, BIN } = await import("../src/paths.mjs");
const { appClosed, policyBlock } = await import("../src/policy.mjs");
const { speak } = await import("../src/voice/speak.mjs");
const { summarize } = await import("../src/summary/summarize.mjs");
const { config } = await import("../src/config.mjs");
const { processEvent } = await import("../src/hub/hub.mjs");
const { getSession } = await import("../src/hub/sessions.mjs");
const { readLog } = await import("./helpers.mjs");

const close = () => fs.writeFileSync(P.appClosed, JSON.stringify({ at: Date.now() }));
const open = () => fs.rmSync(P.appClosed, { force: true });

test("app closed: no speech, no network for summaries, but the session list still updates", async () => {
  close();
  try {
    assert.equal(appClosed(), true);
    assert.equal(policyBlock("needs_input", config()), "app_closed", "even 'needs you' stays silent");

    let calls = 0;
    const fetch = async () => (calls++, new Response(Buffer.alloc(4000, 1), { status: 200, headers: { "content-type": "audio/wav" } }));
    const r = await speak("Checkout. All tests pass.", "done", {}, { fetch, playBuffer: () => {} });
    assert.equal(r.skipped, "app_closed");
    const s = await summarize("Refactored the cart drawer into three components. All tests pass.", config(), { fetch });
    assert.equal(s.via, "first-sentence");
    assert.equal(calls, 0, "nothing was sent anywhere");

    await processEvent({ agent: "claude-code", session: "q1", type: "turn_end", cwd: "/x/shop", text: "Done with the cart.", durationMs: 60_000 }, { fetch, playBuffer: () => {} });
    assert.equal(getSession("claude-code", "q1")?.status, "done", "Overview stays accurate");
    assert.equal(calls, 0);
    assert.ok(readLog(home).some((e) => e.skipped === "app_closed"));

    const forced = await speak("Test line.", "done", { force: true }, { fetch, playBuffer: () => {} });
    assert.notEqual(forced.skipped, "app_closed", "earpiece test still works");
  } finally {
    open();
  }
  assert.equal(policyBlock("done", config()), null, "reopened: back to normal");
});

test("`earpiece on` clears the app-closed marker", () => {
  close();
  const env = { ...process.env, EARPIECE_HOME: home, EARPIECE_DRY_RUN: "1" };
  const r = spawnSync(process.execPath, [BIN, "on"], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(P.appClosed), false);
});
