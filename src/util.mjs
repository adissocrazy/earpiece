import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HOME, P } from "./paths.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => Date.now();
export const isDry = () => process.env.EARPIECE_DRY_RUN === "1";
export const isEcho = () => process.env.EARPIECE_ECHO === "1" || isDry();

// State holds agent messages, so it is private to the user (0700 dirs, 0600 files).
export function ensureDirs() {
  for (const d of [HOME, P.sessions, P.tmp, P.remote]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
}

// Strip anything secret-shaped before it is spoken, logged, shown, or sent for a summary.
// Used on agent messages as well as provider error text, so it errs on the side of removing.
// Exported so the remote connector can keep a byte-for-byte copy (test/connector.test.mjs).
export const SECRET_PATTERNS = [
  [/\b(sk|pk|rk)[-_][A-Za-z0-9*_-]{6,}/g, "[redacted]"], // OpenAI, Stripe, Anthropic-style keys
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[redacted]"], // GitHub
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted]"], // Slack
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted]"], // AWS access key ids
  [/\bAIza[0-9A-Za-z_-]{35}/g, "[redacted]"], // Google API keys
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]"], // JWTs
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted]"],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, "$1[redacted]@"], // credentials in URLs
  // NAME=value where the name says it is secret: OPENAI_API_KEY=…, password: …, "token": "…"
  [/\b([\w-]*(?:api[_-]?key|secret|token|passw(?:or)?d)[\w-]*)(["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi, "$1$2[redacted]"],
  [/\b(Bearer|key|token)(["':=\s]+)(?=[A-Za-z0-9*._-]*[0-9*])[A-Za-z0-9*._-]{8,}/gi, "$1$2[redacted]"],
  // Remote-agent credentials. Specific prefixes, so a leak in a cloud agent's text is caught
  // even when the string is shorter than the opaque-token rule below.
  [/epa_(?:live|test)_[A-Za-z0-9]{8,}/g, "[redacted]"],
  [/\bcls_[A-Za-z0-9]{8,}/g, "[redacted]"],
  [/\bwhsec_[A-Za-z0-9]{8,}/g, "[redacted]"],
  // Long opaque strings (32+ chars mixing letters and digits) are almost never worth reading out.
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g, "[redacted]"],
];

export function redact(s) {
  let out = String(s ?? "");
  for (const [re, sub] of SECRET_PATTERNS) out = out.replace(re, sub);
  return out;
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// Atomic write: concurrent hook processes never see a half-written file.
export function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function log(event) {
  try {
    fs.appendFileSync(P.log, JSON.stringify({ t: new Date().toISOString(), ...event }) + "\n", { mode: 0o600 });
  } catch {}
}

export function echo(line) {
  if (isEcho()) process.stdout.write(line + "\n");
}

export function which(bin) {
  return spawnSync("/bin/sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).status === 0;
}

export function projectName(cwd) {
  if (!cwd) return "Terminal";
  return path.basename(cwd).replace(/[-_]+/g, " ").trim() || "Terminal";
}

export function safeId(s) {
  return String(s ?? "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120);
}

// Turn markdown-ish agent output into one plain spoken sentence.
export function plainFirstSentence(text, max = 160) {
  let t = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[#>*\-+|]+\s*/gm, "")
    .replace(/[*_~]+/g, "")
    .replace(/(?:~|\.{1,2})?(?:\/[\w.@-]+){2,}\/?/g, (m) => path.basename(m)) // paths → file name
    .replace(/\s+/g, " ")
    .trim();
  const m = t.match(/^(.{12,}?[.!?])(\s|$)/);
  if (m) t = m[1];
  if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, "") + ".";
  return t;
}

// --flag value / --switch parsing. `names` lists flags that take a value.
export function parseFlags(args, names = []) {
  const flags = {};
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(args[i]);
    if (m && m[2] !== undefined) flags[m[1]] = m[2];
    else if (m && names.includes(m[1])) flags[m[1]] = args[++i];
    else if (m) flags[m[1]] = true;
    else words.push(args[i]);
  }
  return { flags, words };
}

export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
