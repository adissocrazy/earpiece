// Skills & MCP sync between Claude Code, Codex and Claude Desktop, against a fake home folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { tempHome } from "./helpers.mjs";

const home = tempHome();
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "earpiece-sync-"));
process.env.HOME = fakeHome;
const S = await import("../src/sync.mjs");

const f = (...p) => path.join(fakeHome, ...p);
const write = (file, text) => (fs.mkdirSync(path.dirname(file), { recursive: true }), fs.writeFileSync(file, text));
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const desktop = f("Library", "Application Support", "Claude", "claude_desktop_config.json");
const CODEX = `model = "gpt-5"
notify = ["node", "/x/earpiece.mjs", "codex"] # ours

[mcp_servers.exa]
url = "https://mcp.exa.ai/mcp"
bearer_token_env_var = "EXA_API_KEY"

[mcp_servers.repl]
command = 'node'
args = [
  "-y", # comment
  "repl",
]
cwd = "/tmp"

[mcp_servers.repl.env]
DEBUG = "1"

[mcp_servers.repl.tools.run]
approval_mode = "approve"

[profiles."my.profile"]
desc = """
a [table] lookalike
[mcp_servers.fake]
"""
when = 1979-05-27 07:32:00Z
`;

write(f(".claude.json"), JSON.stringify({ numStartups: 3, mcpServers: { docs: { type: "http", url: "https://docs.example/mcp", headers: { "X-Key": "${DOCS_KEY}" } }, lint: { command: "npx", args: ["lint-mcp"], env: { TOKEN: "abc" } } } }));
write(f(".codex", "config.toml"), CODEX);
write(desktop, JSON.stringify({ mcpServers: { earpiece: { command: "x", args: ["mcp"] }, web: { command: "npx", args: ["-y", "mcp-remote", "https://web.example/mcp", "--header", "Authorization:${MCP_HEADER_0}"], env: { MCP_HEADER_0: "Bearer s3cret" } } } }));

test("the TOML reader reads mcp_servers and isn't fooled by strings or dates", () => {
  const t = S.parseToml(CODEX);
  assert.deepEqual(t.mcp_servers.repl.args, ["-y", "repl"]);
  assert.equal(t.mcp_servers.repl.env.DEBUG, "1");
  assert.equal(t.mcp_servers.fake, undefined);
  assert.match(t.profiles["my.profile"].desc, /^a \[table\]/);
  assert.throws(() => S.parseToml('a = "open'), /line 1/);
});

test("inventory lines up servers across tools and hides Earpiece's own", () => {
  const inv = S.syncInventory();
  assert.deepEqual(inv.mcp.map((r) => r.name), ["docs", "exa", "lint", "repl", "web"]);
  const by = Object.fromEntries(inv.mcp.map((r) => [r.name, r]));
  assert.equal(by.web.by["claude-desktop"].summary, "http https://web.example/mcp"); // mcp-remote read back as remote
  assert.match(by.repl.cantCopy["claude-code"], /cwd/);
  assert.match(by.exa.cantCopy["claude-desktop"], /EXA_API_KEY/);
  assert.match(by.docs.cantCopy["claude-desktop"], /DOCS_KEY/);
});

test("conversions between the three formats", () => {
  const bearer = S.fromCodex({ url: "https://u", bearer_token_env_var: "K" });
  assert.deepEqual(bearer, { type: "http", url: "https://u", headers: { Authorization: "Bearer ${K}" } });
  assert.deepEqual(S.toCodex(bearer)[0], { url: "https://u", bearer_token_env_var: "K" });
  assert.deepEqual(S.toCodex({ type: "stdio", command: "c", env: { A: "${A}", B: "b" } })[0], { command: "c", env_vars: ["A"], env: { B: "b" } });
  assert.match(S.toCodex({ type: "sse", url: "https://u" })[1], /streamable HTTP/);
  assert.match(S.toCodex({ type: "stdio", command: "c", env: { A: "pre-${A}" } })[1], /shell variable/);
  const [d] = S.toDesktop({ type: "http", url: "https://u", headers: { Authorization: "Bearer t" } });
  assert.deepEqual(d.args, ["-y", "mcp-remote", "https://u", "--header", "Authorization:${MCP_HEADER_0}"]);
  assert.deepEqual(S.fromDesktop(d), { type: "http", url: "https://u", headers: { Authorization: "Bearer t" } });
  assert.equal(S.tomlTable("a.b", { args: ['x"y'], env: { K: "v" } }), '[mcp_servers."a.b"]\nargs = ["x\\"y"]\nenv = { K = "v" }\n');
});

test("copying an MCP server appends to Codex, edits JSON in place and backs up", () => {
  const before = fs.readFileSync(f(".codex", "config.toml"), "utf8");
  const dry = S.syncMcp("lint", { dryRun: true });
  assert.ok(dry.every((l) => l.startsWith("•")), dry.join("\n"));
  assert.equal(fs.readFileSync(f(".codex", "config.toml"), "utf8"), before);

  const out = S.syncMcp("lint");
  assert.ok(out.some((l) => /^✓ Codex: added lint/.test(l)), out.join("\n"));
  assert.ok(out.some((l) => /^✓ Claude: added lint/.test(l)), out.join("\n"));
  const after = fs.readFileSync(f(".codex", "config.toml"), "utf8");
  assert.ok(after.startsWith(before), "existing text untouched");
  assert.deepEqual(S.parseToml(after).mcp_servers.lint, { command: "npx", args: ["lint-mcp"], env: { TOKEN: "abc" } });
  assert.deepEqual(json(desktop).mcpServers.lint, { command: "npx", args: ["lint-mcp"], env: { TOKEN: "abc" } });
  assert.ok(fs.readdirSync(f(".codex")).some((n) => n.includes(".bak-earpiece-")));

  S.syncMcp("web", { to: ["claude-code"] });
  const cc = json(f(".claude.json"));
  assert.equal(cc.numStartups, 3, "the rest of ~/.claude.json is kept");
  assert.deepEqual(cc.mcpServers.web, { type: "http", url: "https://web.example/mcp", headers: { Authorization: "Bearer s3cret" } });

  assert.match(S.syncMcp("lint", { to: ["codex"] })[0], /already has lint/);
  assert.match(S.syncMcp("nope")[0], /No MCP server/);
  assert.equal(S.syncInventory().mcp.find((r) => r.name === "lint").differs, false);
});

test("skills: copy, notice an edit, update with a backup, never touch read-only copies", () => {
  write(f(".claude", "skills", "review", "SKILL.md"), "---\nname: review\n---\nv1\n");
  write(f(".claude", "skills", "review", "scripts", "x.sh"), "echo hi\n");
  write(f(".claude", "skills", "review", ".git", "HEAD"), "ref\n");
  const plugin = f(".claude", "plugins", "cache", "m", "p", "1.0.0");
  write(f(".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "p@m": [{ scope: "user", installPath: plugin }] } }));
  write(path.join(plugin, "skills", "plug", "SKILL.md"), "plugin skill\n");

  let out = S.syncSkill("review");
  assert.match(out[0], /^✓ Codex: copied review into ~\/\.agents\/skills\/review/);
  assert.equal(fs.readFileSync(f(".agents", "skills", "review", "scripts", "x.sh"), "utf8"), "echo hi\n");
  assert.equal(fs.existsSync(f(".agents", "skills", "review", ".git")), false);
  assert.deepEqual(S.syncInventory().skills.find((r) => r.name === "review").outdated, []);

  // Edit the Codex copy: Claude Code's is now out of date.
  const later = new Date(Date.now() + 5000);
  fs.writeFileSync(f(".agents", "skills", "review", "SKILL.md"), "---\nname: review\n---\nv2\n");
  fs.utimesSync(f(".agents", "skills", "review", "SKILL.md"), later, later);
  let row = S.syncInventory().skills.find((r) => r.name === "review");
  assert.deepEqual([row.newest, row.outdated], ["codex", ["claude-code"]]);
  out = S.syncSkill("review");
  assert.match(out[0], /^✓ Claude Code: updated review .*backup: .*backups\/skills\/claude-code\/review-/);
  assert.match(fs.readFileSync(f(".claude", "skills", "review", "SKILL.md"), "utf8"), /v2/);
  const backups = path.join(home, "backups", "skills", "claude-code");
  assert.match(fs.readFileSync(path.join(backups, fs.readdirSync(backups)[0], "SKILL.md"), "utf8"), /v1/);
  assert.match(S.syncSkill("review")[0], /already the same everywhere/);

  // Plugin skills copy out but are never written.
  assert.match(S.syncSkill("plug")[0], /^✓ Codex: copied plug/);
  fs.writeFileSync(f(".agents", "skills", "plug", "SKILL.md"), "edited\n");
  fs.utimesSync(f(".agents", "skills", "plug", "SKILL.md"), later, later);
  assert.match(S.syncSkill("plug", { to: ["claude-code"] })[0], /from the p plugin; update it there/);
  assert.equal(fs.readFileSync(path.join(plugin, "skills", "plug", "SKILL.md"), "utf8"), "plugin skill\n");
});

test("plugin MCP servers show up in Claude Code, copy with real paths, and can't be removed here", () => {
  const root = f(".claude", "plugins", "cache", "m", "p", "1.0.0");
  write(path.join(root, ".mcp.json"), JSON.stringify({ mem: { type: "stdio", command: "${CLAUDE_PLUGIN_ROOT}/server.cjs" } }));
  const row = S.syncInventory().mcp.find((r) => r.name === "mem");
  assert.equal(row.by["claude-code"].plugin, "p");
  const out = S.syncMcp("mem", { to: ["codex"] });
  assert.match(out.join("\n"), /runs from the p plugin's folder/);
  assert.equal(S.parseToml(fs.readFileSync(f(".codex", "config.toml"), "utf8")).mcp_servers.mem.command, `${root}/server.cjs`);
  assert.match(S.removeMcp("mem", { from: ["claude-code"] })[0], /comes with the p plugin/);
  // Switched off in settings: gone.
  write(f(".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "p@m": false } }));
  assert.equal(S.syncInventory().mcp.find((r) => r.name === "mem").by["claude-code"], null);
  fs.rmSync(f(".claude", "settings.json"));
});

test("removing MCP servers cuts the Codex table and edits JSON, with backups", () => {
  const before = fs.readFileSync(f(".codex", "config.toml"), "utf8");
  assert.match(S.removeMcp("repl", { from: ["codex"], dryRun: true })[0], /would remove/);
  assert.equal(fs.readFileSync(f(".codex", "config.toml"), "utf8"), before);
  assert.match(S.removeMcp("repl", { from: ["codex"] })[0], /^✓ Codex: removed repl/);
  const t = S.parseToml(fs.readFileSync(f(".codex", "config.toml"), "utf8"));
  assert.equal(t.mcp_servers.repl, undefined);
  assert.ok(t.mcp_servers.exa && t.profiles["my.profile"], "the rest of the file is kept");
  assert.match(S.removeMcp("lint", { from: ["claude-desktop", "claude-code"] }).join("\n"), /Claude: removed lint[\s\S]*Claude Code: removed lint/);
  assert.equal(json(desktop).mcpServers.lint, undefined);
  assert.equal(json(f(".claude.json")).mcpServers.lint, undefined);
  assert.equal(json(f(".claude.json")).numStartups, 3);
  assert.match(S.removeMcp("lint", {})[0], /Say which tools/);
  assert.equal(S.tomlRemove("[mcp_servers]\nz = { command = \"c\" }\n", "z"), null);
});

test("removing skills moves folders to backups, unlinks links, and keeps folders others link to", () => {
  write(f(".agents", "skills", "shared", "SKILL.md"), "---\nname: shared\ndescription: >\n  Shared\n  skill\n---\n");
  fs.symlinkSync(f(".agents", "skills", "shared"), f(".claude", "skills", "shared"));
  assert.equal(S.syncInventory().skills.find((r) => r.name === "shared").description, "Shared skill");
  assert.match(S.removeSkill("shared", { from: ["codex"] })[0], /because Claude Code links to it/);
  assert.match(S.removeSkill("shared", { from: ["claude-code"] })[0], /removed the link/);
  assert.ok(fs.existsSync(f(".agents", "skills", "shared", "SKILL.md")));
  assert.match(S.removeSkill("shared", { from: ["codex"] })[0], /^✓ Codex: removed shared .*moved to/);
  assert.equal(fs.existsSync(f(".agents", "skills", "shared")), false);
  assert.match(S.removeSkill("plug", { from: ["claude-code"] })[0], /from the p plugin; remove it there/);
});

test("a broken config.toml is reported, not overwritten", () => {
  write(f(".codex", "config.toml"), "bad = [\n");
  assert.match(S.syncInventory().tools.find((t) => t.id === "codex").error, /config\.toml/);
  assert.match(S.syncMcp("docs", { to: ["codex"] })[0], /couldn't read its config/);
  assert.equal(fs.readFileSync(f(".codex", "config.toml"), "utf8"), "bad = [\n");
});
