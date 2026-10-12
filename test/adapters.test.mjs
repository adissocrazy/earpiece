import assert from "node:assert/strict";
import test from "node:test";
import { tempHome } from "./helpers.mjs";

tempHome();
const { getAdapter, listAdapters } = await import("../src/adapters/index.mjs");
const { notifySpan, rewriteToml } = await import("../src/adapters/codex.mjs");
const { hermesEvent } = await import("../src/adapters/hermes.mjs");
const { lastAssistantText, openclawEvents } = await import("../src/adapters/openclaw.mjs");

const claude = getAdapter("claude-code");
const codex = getAdapter("codex");
const openclaw = getAdapter("openclaw");
const hermes = getAdapter("hermes");

test("registry has built-ins and a generic fallback", () => {
  assert.deepEqual(listAdapters().map((a) => a.id).sort(), ["claude-code", "claude-desktop", "codex", "hermes", "openclaw"]);
  const g = getAdapter("gemini-cli");
  assert.equal(g.name, "Gemini Cli");
  assert.deepEqual(g.toEvents({ type: "info", line: "hi" }), [{ type: "info", line: "hi", agent: "gemini-cli" }]);
});

test("claude-code maps hook events", () => {
  const base = { session_id: "s", cwd: "/x/api" };
  assert.equal(claude.toEvents({ ...base, hook_event_name: "UserPromptSubmit" })[0].type, "turn_start");
  const stop = claude.toEvents({ ...base, hook_event_name: "Stop", last_assistant_message: "Done.", transcript_path: "/t" })[0];
  assert.equal(stop.type, "turn_end");
  assert.equal(stop.text, "Done.");
  assert.equal(claude.toEvents({ ...base, hook_event_name: "Stop", stop_hook_active: true })[0].continued, true);
  assert.equal(claude.toEvents({ ...base, hook_event_name: "SessionEnd", reason: "prompt_input_exit" })[0].type, "session_end");
  const perm = claude.toEvents({ ...base, hook_event_name: "Notification", message: "Claude needs your permission to use Bash" })[0];
  assert.deepEqual([perm.type, perm.tool], ["needs_input", "Bash"]);
  assert.equal(claude.toEvents({ ...base, hook_event_name: "Notification", message: "Claude is waiting for your input" })[0].type, "idle");
  assert.equal(claude.toEvents({ ...base, hook_event_name: "Notification", notification_type: "idle_prompt" })[0].type, "idle");
  assert.deepEqual(claude.toEvents({ ...base, hook_event_name: "PreToolUse" }), []);
});

test("codex maps agent-turn-complete", () => {
  const [e] = codex.toEvents({ type: "agent-turn-complete", "thread-id": "t1", cwd: "/x/b", "last-assistant-message": "Ok." });
  assert.deepEqual([e.type, e.session, e.text], ["turn_end", "t1", "Ok."]);
  assert.deepEqual(codex.toEvents({ type: "something-else" }), []);
});

test("Hermes lifecycle events map to hub events", () => {
  assert.equal(hermes.toEvents({ hook_event_name: "agent:start", session_id: "s", cwd: "/x" })[0].type, "turn_start");
  const [done] = hermesEvent("agent:end", { session_id: "s", cwd: "/x", response: "Finished.", duration_ms: 1200 });
  assert.deepEqual([done.agent, done.type, done.session, done.text, done.durationMs], ["hermes", "turn_end", "s", "Finished.", 1200]);
  assert.equal(hermesEvent("agent:step", { session_id: "s", tool_names: ["terminal", "patch"] })[0].type, "activity");
});

test("OpenClaw agent_end extracts the last assistant text", () => {
  const messages = [
    { role: "user", content: "Fix it" },
    { role: "assistant", content: [{ type: "text", text: "Done." }] },
  ];
  assert.equal(lastAssistantText(messages), "Done.");
  const [done] = openclawEvents({ type: "agent_end", messages, runId: "r1", success: true }, { sessionKey: "s1", cwd: "/x" });
  assert.deepEqual([done.agent, done.type, done.session, done.text], ["openclaw", "turn_end", "s1", "Done."]);
  const [failed] = openclaw.toEvents({ type: "agent_end", error: "Failed" });
  assert.deepEqual([failed.type, failed.text], ["error", "Failed"]);
});
test("notifySpan parses single and multi-line arrays", () => {
  assert.deepEqual(notifySpan(['notify = ["a", "b c"]'], 0), { end: 0, value: ["a", "b c"] });
  const lines = ["notify = [", '  "x", # comment', "  'y',", "]", "model = 1"];
  assert.deepEqual(notifySpan(lines, 0), { end: 3, value: ["x", "y"] });
  assert.equal(notifySpan(['notify = "str"'], 0).value, null);
});

test("rewriteToml installs at top level, refuses to clobber, chains and restores", () => {
  const ours = 'notify = ["/node", "/j/bin/earpiece.mjs", "codex"]';
  const fresh = rewriteToml('model = "o3"\n[tui]\nx = 1\n', { ours });
  assert.ok(fresh.text.indexOf(ours) < fresh.text.indexOf("[tui]"));

  const theirs = 'notify = ["notifier", "-t"]\n[tui]\n';
  const refused = rewriteToml(theirs, { ours });
  assert.equal(refused.changed, false);
  assert.match(refused.message, /--chain/);

  const chained = rewriteToml(theirs, { ours, chain: true });
  assert.deepEqual(chained.chainSaved, ["notifier", "-t"]);
  assert.ok(!chained.text.includes("notifier"));

  const again = rewriteToml(chained.text, { ours }); // re-install is idempotent
  assert.equal(again.text.split(ours).length, 2);

  const undone = rewriteToml(chained.text, { ours, uninstall: true, savedChain: chained.chainSaved });
  assert.ok(undone.restored);
  assert.match(undone.text, /^notify = \["notifier", "-t"\]/);
  assert.ok(!undone.text.includes("earpiece"));
});

test("firstTableLine skips brackets inside top-level arrays and strings", async () => {
  const { firstTableLine } = await import("../src/adapters/codex.mjs");
  assert.equal(firstTableLine(["a = 1", "[tui]"]), 1);
  assert.equal(firstTableLine(["profiles = [", '  ["a"],', "]", 'notify = ["x"]', "[tui]"]), 4);
  assert.equal(firstTableLine(['s = """', "[not a table]", '"""', "[t]"]), 3);
  const ours = 'notify = ["/n", "/j/bin/earpiece.mjs", "codex"]';
  const r = rewriteToml('profiles = [\n  ["a"],\n]\nnotify = ["x"]\n[tui]\n', { ours });
  assert.equal(r.changed, false); // saw the existing notify instead of adding a duplicate
  assert.equal(rewriteToml('notify = ["a"]\nnotify = ["b"]\n', { ours, chain: true }).changed, false);
});

test("isOurCommand only matches commands Earpiece wrote", async () => {
  const { isOurCommand } = await import("../src/adapters/install-util.mjs");
  assert.ok(isOurCommand('"/usr/bin/node" "/x/bin/earpiece.mjs" hook claude-code'));
  assert.ok(isOurCommand('"/usr/bin/node" "/x/jarvis.mjs" hook'));
  assert.ok(isOurCommand('notify = ["/usr/bin/node", "/x/jarvis.mjs", "codex"]'));
  assert.ok(!isOurCommand('notify = ["node", "/other/jarvis.mjs", "--notify"]'));
  assert.ok(!isOurCommand("node ~/bots/jarvis.mjs remind"));
});
