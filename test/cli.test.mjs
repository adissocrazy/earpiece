import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "earpiece-cli-"));
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ quietHours: null, chimes: false, replyFromNotch: false }) /* reply hooks: reply.test.mjs */);
const env = { ...process.env, EARPIECE_HOME: home, EARPIECE_DRY_RUN: "1", EARPIECE_FOREGROUND: "1", HOME: home };
delete env.SMALLEST_API_KEY;
delete env.OPENAI_API_KEY;

const earpiece = (args, input, entry = "bin/earpiece.mjs") =>
  spawnSync(process.execPath, [path.join(ROOT, entry), ...args], { env, input, encoding: "utf8" });

test("help lists the hub commands", () => {
  const r = earpiece(["help"]);
  assert.equal(r.status, 0);
  for (const c of ["agents", "emit", "install", "voice <id> [--agent id]"]) assert.ok(r.stdout.includes(c), c);
});

test("quiet-hours sets, silences and clears the window", () => {
  let r = earpiece(["quiet-hours", "21:30-07:00", "--silent"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /21:30-07:00, completely silent/);
  r = earpiece(["quiet-hours", "--allow", "needs_input,error"]);
  assert.match(r.stdout, /21:30-07:00, only needs_input and error/);
  assert.equal(earpiece(["quiet-hours", "9pm"]).status, 2);
  assert.equal(earpiece(["quiet-hours", "--allow", "everything"]).status, 2);
  assert.match(earpiece(["quiet-hours", "off"]).stdout, /off/);
});

test("install --hub points hooks at the shim, replacing the node hooks", () => {
  assert.equal(earpiece(["install", "--only", "claude-code"]).status, 0);
  assert.equal(earpiece(["install", "--hub", "--only", "claude-code"]).status, 0);
  const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.hooks.Stop.length, 1);
  assert.match(settings.hooks.Stop[0].hooks[0].command, /bin\/earpiece-hook" hook claude-code$/);
  assert.ok(fs.statSync(path.join(home, "bin", "earpiece-hook")).mode & 0o100);
  earpiece(["uninstall"]);
});

test("plain install keeps hooks on the shim (app hooks survive), --node switches back", () => {
  const shim = path.join(home, "bin", "earpiece-hook");
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(shim, "#!/bin/sh\n# written by the app\nexit 0\n", { mode: 0o700 });
  const settingsFile = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `"${shim}" hook claude-code` }] }] } }));

  const r = earpiece(["install", "--only", "claude-code"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /keeping that/);
  let settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.equal(settings.hooks.Stop.length, 1);
  assert.match(settings.hooks.Stop[0].hooks[0].command, /earpiece-hook" hook claude-code$/);
  assert.match(fs.readFileSync(shim, "utf8"), /written by the app/, "the app's shim is not rewritten");

  assert.equal(earpiece(["install", "--node", "--only", "claude-code"]).status, 0);
  settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.equal(settings.hooks.Stop.length, 1);
  assert.match(settings.hooks.Stop[0].hooks[0].command, /earpiece\.mjs" hook claude-code$/);
  earpiece(["uninstall"]);
});

test("earpiece env sets envFile without touching hooks", () => {
  const envFile = path.join(home, "keys.env");
  fs.writeFileSync(envFile, "OPENAI_API_KEY=sk-test-not-real-000000000000\n");
  const r = earpiece(["env", envFile]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /keys found: OPENAI_API_KEY/);
  assert.ok(!r.stdout.includes("sk-test"), "never prints key values");
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).envFile, envFile);
  assert.ok(!fs.existsSync(path.join(home, ".claude", "settings.json")) || !fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8").includes("earpiece"));
  assert.equal(earpiece(["env", path.join(home, "missing.env")]).status, 1);
});

test("unknown commands exit non-zero", () => {
  assert.equal(earpiece(["nope"]).status, 2);
});

test("emit + agents", () => {
  let r = earpiece(["emit", "--agent", "aider", "--type", "turn_end", "--project", "docs", "--duration", "90", "Rebuilt the docs."]);
  assert.equal(r.status, 0, r.stderr);
  r = earpiece(["agents", "--json"]);
  const s = JSON.parse(r.stdout);
  assert.equal(s[0].agent, "aider");
  assert.equal(s[0].lastLine, "docs. Rebuilt the docs.");
  assert.match(earpiece(["agents"]).stdout, /Aider\s+docs/);
});

test("emit reads a JSON event on stdin", () => {
  const r = earpiece(["emit"], JSON.stringify({ agent: "ci", type: "error", project: "api", line: "API build failed." }));
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(earpiece(["agents", "--json"]).stdout).find((x) => x.agent === "ci");
  assert.equal(s.status, "error");
});

test("legacy ./jarvis.mjs hook and codex entry points still work and never fail", () => {
  let r = earpiece(["hook"], JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "L1", cwd: "/x/legacy" }), "jarvis.mjs");
  assert.equal(r.status, 0);
  r = earpiece(["codex", JSON.stringify({ type: "agent-turn-complete", "thread-id": "c1", cwd: "/x/pay", "last-assistant-message": "Paid." })], "", "jarvis.mjs");
  assert.equal(r.status, 0);
  r = earpiece(["hook"], "not json", "jarvis.mjs");
  assert.equal(r.status, 0);
  const s = JSON.parse(earpiece(["agents", "--json"]).stdout);
  assert.ok(s.find((x) => x.agent === "claude-code" && x.session === "L1" && x.status === "working"));
  assert.ok(s.find((x) => x.agent === "codex" && x.session === "c1"));
});

test("install and uninstall round-trip in a fake HOME", () => {
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "o3"\n');
  let r = earpiece(["install"], "", "install.mjs");
  assert.equal(r.status, 0, r.stderr);
  const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.match(settings.hooks.Stop[0].hooks[0].command, /bin\/earpiece\.mjs" hook claude-code$/);
  assert.match(settings.hooks.PostToolUse[0].hooks[0].command, /hook claude-code$/);
  assert.match(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), /bin\/earpiece\.mjs", "codex"\]/);
  r = earpiece(["uninstall"]);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8")), {});
  assert.equal(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), 'model = "o3"\n');
});

test("where: --here describes this shell, the table says 'not seen yet' until a hook arrives", () => {
  const h = earpiece(["where", "--here", "--json"]);
  assert.equal(h.status, 0, h.stderr);
  const o = JSON.parse(h.stdout);
  assert.equal(o.v, 1);
  assert.ok(Array.isArray(o.via));
  assert.match(earpiece(["where", "--here"]).stdout, /^This shell: /);

  earpiece(["emit", "--agent", "aider", "--type", "turn_start", "--project", "docs-site"]);
  const t = earpiece(["where"]);
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /CLICK LANDS ON/);
  assert.match(t.stdout, /docs-site.*not seen yet/);
  const j = JSON.parse(earpiece(["where", "--json"]).stdout);
  assert.equal(j.find((s) => s.project === "docs-site").origin, null);
  assert.ok(earpiece(["help"]).stdout.includes("where"));
});
