// Reply from the notch: a Reply after any finished turn. Claude Code gets it through an asyncRewake
// Stop hook (/reply, the shim exits 2 with the reply on stderr); Codex through its blocking Stop hook,
// held only while you're away from its terminal.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { tempHome } from "./helpers.mjs";

tempHome();
const { createAsks, HELD_REPLY_TIMEOUT_MS, REPLY_HOOK_TIMEOUT_SEC } = await import("../src/hub/asks.mjs");
const { turnReply } = await import("../src/adapters/ask-util.mjs");
const claude = (await import("../src/adapters/claude-code.mjs")).default;
const codex = (await import("../src/adapters/codex.mjs")).default;
const { isOurCommand } = await import("../src/adapters/install-util.mjs");
const { updateConfig } = await import("../src/config.mjs");
const { startHubServer } = await import("../src/hub/server.mjs");
const { writeShim } = await import("../src/shim.mjs");
const { BIN, P } = await import("../src/paths.mjs");

const hasCurl = spawnSync("sh", ["-c", "command -v curl"]).status === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keepAlive = setInterval(() => {}, 1000); // the store's timers are unref'd
test.after(() => clearInterval(keepAlive));

const DONE = { hook_event_name: "Stop", session_id: "s1", cwd: "/x/shop", last_assistant_message: "I refactored the cart drawer.\n\nAll 42 tests pass." };
const QUESTION = { ...DONE, last_assistant_message: "Done with the cart.\n\nShould I migrate the checkout page too?" };

const request = (route, body, { abortAfterMs } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ socketPath: P.socket, path: route, method: "POST", agent: false, headers: { "Content-Type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", (e) => (abortAfterMs ? resolve({ aborted: true }) : reject(e)));
    req.end(JSON.stringify(body));
    if (abortAfterMs) setTimeout(() => req.destroy(), abortAfterMs);
  });
const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(10);
  }
  return false;
};

test("turnReply: any finished turn can be replied to; a question stays loud, anything else is soft", () => {
  const soft = turnReply("claude-code", DONE);
  assert.equal(soft.kind, "reply");
  assert.equal(soft.soft, true);
  assert.equal(soft.line, "All 42 tests pass.");
  assert.equal(soft.project, "shop");
  const loud = turnReply("claude-code", QUESTION);
  assert.equal(loud.kind, "reply");
  assert.equal(loud.soft, undefined);
  assert.equal(turnReply("claude-code", { ...DONE, last_assistant_message: "" }), null);
  assert.match(turnReply("codex", { ...DONE, last_assistant_message: "Set OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456" }).line, /\[redacted\]|\*\*\*/i);
});

test("/reply: off, no card, or not a Stop → 204 at once; on → held until the card answers, as plain text", async () => {
  const asks = createAsks();
  const hub = await startHubServer({ asks });
  try {
    asks.setUi(true);
    updateConfig({ replyFromNotch: false });
    assert.equal((await request("/reply/claude-code", DONE)).status, 204, "setting off");
    updateConfig({ replyFromNotch: true });
    assert.equal((await request("/reply/claude-code", { ...DONE, hook_event_name: "Notification" })).status, 204, "not a Stop");
    assert.equal((await request("/reply/codex", DONE)).status, 204, "Codex can't be woken: no /reply for it");

    const pending = request("/reply/claude-code", DONE);
    assert.ok(await waitFor(() => asks.size() === 1));
    const ask = asks.list()[0];
    assert.equal(ask.soft, true);
    assert.ok(ask.expiresAt - ask.at > 20 * 60_000, "a long window: nothing waits on it");
    asks.answer(ask.id, { text: "  also bump the version  " });
    const r = await pending;
    assert.equal(r.status, 200);
    assert.equal(r.body, "The user replied from the Earpiece card: also bump the version");
  } finally {
    updateConfig({ replyFromNotch: false });
    await hub.close();
  }
});

test("a pending reply ends quietly when you type in the terminal, or a newer turn on that session finishes", async () => {
  const asks = createAsks();
  asks.setUi(true);
  const hub = await startHubServer({ asks });
  updateConfig({ replyFromNotch: true });
  try {
    const first = request("/reply/claude-code", DONE);
    assert.ok(await waitFor(() => asks.size() === 1));
    const firstId = asks.list()[0].id;
    const second = request("/reply/claude-code", { ...DONE, last_assistant_message: "Next turn done." });
    assert.equal((await first).status, 204, "replaced by the newer turn");
    assert.ok(await waitFor(() => asks.size() === 1 && asks.list()[0].id !== firstId));
    const other = request("/reply/claude-code", { ...DONE, session_id: "s2" }); // another session is untouched
    assert.ok(await waitFor(() => asks.size() === 2));

    await request("/hook/claude-code", { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/x/shop" });
    assert.equal((await second).status, 204, "you typed in that terminal");
    assert.equal(asks.size(), 1);
    asks.closeAll();
    assert.equal((await other).status, 204);
  } finally {
    updateConfig({ replyFromNotch: false });
    await hub.close();
  }
});

test("Codex: a reply to any turn is held only while you're away, for a short window; questions still need a setting", async () => {
  let away = false;
  const asks = createAsks({ away: async () => away });
  asks.setUi(true);
  const hub = await startHubServer({ asks });
  try {
    updateConfig({ replyFromNotch: true, answerFromCard: false });
    assert.equal((await request("/ask/codex", DONE)).status, 204, "at the keyboard: never hold Codex");
    assert.equal(asks.size(), 0);

    away = true;
    const pending = request("/ask/codex", DONE);
    assert.ok(await waitFor(() => asks.size() === 1));
    const ask = asks.list()[0];
    assert.equal(ask.soft, true);
    assert.equal(ask.expiresAt - ask.at, HELD_REPLY_TIMEOUT_MS);
    asks.answer(ask.id, { text: "ship it" });
    const r = await pending;
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { decision: "block", reason: "The user replied from the Earpiece card: ship it" });

    // A question is a normal ask (not held by the away rule) under either setting.
    away = false;
    const q = request("/ask/codex", QUESTION);
    assert.ok(await waitFor(() => asks.size() === 1));
    assert.equal(asks.list()[0].soft, undefined);
    asks.closeAll();
    assert.equal((await q).status, 204);

    updateConfig({ replyFromNotch: false });
    away = true;
    assert.equal((await request("/ask/codex", DONE)).status, 204, "Reply from the notch off: no reply to plain turns");
    assert.equal((await request("/ask/codex", PERM_CODEX)).status, 204, "permissions still need Answer from the card");
  } finally {
    updateConfig({ replyFromNotch: false, answerFromCard: false });
    await hub.close();
  }
});
const PERM_CODEX = { hook_event_name: "PermissionRequest", session_id: "s1", cwd: "/x/shop", tool_name: "Bash", tool_input: { command: "ls" } };

test("shim reply: exits 2 with the reply on stderr (that wakes Claude Code), 0 and silent otherwise", { skip: !hasCurl && "no curl" }, async () => {
  const shim = writeShim({ fallback: ["/nonexistent/node", BIN] });
  const asks = createAsks();
  asks.setUi(true);
  const hub = await startHubServer({ asks });
  updateConfig({ replyFromNotch: true });
  try {
    const child = spawn(shim, ["reply", "claude-code"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.stdin.end(JSON.stringify(DONE));
    assert.ok(await waitFor(() => asks.size() === 1));
    asks.answer(asks.list()[0].id, { text: "now write the changelog" });
    assert.equal(await new Promise((res) => child.once("exit", res)), 2);
    assert.equal(err.trim(), "The user replied from the Earpiece card: now write the changelog");
    assert.equal(out, "");

    const quiet = spawn(shim, ["reply", "claude-code"], { stdio: ["pipe", "ignore", "pipe"] });
    let qerr = "";
    quiet.stderr.on("data", (c) => (qerr += c));
    quiet.stdin.end(JSON.stringify(DONE));
    assert.ok(await waitFor(() => asks.size() === 1));
    asks.closeAll();
    assert.equal(await new Promise((res) => quiet.once("exit", res)), 0);
    assert.equal(qerr, "");
  } finally {
    updateConfig({ replyFromNotch: false });
    await hub.close();
  }
  const none = spawnSync(shim, ["reply", "claude-code"], { input: JSON.stringify(DONE), encoding: "utf8", timeout: 5000 });
  assert.equal(none.status, 0, "no hub: nothing happens");
  assert.equal(none.stderr, "");
});

test("claude install: Reply from the notch adds one asyncRewake Stop hook and replaces the blocking Stop ask", () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "earpiece-reply-home-"));
  fs.mkdirSync(path.join(h, ".claude"), { recursive: true });
  const old = os.homedir;
  os.homedir = () => h;
  try {
    const file = path.join(h, ".claude", "settings.json");
    const opts = { node: "/n", bin: "/x/bin/earpiece.mjs" };
    const ours = (ev) => (JSON.parse(fs.readFileSync(file, "utf8")).hooks?.[ev] || []).flatMap((g) => g.hooks).filter((x) => isOurCommand(x.command));
    const verbs = (ev) => ours(ev).map((x) => x.command.split(" ").slice(-2, -1)[0]).sort();

    claude.install({ ...opts, ask: true });
    assert.deepEqual(verbs("Stop"), ["ask", "hook"]);

    claude.install({ ...opts, ask: true, reply: true });
    claude.install({ ...opts, ask: true, reply: true }); // no doubles
    assert.deepEqual(verbs("Stop"), ["hook", "reply"], "the async reply covers questions too");
    assert.deepEqual(verbs("PermissionRequest"), ["ask"], "permissions stay blocking");
    const r = ours("Stop").find((x) => / reply claude-code$/.test(x.command));
    assert.equal(r.asyncRewake, true);
    assert.equal(r.timeout, REPLY_HOOK_TIMEOUT_SEC);

    claude.install({ ...opts, reply: true }); // reply alone
    assert.deepEqual(verbs("Stop"), ["hook", "reply"]);
    assert.deepEqual(verbs("PermissionRequest"), []);

    claude.install(opts);
    assert.deepEqual(verbs("Stop"), ["hook"]);
    claude.install({ ...opts, uninstall: true });
    assert.deepEqual(ours("Stop"), []);
  } finally {
    os.homedir = old;
  }
});

test("codex install: Reply from the notch installs the Stop hook even with Answer from the card off", () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "earpiece-reply-home-"));
  fs.mkdirSync(path.join(h, ".codex"), { recursive: true });
  const old = os.homedir;
  os.homedir = () => h;
  try {
    const file = path.join(h, ".codex", "hooks.json");
    const opts = { node: "/n", bin: "/x/bin/earpiece.mjs" };
    codex.install({ ...opts, reply: true });
    assert.ok(fs.existsSync(file));
    assert.match(fs.readFileSync(file, "utf8"), /ask codex/);
    codex.install(opts);
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /ask codex/);
  } finally {
    os.homedir = old;
  }
});

test("CLI `earpiece reply` (hooks installed without the app) behaves like the shim: exit 2 + stderr, else 0", async () => {
  const asks = createAsks();
  asks.setUi(true);
  const hub = await startHubServer({ asks });
  updateConfig({ replyFromNotch: true });
  try {
    const child = spawn(process.execPath, [BIN, "reply", "claude-code"], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (c) => (err += c));
    child.stdin.end(JSON.stringify(DONE));
    assert.ok(await waitFor(() => asks.size() === 1));
    asks.answer(asks.list()[0].id, { text: "run the linter" });
    assert.equal(await new Promise((res) => child.once("exit", res)), 2);
    assert.equal(err.trim(), "The user replied from the Earpiece card: run the linter");
  } finally {
    updateConfig({ replyFromNotch: false });
    await hub.close();
  }
  const none = spawnSync(process.execPath, [BIN, "reply", "claude-code"], { env: process.env, input: JSON.stringify(DONE), encoding: "utf8", timeout: 10000 });
  assert.equal(none.status, 0, "no hub: nothing happens");
  assert.equal(none.stderr, "");
});
