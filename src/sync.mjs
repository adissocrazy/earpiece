// Skills & MCP sync: one view of every MCP server and skill across Claude Code, Codex and
// Claude Desktop, and copying them from one tool to another. Every write backs up first.
// MCP servers are only ever added; skills are copied (never symlinked) and updated on request.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configFiles as desktopFiles, LEGACY_KEYS, SERVER_KEY } from "./adapters/claude-desktop.mjs";
import { backup } from "./adapters/install-util.mjs";
import { HOME } from "./paths.mjs";
import { isDry, redact, which } from "./util.mjs";

export const SYNC_TOOLS = [
  { id: "claude-code", name: "Claude Code", skills: true },
  { id: "codex", name: "Codex", skills: true },
  { id: "claude-desktop", name: "Claude Desktop", skills: false },
];
const toolName = (id) => SYNC_TOOLS.find((t) => t.id === id)?.name || id;
const OURS = new Set([SERVER_KEY, ...LEGACY_KEYS]);
const claudeJson = () => path.join(os.homedir(), ".claude.json");
const codexDir = () => path.join(os.homedir(), ".codex");
const codexToml = () => path.join(codexDir(), "config.toml");
const tidy = (p) => (p.startsWith(os.homedir()) ? "~" + p.slice(os.homedir().length) : p);
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

// ---------- TOML (just enough for ~/.codex/config.toml) ----------

const ESC = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\x1b", '"': '"', "\\": "\\" };
const BARE = /[A-Za-z0-9_-]+/y;
const SCALAR = /[A-Za-z0-9_.:+-]+(?: \d{2}:[0-9:.Z+-]+)?/y; // numbers, booleans, dates

/**
 * Parses TOML into plain objects. Throws on anything it can't read, so nothing is half-understood.
 * Pass `headers` to collect every [table] header as { start, keys } (used to cut a table out).
 */
export function parseToml(s, headers = null) {
  const root = {};
  let cur = root;
  let i = 0;
  const fail = (m) => {
    throw new Error(`config.toml line ${s.slice(0, i).split("\n").length}: ${m}`);
  };
  const ws = () => {
    while (s[i] === " " || s[i] === "\t") i++;
  };
  const comment = () => {
    if (s[i] === "#") while (i < s.length && s[i] !== "\n") i++;
  };
  const gap = () => {
    for (;;) {
      ws();
      comment();
      if (s[i] === "\n" || s[i] === "\r") i++;
      else return;
    }
  };
  const endLine = () => {
    ws();
    comment();
    if (i < s.length && s[i] !== "\n" && s[i] !== "\r") fail("expected the end of the line");
  };
  const basic = (b) =>
    b.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S])/g, (_, e) => ESC[e] ?? (e.length > 1 ? String.fromCodePoint(parseInt(e.slice(1), 16)) : fail(`bad escape \\${e}`)));
  function str() {
    const q = s[i];
    if (s.startsWith(q.repeat(3), i)) {
      const end = s.indexOf(q.repeat(3), i + 3);
      if (end < 0) fail("unclosed string");
      let body = s.slice(i + 3, end);
      i = end + 3;
      while (s[i] === q) (body += q), i++; // a closing """ may be preceded by up to two quotes
      body = body.replace(/^\r?\n/, "");
      return q === "'" ? body : basic(body.replace(/\\[ \t]*\r?\n\s*/g, ""));
    }
    let j = i + 1;
    for (; j < s.length && s[j] !== q && s[j] !== "\n"; j++) if (q === '"' && s[j] === "\\") j++;
    if (s[j] !== q) fail("unclosed string");
    const body = s.slice(i + 1, j);
    i = j + 1;
    return q === "'" ? body : basic(body);
  }
  function key() {
    const parts = [];
    for (;;) {
      ws();
      if (s[i] === '"' || s[i] === "'") parts.push(str());
      else {
        BARE.lastIndex = i;
        const m = BARE.exec(s);
        if (!m) fail("expected a key");
        parts.push(m[0]);
        i += m[0].length;
      }
      ws();
      if (s[i] !== ".") return parts;
      i++;
    }
  }
  const set = (t, keys, v) => {
    for (const k of keys.slice(0, -1)) t = t[k] ??= {};
    t[keys.at(-1)] = v;
  };
  function value() {
    ws();
    const c = s[i];
    if (c === '"' || c === "'") return str();
    if (c === "[") {
      i++;
      const arr = [];
      for (;;) {
        gap();
        if (s[i] === "]") return i++, arr;
        arr.push(value());
        gap();
        if (s[i] === ",") i++;
        else if (s[i] !== "]") fail("expected , or ]");
      }
    }
    if (c === "{") {
      i++;
      const t = {};
      for (;;) {
        gap();
        if (s[i] === "}") return i++, t;
        const k = key();
        if (s[i] !== "=") fail("expected =");
        i++;
        set(t, k, value());
        gap();
        if (s[i] === ",") i++;
        else if (s[i] !== "}") fail("expected , or }");
      }
    }
    SCALAR.lastIndex = i;
    const m = SCALAR.exec(s);
    if (!m) fail("expected a value");
    i += m[0].length;
    if (m[0] === "true" || m[0] === "false") return m[0] === "true";
    const n = Number(m[0].replace(/_/g, ""));
    return Number.isFinite(n) ? n : m[0];
  }
  for (;;) {
    gap();
    if (i >= s.length) return root;
    if (s[i] === "[") {
      const start = i;
      const many = s[i + 1] === "[";
      i += many ? 2 : 1;
      const keys = key();
      if (s[i] !== "]" || (many && s[i + 1] !== "]")) fail("bad table header");
      i += many ? 2 : 1;
      headers?.push({ start, keys });
      let t = root;
      for (const k of keys.slice(0, -1)) {
        t = t[k] ??= {};
        if (Array.isArray(t)) t = t.at(-1);
      }
      const last = keys.at(-1);
      if (many) (t[last] ??= []).push((cur = {}));
      else cur = t[last] ??= {};
      endLine();
    } else {
      const keys = key();
      if (s[i] !== "=") fail("expected =");
      i++;
      set(cur, keys, value());
      endLine();
    }
  }
}

const tomlKey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));
// JSON string escapes are all valid TOML basic-string escapes.
const tomlVal = (v) =>
  Array.isArray(v)
    ? `[${v.map(tomlVal).join(", ")}]`
    : typeof v === "object"
      ? `{ ${Object.entries(v).map(([k, x]) => `${tomlKey(k)} = ${tomlVal(x)}`).join(", ")} }`
      : typeof v === "string"
        ? JSON.stringify(v)
        : String(v);
// Comment lines right above a header belong to it.
function ownStart(text, start) {
  let at = start;
  for (;;) {
    const prev = text.lastIndexOf("\n", at - 2) + 1;
    if (at === 0 || !/^\s*#/.test(text.slice(prev, at - 1))) return at;
    at = prev;
  }
}

/** config.toml text without [mcp_servers.<name>] and its sub-tables, or null if it isn't defined as tables. */
export function tomlRemove(text, name) {
  const headers = [];
  parseToml(text, headers);
  let out = "";
  let pos = 0;
  headers.forEach((hd, k) => {
    if (hd.keys[0] !== "mcp_servers" || hd.keys[1] !== name) return;
    const from = ownStart(text, hd.start);
    const to = k + 1 < headers.length ? ownStart(text, headers[k + 1].start) : text.length;
    if (from < pos) return; // already cut with the table before it
    out += text.slice(pos, from);
    pos = to;
  });
  if (!pos) return null;
  const rest = text.slice(pos);
  if (!out.trim()) return rest;
  return (rest ? out.replace(/\n*$/, "\n\n") : out.replace(/\n+$/, "\n")) + rest;
}

export const tomlTable = (name, obj) => [`[mcp_servers.${tomlKey(name)}]`, ...Object.entries(obj).map(([k, v]) => `${k} = ${tomlVal(v)}`)].join("\n") + "\n";

// ---------- MCP: one shape for every tool ----------
// The shared shape is Claude Code's: { type, command, args, env, cwd } or { type, url, headers },
// with a forwarded shell variable written as "${NAME}" inside env or headers.

const REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const BEARER = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const hasRef = (v) => /\$\{/.test(String(v));

function clean(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "object" && !Object.keys(v).length) continue;
    out[k] = v;
  }
  return out;
}
const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
const same = (a, b) => JSON.stringify(sorted({ ...a, plugin: 0 })) === JSON.stringify(sorted({ ...b, plugin: 0 }));

// ponytail: fields outside the shared shape (Codex timeouts and tool approvals, Claude OAuth
// settings) are not copied; the server works without them. Map more here if someone needs one.
export function fromClaude(v) {
  const type = v.type || (v.url ? "http" : "stdio");
  if (type === "stdio") return clean({ type, command: v.command, args: v.args, env: v.env, cwd: v.cwd });
  return clean({ type, url: v.url, headers: v.headers });
}

export function fromCodex(t) {
  if (t.url) {
    const headers = { ...(t.http_headers || {}) };
    for (const [h, name] of Object.entries(t.env_http_headers || {})) headers[h] = `\${${name}}`;
    if (t.bearer_token_env_var) headers.Authorization = `Bearer \${${t.bearer_token_env_var}}`;
    return clean({ type: "http", url: t.url, headers });
  }
  const env = { ...(t.env || {}) };
  for (const name of t.env_vars || []) if (typeof name === "string") env[name] = `\${${name}}`;
  return clean({ type: "stdio", command: t.command, args: t.args, env, cwd: t.cwd });
}

const REMOTE = /^mcp-remote(@.*)?$/;
// Claude Desktop runs remote servers through the mcp-remote bridge; read those back as remote.
export function fromDesktop(v) {
  const at = (v.args || []).findIndex((a) => REMOTE.test(a));
  if (v.command === "npx" && at >= 0 && v.args[at + 1]) {
    const headers = {};
    const rest = v.args.slice(at + 2);
    for (let k = 0; k < rest.length; k++) {
      if (rest[k] !== "--header") return fromClaude(v); // a flag we don't map: keep it as a command
      const [h, ...val] = String(rest[++k]).split(":");
      headers[h.trim()] = val.join(":").trim().replace(/\$\{(\w+)\}/g, (m, n) => v.env?.[n] ?? m);
    }
    return clean({ type: "http", url: v.args[at + 1], headers });
  }
  return fromClaude({ ...v, type: "stdio" });
}

// Each to*() returns [entry, null] or [null, reason it can't be copied].
export function toClaude(n) {
  if (n.cwd) return [null, "it sets a working folder (cwd), which Claude Code can't"];
  return [n.type === "stdio" ? clean({ type: "stdio", command: n.command, args: n.args, env: n.env }) : clean({ type: n.type, url: n.url, headers: n.headers }), null];
}

export function toDesktop(n) {
  if (n.cwd) return [null, "it sets a working folder (cwd), which Claude Desktop can't"];
  const ref = Object.values({ ...n.env, ...n.headers }).map((v) => REF.exec(v) || /\$\{(\w+)/.exec(v)).find(Boolean);
  if (ref) return [null, `it reads ${ref[1]} from your shell, and Claude Desktop can't see shell variables`];
  if (n.type === "stdio") return [clean({ command: n.command, args: n.args, env: n.env }), null];
  const args = ["-y", "mcp-remote", n.url];
  const env = {};
  // Header values go through env so they stay out of the process list.
  Object.entries(n.headers || {}).forEach(([h, v], k) => {
    args.push("--header", `${h}:\${MCP_HEADER_${k}}`);
    env[`MCP_HEADER_${k}`] = v;
  });
  return [clean({ command: "npx", args, env }), null];
}

export function toCodex(n) {
  if (n.type !== "stdio" && n.type !== "http") return [null, `Codex only connects to streamable HTTP servers, not ${n.type}`];
  if (n.type === "http") {
    const out = { url: n.url };
    for (const [h, v] of Object.entries(n.headers || {})) {
      let m;
      if (h.toLowerCase() === "authorization" && (m = BEARER.exec(v))) out.bearer_token_env_var = m[1];
      else if ((m = REF.exec(v))) (out.env_http_headers ??= {})[h] = m[1];
      else if (hasRef(v)) return [null, `the ${h} header mixes text with a shell variable, which Codex can't`];
      else (out.http_headers ??= {})[h] = v;
    }
    return [out, null];
  }
  const out = clean({ command: n.command, args: n.args, cwd: n.cwd });
  for (const [k, v] of Object.entries(n.env || {})) {
    if (REF.exec(v)?.[1] === k) (out.env_vars ??= []).push(k);
    else if (hasRef(v)) return [null, `${k} is built from a shell variable, which Codex can't`];
    else (out.env ??= {})[k] = v;
  }
  return [out, null];
}

// ---------- MCP: reading and writing each tool ----------

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Atomic write that keeps the file's permissions (these configs hold keys).
function writeFile(file, text) {
  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.earpiece-${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

/** Claude Code plugins installed for the user and not switched off: [{ name, root }]. */
export function claudePlugins() {
  const h = os.homedir();
  let installed = {};
  let enabled = {};
  try {
    installed = readJsonFile(path.join(h, ".claude", "plugins", "installed_plugins.json")).plugins || {};
  } catch {}
  try {
    enabled = readJsonFile(path.join(h, ".claude", "settings.json")).enabledPlugins || {};
  } catch {}
  return Object.entries(installed).flatMap(([id, installs]) =>
    (Array.isArray(installs) ? installs : [])
      .filter((p) => p.scope === "user" && p.installPath && enabled[id] !== false)
      .map((p) => ({ name: id.split("@")[0], root: p.installPath })),
  );
}

// A plugin's MCP servers live in its .mcp.json (wrapped or flat) or in plugin.json, and point at
// files inside the plugin through ${CLAUDE_PLUGIN_ROOT}. Copies get the real folder instead.
function pluginServers() {
  const out = {};
  for (const p of claudePlugins()) {
    const found = [];
    for (const file of [path.join(p.root, ".mcp.json"), path.join(p.root, ".claude-plugin", "plugin.json")]) {
      try {
        let j = readJsonFile(file);
        if (file.endsWith("plugin.json")) j = typeof j.mcpServers === "string" ? readJsonFile(path.join(p.root, j.mcpServers)) : { mcpServers: j.mcpServers };
        found.push(j?.mcpServers && typeof j.mcpServers === "object" ? j.mcpServers : j || {});
      } catch {}
    }
    for (const servers of found)
      for (const [name, v] of Object.entries(servers)) {
        if (!v || typeof v !== "object" || out[name]) continue;
        const fixed = JSON.parse(JSON.stringify(v).replaceAll("${CLAUDE_PLUGIN_ROOT}", p.root.replace(/\\/g, "\\\\").replace(/"/g, '\\"')));
        out[name] = { ...fromClaude(fixed), plugin: p.name };
      }
  }
  return out;
}

const presentDesktopFiles = () => desktopFiles().filter((f) => fs.existsSync(path.dirname(f)));
const visible = (servers, from) => Object.fromEntries(Object.entries(servers || {}).filter(([k]) => !OURS.has(k)).map(([k, v]) => [k, from(v)]));

/** { present, servers: { name: shared shape }, error? } for one tool. */
export function readMcp(id) {
  try {
    if (id === "claude-code") {
      if (!fs.existsSync(claudeJson())) return { present: false, servers: {} };
      return { present: true, servers: { ...visible(pluginServers(), (v) => v), ...visible(readJsonFile(claudeJson()).mcpServers, fromClaude) } };
    }
    if (id === "codex") {
      if (!fs.existsSync(codexDir())) return { present: false, servers: {} };
      const text = fs.existsSync(codexToml()) ? fs.readFileSync(codexToml(), "utf8") : "";
      return { present: true, servers: visible(parseToml(text).mcp_servers, fromCodex) };
    }
    if (id === "claude-desktop") {
      const files = presentDesktopFiles();
      const servers = {};
      for (const f of files) if (fs.existsSync(f)) for (const [k, v] of Object.entries(visible(readJsonFile(f).mcpServers, fromDesktop))) servers[k] ??= v;
      return { present: files.length > 0, servers };
    }
  } catch (e) {
    return { present: true, servers: {}, error: e.message };
  }
  return { present: false, servers: {} };
}

// The Mac app starts with a bare PATH, so also look where the installers put it.
const claudeBin = () =>
  which("claude") ? "claude" : [path.join(os.homedir(), ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"].find((f) => fs.existsSync(f));

const show = (entry) => redact(JSON.stringify(entry));

function writeMcp(id, name, n, dryRun) {
  const label = toolName(id);
  if (id === "codex") {
    const [entry, why] = toCodex(n);
    if (why) return [`✗ ${label}: can't copy ${name}: ${why}.`];
    const table = tomlTable(name, entry);
    if (dryRun) return [`• ${label}: would add to ${tidy(codexToml())}:\n${redact(table)}`];
    const text = fs.existsSync(codexToml()) ? fs.readFileSync(codexToml(), "utf8") : "";
    const b = backup(codexToml());
    writeFile(codexToml(), text + (text && !text.endsWith("\n") ? "\n" : "") + (text ? "\n" : "") + table);
    return [`✓ ${label}: added ${name} to ${tidy(codexToml())}${b ? `  (backup: ${path.basename(b)})` : ""}`];
  }
  if (id === "claude-code") {
    const [entry, why] = toClaude(n);
    if (why) return [`✗ ${label}: can't copy ${name}: ${why}.`];
    if (dryRun) return [`• ${label}: would add ${name} to ${tidy(claudeJson())}: ${show(entry)}`];
    // Claude Code rewrites ~/.claude.json all the time, so let its own CLI make the change.
    // Tests (EARPIECE_DRY_RUN) never run the real CLI.
    const claude = isDry() ? null : claudeBin();
    if (claude) {
      try {
        execFileSync(claude,["mcp", "add-json", "--scope", "user", name, JSON.stringify(entry)], { stdio: "pipe", timeout: 20000 });
        return [`✓ ${label}: added ${name} (claude mcp add-json --scope user)`];
      } catch (e) {
        return [`✗ ${label}: claude mcp add-json failed: ${redact(String(e.stderr || e.message).trim())}`];
      }
    }
    let cfg;
    try {
      cfg = readJsonFile(claudeJson());
    } catch {
      return [`✗ ${label}: ${tidy(claudeJson())} is not valid JSON. Nothing changed.`];
    }
    const b = backup(claudeJson());
    cfg.mcpServers = { ...(cfg.mcpServers || {}), [name]: entry };
    writeFile(claudeJson(), JSON.stringify(cfg, null, 2) + "\n");
    return [`✓ ${label}: added ${name} to ${tidy(claudeJson())}${b ? `  (backup: ${path.basename(b)})` : ""}`];
  }
  const [entry, why] = toDesktop(n);
  if (why) return [`✗ ${label}: can't copy ${name}: ${why}.`];
  const out = [];
  for (const file of presentDesktopFiles()) {
    const app = path.basename(path.dirname(file));
    if (dryRun) {
      out.push(`• ${app}: would add ${name} to ${tidy(file)}: ${show(entry)}`);
      continue;
    }
    let cfg = {};
    try {
      if (fs.existsSync(file)) cfg = readJsonFile(file);
    } catch {
      out.push(`✗ ${app}: ${tidy(file)} is not valid JSON. Nothing changed.`);
      continue;
    }
    if (cfg.mcpServers?.[name]) continue;
    const b = backup(file);
    cfg.mcpServers = { ...(cfg.mcpServers || {}), [name]: entry };
    writeFile(file, JSON.stringify(cfg, null, 2) + "\n");
    out.push(`✓ ${app}: added ${name} to ${tidy(file)}${b ? `  (backup: ${path.basename(b)})` : ""}`);
  }
  if (out.some((l) => l.startsWith("✓"))) out.push("  Quit and reopen Claude Desktop to load it.");
  return out;
}

function removeMcpFrom(id, name, dryRun) {
  const label = toolName(id);
  if (id === "codex") {
    const text = fs.readFileSync(codexToml(), "utf8");
    const next = tomlRemove(text, name);
    if (next === null) return [`✗ ${label}: ${name} isn't a [mcp_servers.${name}] table in ${tidy(codexToml())}; remove it there by hand.`];
    if (dryRun) return [`• ${label}: would remove [mcp_servers.${name}] from ${tidy(codexToml())}`];
    const b = backup(codexToml());
    writeFile(codexToml(), next);
    return [`✓ ${label}: removed ${name} from ${tidy(codexToml())}${b ? `  (backup: ${path.basename(b)})` : ""}`];
  }
  const files = id === "claude-code" ? [claudeJson()] : presentDesktopFiles().filter((f) => fs.existsSync(f));
  const out = [];
  for (const file of files) {
    const app = id === "claude-code" ? label : path.basename(path.dirname(file));
    let cfg;
    try {
      cfg = readJsonFile(file);
    } catch {
      out.push(`✗ ${app}: ${tidy(file)} is not valid JSON. Nothing changed.`);
      continue;
    }
    if (!cfg.mcpServers?.[name]) continue;
    if (dryRun) {
      out.push(`• ${app}: would remove ${name} from ${tidy(file)}`);
      continue;
    }
    if (id === "claude-code" && !isDry()) {
      const claude = claudeBin();
      if (claude) {
        try {
          execFileSync(claude, ["mcp", "remove", "--scope", "user", name], { stdio: "pipe", timeout: 20000 });
          out.push(`✓ ${app}: removed ${name} (claude mcp remove --scope user)`);
        } catch (e) {
          out.push(`✗ ${app}: claude mcp remove failed: ${redact(String(e.stderr || e.message).trim())}`);
        }
        continue;
      }
    }
    const b = backup(file);
    delete cfg.mcpServers[name];
    writeFile(file, JSON.stringify(cfg, null, 2) + "\n");
    out.push(`✓ ${app}: removed ${name} from ${tidy(file)}${b ? `  (backup: ${path.basename(b)})` : ""}`);
  }
  if (id === "claude-desktop" && out.some((l) => l.startsWith("✓"))) out.push("  Quit and reopen Claude Desktop to drop it.");
  return out;
}

/** Remove one MCP server from the listed tools (`from`: tool ids, required). Returns message lines. */
export function removeMcp(name, { from, dryRun = false } = {}) {
  if (!from?.length) return ["✗ Say which tools to remove it from."];
  const all = readAllMcp();
  return from.flatMap((id) => {
    const t = all[id];
    if (!t) return [`✗ Unknown tool "${id}".`];
    if (t.error) return [`✗ ${toolName(id)}: couldn't read its config (${t.error}). Nothing changed.`];
    if (!t.servers[name]) return [`• ${toolName(id)} doesn't have ${name}.`];
    if (t.servers[name].plugin) return [`• ${toolName(id)}: ${name} comes with the ${t.servers[name].plugin} plugin; uninstall or disable the plugin to drop it.`];
    return removeMcpFrom(id, name, dryRun);
  });
}

const readAllMcp = () => Object.fromEntries(SYNC_TOOLS.map((t) => [t.id, readMcp(t.id)]));
const TO = { "claude-code": toClaude, codex: toCodex, "claude-desktop": toDesktop };

function mcpRows(all) {
  const names = [...new Set(Object.values(all).flatMap((t) => Object.keys(t.servers)))].sort((a, b) => a.localeCompare(b));
  return names.map((name) => {
    const by = {};
    const cantCopy = {};
    const copies = SYNC_TOOLS.filter((t) => all[t.id].servers[name]).map((t) => all[t.id].servers[name]);
    for (const t of SYNC_TOOLS) {
      const n = all[t.id].servers[name];
      by[t.id] = n ? { summary: redact(n.type === "stdio" ? [n.command, ...(n.args || [])].join(" ") : `${n.type} ${n.url}`), plugin: n.plugin || null } : null;
      if (!n && all[t.id].present) {
        const why = TO[t.id](copies[0])[1];
        if (why) cantCopy[t.id] = why;
      }
    }
    return { name, by, differs: copies.some((c) => !same(c, copies[0])), cantCopy };
  });
}

/**
 * Add one MCP server to other tools. `from` defaults to the first tool that has it, `to` to every
 * installed tool that doesn't. Never replaces a server a tool already has. Returns message lines.
 */
export function syncMcp(name, { from, to, dryRun = false } = {}) {
  const all = readAllMcp();
  const src = from || SYNC_TOOLS.find((t) => all[t.id].servers[name])?.id;
  const n = all[src]?.servers[name];
  if (!n) return [`✗ No MCP server called "${name}"${from ? ` in ${toolName(from)}` : ""}.`];
  const targets = to?.length ? to.filter((id) => id !== src) : SYNC_TOOLS.map((t) => t.id).filter((id) => id !== src && all[id].present && !all[id].servers[name]);
  if (!targets.length) return [`• ${name} is already in every installed tool.`];
  const out = [];
  for (const id of targets) {
    const t = all[id];
    if (!t) out.push(`✗ Unknown tool "${id}". Use ${SYNC_TOOLS.map((x) => x.id).join(", ")}.`);
    else if (t.error) out.push(`✗ ${toolName(id)}: couldn't read its config (${t.error}). Nothing changed.`);
    else if (!t.present) out.push(`• ${toolName(id)} not found; skipped.`);
    else if (t.servers[name]) out.push(`• ${toolName(id)} already has ${name}; left it alone.`);
    else out.push(...writeMcp(id, name, n, dryRun));
  }
  // ponytail: a plugin's local server points into its versioned folder; re-copy after the plugin updates.
  if (n.plugin && n.type === "stdio" && out.some((l) => /^[✓•] /.test(l) && !/already|not found/.test(l)))
    out.push(`  ${name} runs from the ${n.plugin} plugin's folder. After the plugin updates, remove it and copy it again.`);
  return out;
}

// ---------- skills ----------

const SKIP = new Set([".git", "node_modules", ".DS_Store"]);
const skipped = (rel) => rel.split(path.sep).some((p) => SKIP.has(p));

const pluginSkillDirs = () => claudePlugins().map((p) => ({ dir: path.join(p.root, "skills"), write: false, plugin: p.name, why: `from the ${p.name} plugin` }));

// Where each tool reads skills from. The first writable folder is where new copies go.
function skillDirs(id) {
  const h = os.homedir();
  if (id === "claude-code")
    return [
      { dir: path.join(h, ".claude", "skills"), write: true },
      { dir: path.join(h, ".claude", "skills", "synced"), write: false, why: "synced from your Claude account" },
      ...pluginSkillDirs(),
    ];
  if (id === "codex")
    return [
      { dir: path.join(h, ".agents", "skills"), write: true },
      { dir: path.join(h, ".codex", "skills"), write: true },
    ];
  return [];
}

/** sha256 over relative paths and contents, plus the newest file time. Follows symlinks. */
export function fingerprint(dir) {
  const hash = crypto.createHash("sha256");
  let mtime = 0;
  for (const rel of fs.readdirSync(dir, { recursive: true }).map(String).filter((r) => !skipped(r)).sort()) {
    const full = path.join(dir, rel);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue; // broken link
    }
    if (!st.isFile()) continue;
    hash.update(rel + "\0").update(fs.readFileSync(full)).update("\0");
    mtime = Math.max(mtime, st.mtimeMs);
  }
  return { hash: hash.digest("hex"), mtime };
}

/** The `description` from a SKILL.md front matter, single-line or folded (> / |). */
export function skillDescription(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] || "";
  const m = /^description:[ \t]*(.*)$/m.exec(fm);
  if (!m) return "";
  let v = m[1].trim();
  if (/^([>|][+-]?)?$/.test(v)) v = (fm.slice(m.index + m[0].length).match(/^(?:\r?\n[ \t]+.*)+/)?.[0] || "").replace(/\s+/g, " ");
  return v.trim().replace(/^(["'])(.*)\1$/, "$2");
}

function skillCopies() {
  const out = new Map(); // name -> { toolId: copy }
  const prints = new Map(); // real path -> fingerprint
  for (const t of SYNC_TOOLS.filter((x) => x.skills)) {
    for (const src of skillDirs(t.id)) {
      let entries = [];
      try {
        entries = fs.readdirSync(src.dir);
      } catch {}
      for (const name of entries) {
        const dir = path.join(src.dir, name);
        if (name.startsWith(".") || !fs.existsSync(path.join(dir, "SKILL.md"))) continue;
        const row = out.get(name) || out.set(name, {}).get(name);
        if (!("description" in row)) {
          let d = "";
          try {
            d = skillDescription(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"));
          } catch {}
          Object.defineProperty(row, "description", { value: d, enumerable: false });
        }
        if (row[t.id]) continue; // the first folder a tool reads wins
        const link = fs.lstatSync(dir).isSymbolicLink();
        const real = fs.realpathSync(dir);
        if (!prints.has(real)) prints.set(real, fingerprint(real));
        row[t.id] = { dir, real, link, plugin: src.plugin || null, removable: src.write, write: src.write && !link, why: link ? `a link to ${tidy(real)}` : src.why, ...prints.get(real) };
      }
    }
  }
  return out;
}

export function skillRows() {
  return [...skillCopies()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, by]) => {
      const description = by.description;
      const copies = Object.entries(by);
      // ponytail: the newest file time stands in for "the one you edited". If two copies were both
      // edited, pick the source with `from`. A recorded last-synced fingerprint would remove the guess.
      const [newest] = copies.reduce((a, b) => (b[1].mtime > a[1].mtime ? b : a));
      const outdated = copies.filter(([, c]) => c.hash !== by[newest].hash).map(([id]) => id);
      return { name, description, by, newest, outdated };
    });
}

function moveAside(dir, id, name) {
  const dest = path.join(HOME, "backups", "skills", id, `${name}-${stamp()}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(dir, dest);
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
    fs.cpSync(dir, dest, { recursive: true, dereference: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return dest;
}

/**
 * Copy one skill into other tools, or update their out-of-date copies. `from` defaults to the
 * newest copy; `to` defaults to every tool that is missing it or out of date. Returns message lines.
 */
export function syncSkill(name, { from, to, dryRun = false } = {}) {
  const row = skillRows().find((r) => r.name === name);
  if (!row) return [`✗ No skill called "${name}".`];
  const srcId = from || row.newest;
  const src = row.by[srcId];
  if (!src) return [`✗ ${toolName(srcId)} doesn't have ${name}.`];
  const ids = SYNC_TOOLS.filter((t) => t.skills).map((t) => t.id);
  const targets = to?.length ? to.filter((id) => id !== srcId) : ids.filter((id) => id !== srcId && row.by[id]?.hash !== src.hash);
  if (!targets.length) return [`• ${name} is already the same everywhere.`];
  return targets.map((id) => installSkill(src.real, name, id, { dryRun, fromLabel: toolName(srcId), row }));
}

/**
 * Copy the skill folder `srcDir` into tool `id` as `name`. Replaces an out-of-date writable copy
 * (backed up first) and leaves read-only copies alone. Returns one message line.
 */
export function installSkill(srcDir, name, id, { dryRun = false, fromLabel = tidy(srcDir), row } = {}) {
  const label = toolName(id);
  if (!SYNC_TOOLS.find((t) => t.id === id)?.skills) return `✗ ${label} has no skills folder.`;
  const real = fs.realpathSync(srcDir);
  const cur = (row || skillRows().find((r) => r.name === name))?.by[id];
  if (cur?.hash === fingerprint(real).hash) return `• ${label}: ${name} is already up to date.`;
  if (cur && !cur.write) return `• ${label}: ${name} is ${cur.why}; update it there.`;
  const dest = cur ? cur.dir : path.join(skillDirs(id)[0].dir, name);
  if (dryRun) return `• ${label}: would ${cur ? "update" : "copy"} ${name} from ${fromLabel} into ${tidy(dest)}`;
  const b = cur ? moveAside(dest, id, name) : null;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(real, dest, { recursive: true, dereference: true, filter: (f) => !skipped(path.relative(real, f)) });
  } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true });
    if (b) fs.renameSync(b, dest);
    return `✗ ${label}: couldn't copy ${name} (${e.message}). Nothing changed.`;
  }
  return `✓ ${label}: ${cur ? "updated" : "copied"} ${name} into ${tidy(dest)}${b ? `  (backup: ${tidy(b)})` : ""}`;
}

/**
 * Remove a skill from the listed tools (`from`: tool ids, required). Folders move to the backup
 * folder and links are just unlinked. Plugin and account skills are left alone, and so is a
 * folder another tool still links to. Returns message lines.
 */
export function removeSkill(name, { from, dryRun = false } = {}) {
  if (!from?.length) return ["✗ Say which tools to remove it from."];
  const ids = SYNC_TOOLS.filter((t) => t.skills).map((t) => t.id);
  // Every copy of this skill, not just the one each tool reads first.
  const copies = ids.flatMap((id) =>
    skillDirs(id)
      .map((src) => ({ id, src, dir: path.join(src.dir, name) }))
      .filter((c) => fs.existsSync(path.join(c.dir, "SKILL.md")))
      .map((c) => ({ ...c, link: fs.lstatSync(c.dir).isSymbolicLink(), real: fs.realpathSync(c.dir) })),
  );
  const out = [];
  for (const id of from) {
    const label = toolName(id);
    if (!ids.includes(id)) {
      out.push(`✗ ${label} has no skills folder.`);
      continue;
    }
    const mine = copies.filter((c) => c.id === id);
    if (!mine.length) out.push(`• ${label} doesn't have ${name}.`);
    for (const c of mine) {
      if (!c.src.write) {
        out.push(`• ${label}: ${name} is ${c.src.why}; remove it there.`);
        continue;
      }
      const users = copies.filter((o) => o.link && o.id !== id && !from.includes(o.id) && o.real === c.real && !c.link);
      if (users.length) {
        out.push(`• ${label}: kept ${tidy(c.dir)}, because ${toolName(users[0].id)} links to it. Remove it there too to delete it.`);
        continue;
      }
      if (dryRun) {
        out.push(`• ${label}: would remove ${c.link ? "the link " : ""}${tidy(c.dir)}`);
        continue;
      }
      if (c.link) {
        fs.unlinkSync(c.dir);
        out.push(`✓ ${label}: removed the link ${tidy(c.dir)} (${tidy(c.real)} stays)`);
      } else out.push(`✓ ${label}: removed ${name}  (moved to ${tidy(moveAside(c.dir, id, name))})`);
    }
  }
  return out;
}

// ---------- the whole picture ----------

/** Everything the CLI grid and the app's Skills & MCP tab show. */
export function syncInventory() {
  const all = readAllMcp();
  const skills = skillRows().map(({ name, description, by, newest, outdated }) => ({
    name,
    description,
    newest,
    outdated,
    by: Object.fromEntries(Object.entries(by).map(([id, c]) => [id, { where: tidy(c.dir), write: c.write, removable: c.removable, link: c.link, plugin: c.plugin, why: c.why || null, mtime: c.mtime }])),
  }));
  return {
    tools: SYNC_TOOLS.map((t) => ({ ...t, present: all[t.id].present, error: all[t.id].error || null })),
    mcp: mcpRows(all),
    skills,
  };
}
