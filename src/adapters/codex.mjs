// Codex CLI adapter: the top-level `notify` command in ~/.codex/config.toml → hub events.
// Codex runs `notify` with a JSON payload as the last argv item after each agent turn.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, updateConfig } from "../config.mjs";
import { ASK_HOOK_TIMEOUT_SEC } from "../hub/asks.mjs";
import { log, now, readJson } from "../util.mjs";
import { P } from "../paths.mjs";
import { permissionAsk, permissionOutput, replyAsk, replyOutput, turnReply } from "./ask-util.mjs";
import { backup, commandPrefix, isOurCommand, quote } from "./install-util.mjs";

const tomlFile = () => path.join(os.homedir(), ".codex", "config.toml");
// Codex reads lifecycle hooks from here. The notify line above stays in config.toml.
const hooksFile = () => path.join(os.homedir(), ".codex", "hooks.json");
const ASK_EVENTS = ["PermissionRequest", "Stop"];

/**
 * Add (or remove) the blocking hooks that let the card answer. Pure transform of hooks.json text.
 * Returns { text, changed } or { error }.
 */
export function rewriteHooks(text, { command, enable }) {
  let json = {};
  if (text?.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      return { error: "not valid JSON" };
    }
  }
  const before = JSON.stringify(json);
  json.hooks ||= {};
  for (const ev of ASK_EVENTS) {
    const groups = (json.hooks[ev] || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurCommand(h.command)) }))
      .filter((g) => g.hooks.length);
    if (enable) groups.push({ hooks: [{ type: "command", command, timeout: ASK_HOOK_TIMEOUT_SEC, statusMessage: "Waiting for Earpiece" }] });
    if (groups.length) json.hooks[ev] = groups;
    else delete json.hooks[ev];
  }
  if (!Object.keys(json.hooks).length) delete json.hooks;
  const after = JSON.stringify(json);
  return { text: JSON.stringify(json, null, 2) + "\n", changed: before !== after };
}
const MARKER = "# Earpiece voice pings";
const OLD_MARKERS = [MARKER, "# Jarvis voice pings"]; // lines we wrote, before and after the rename
const SEEN_MS = 10 * 60_000;

// Reads a TOML `notify = [ ... ]` value starting at lines[idx], single- or multi-line,
// with comments and trailing commas. Returns { end: lastLineIndex, value: string[] | null }.
export function notifySpan(lines, idx) {
  const eq = lines[idx].indexOf("=");
  let depth = 0, started = false, str = null, esc = false, cur = "";
  const value = [];
  for (let li = idx; li < lines.length; li++) {
    const line = li === idx ? lines[idx].slice(eq + 1) : lines[li];
    let comment = false;
    for (const ch of line) {
      if (comment) break;
      if (str) {
        if (str === '"' && esc) { cur += ch; esc = false; continue; }
        if (str === '"' && ch === "\\") { esc = true; cur += ch; continue; }
        if (ch === str) {
          value.push(str === '"' ? JSON.parse(`"${cur}"`) : cur);
          str = null; cur = "";
        } else cur += ch;
        continue;
      }
      if (ch === "#") comment = true;
      else if (ch === '"' || ch === "'") str = ch;
      else if (ch === "[") { depth++; started = true; }
      else if (ch === "]") {
        depth--;
        if (started && depth === 0) return { end: li, value: value.length ? value : null };
      } else if (!started && !/\s/.test(ch)) return { end: li, value: null }; // not an array
    }
    if (!started && li > idx) break;
  }
  return { end: idx, value: null };
}

// Index of the first [table] / [[array]] header, ignoring `[` inside multi-line arrays and strings.
export function firstTableLine(lines) {
  let depth = 0;
  let multi = null; // open ''' or """ string
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!multi && depth === 0 && /^\s*\[/.test(line)) return i;
    let str = null;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const three = line.slice(j, j + 3);
      if (multi) {
        if (three === multi) { multi = null; j += 2; }
        continue;
      }
      if (str) {
        if (str === '"' && ch === "\\") j++;
        else if (ch === str) str = null;
        continue;
      }
      if (three === '"""' || three === "'''") { multi = three; j += 2; }
      else if (ch === '"' || ch === "'") str = ch;
      else if (ch === "#") break;
      else if (ch === "[") depth++;
      else if (ch === "]") depth = Math.max(0, depth - 1);
    }
  }
  return lines.length;
}

// Pure transform of config.toml text, so it can be unit tested.
// Returns { text, chainSaved?: string[], restored?: boolean, message?: string, changed: boolean }.
export function rewriteToml(text, { ours, uninstall = false, chain = false, savedChain = null }) {
  const lines = text ? text.split("\n") : [];
  const topEnd = firstTableLine(lines);
  const notifyLines = lines.slice(0, topEnd).flatMap((l, i) => (/^\s*notify\s*=/.test(l) ? [i] : []));
  if (notifyLines.length > 1)
    return { text, changed: false, message: `! ${tomlFile()} has more than one top-level notify line; left it alone. Fix it, then re-run.` };
  const notifyIdx = notifyLines.length ? notifyLines[0] : -1;
  const span = notifyIdx >= 0 ? notifySpan(lines, notifyIdx) : null;
  const notifyText = span ? lines.slice(notifyIdx, span.end + 1).join("\n") : "";
  let chainSaved = null;

  if (notifyIdx >= 0 && !isOurCommand(notifyText)) {
    if (uninstall) return { text, changed: false };
    if (!chain)
      return {
        text,
        changed: false,
        message:
          `! ${tomlFile()} already has a notify command:\n    ${span.value ? JSON.stringify(span.value) : notifyText.trim()}\n` +
          "  Left it alone. Re-run with --chain to keep it AND add Earpiece (Earpiece speaks, then forwards the event to it).",
      };
    if (!span.value)
      return { text, changed: false, message: `! Couldn't parse the existing notify value; left it alone. Replace it manually with:\n    ${ours}` };
    chainSaved = span.value;
  }
  if (notifyIdx >= 0) lines.splice(notifyIdx, span.end - notifyIdx + 1);
  const out = lines.filter((l) => !OLD_MARKERS.some((m) => l.startsWith(m)));
  let restored = false;
  if (!uninstall) out.unshift(`${MARKER} (earpiece)`, ours); // top-level keys must precede any [table]
  else if (savedChain?.length) {
    out.unshift(`notify = [${savedChain.map((s) => JSON.stringify(s)).join(", ")}]`);
    restored = true;
  }
  return { text: out.join("\n").replace(/\n*$/, "\n"), chainSaved, restored, changed: true };
}

// The Codex app runs a hidden turn to title each thread, and notify reports it like any other:
// its last message is just {"title":"…"}.
export function isTitleTurn(text) {
  const t = String(text || "").trim();
  if (!t.startsWith("{") || !t.endsWith("}") || t.length > 400) return false;
  try {
    const o = JSON.parse(t);
    return Boolean(o) && !Array.isArray(o) && Object.keys(o).length === 1 && typeof o.title === "string";
  } catch {
    return false;
  }
}

export default {
  id: "codex",
  name: "Codex",

  toEvents(p) {
    if (p.type && p.type !== "agent-turn-complete") return [];
    const text = p["last-assistant-message"] || p.last_assistant_message || "";
    if (isTitleTurn(text)) return []; // Codex naming the thread, not a turn you need to hear about
    return [
      {
        agent: "codex",
        session: p["thread-id"] || p.thread_id || p["turn-id"] || "codex",
        cwd: p.cwd || process.cwd(),
        type: "turn_end",
        text,
      },
    ];
  },

  // Blocking hooks (`earpiece ask codex`): a question the card can answer, or null.
  // Codex doesn't accept updatedPermissions yet (it fails closed), so there is no "always allow".
  // With Reply from the notch on, any finished turn can be answered (soft unless it was a question;
  // the hub only holds a soft one while you're away from the terminal).
  toAsk(p, cfg = {}) {
    if (p.hook_event_name === "PermissionRequest") return permissionAsk("codex", p, { alwaysAllow: false });
    if (p.hook_event_name === "Stop") return cfg.replyFromNotch === true ? turnReply("codex", p) : replyAsk("codex", p);
    return null;
  },

  askOutput(p, ask, answer) {
    return ask.kind === "permission" ? permissionOutput(p, answer, { alwaysAllow: false }) : replyOutput(answer);
  },

  // Forward the raw payload to the user's original notify command, if the installer chained one.
  // The chained command may itself call Earpiece again (e.g. a wrapper whose --previous-notify is
  // Earpiece). EARPIECE_FORWARDED=1 marks that call so it neither speaks nor forwards a second time;
  // firstSeen() below catches wrappers that drop the environment.
  forward(raw) {
    if (process.env.EARPIECE_FORWARDED === "1") return false;
    const chain = config().codexChain;
    if (!Array.isArray(chain) || !chain.length) return false;
    // A chain that runs Earpiece directly would only loop. (A wrapper that calls Earpiece later is
    // fine: the env flag and firstSeen() stop the echo.)
    if (chain.slice(0, 2).some((a) => /(?:earpiece|jarvis)\.mjs$/.test(String(a)))) return false;
    try {
      spawn(chain[0], [...chain.slice(1), raw], { detached: true, stdio: "ignore", env: { ...process.env, EARPIECE_FORWARDED: "1", JARVIS_FORWARDED: "1" } })
        .on("error", (e) => log({ warn: "codex_chain_failed", error: String(e.message || e) }))
        .unref();
      return true;
    } catch (e) {
      log({ warn: "codex_chain_failed", error: String(e.message || e) });
      return false;
    }
  },

  // True the first time a given Codex turn is seen in the last 10 minutes. The marker file is
  // created with O_EXCL, so two processes racing on the same turn can't both win.
  firstSeen(payload, raw) {
    const id = payload["turn-id"] || payload.turn_id;
    const key = crypto
      .createHash("sha1")
      .update(id ? `turn:${payload["thread-id"] || payload.thread_id || ""}:${id}` : `raw:${raw}`)
      .digest("hex")
      .slice(0, 16);
    const file = path.join(P.tmp, `seen-codex-${key}`);
    try {
      if (now() - fs.statSync(file).mtimeMs > SEEN_MS) fs.rmSync(file, { force: true });
    } catch {}
    try {
      fs.writeFileSync(file, "", { flag: "wx", mode: 0o600 });
      return true;
    } catch (e) {
      if (e.code === "EEXIST") return false;
      return true; // can't record it; better to speak once too often than never
    }
  },

  configFile: tomlFile, // the file install() edits; the desktop app reads it to show hook status

  isInstalled() {
    try {
      return isOurCommand(fs.readFileSync(tomlFile(), "utf8"));
    } catch {
      return false;
    }
  },

  install(opts) {
    return [...installNotify(opts), ...installAsk(opts)];
  },
};

function installAsk({ node, bin, cmd, uninstall = false, ask: answers = false, reply = false }) {
  const ask = answers || reply; // both run through the same Stop / PermissionRequest hooks
  const file = hooksFile();
  const exists = fs.existsSync(file);
  if (!exists && (uninstall || !ask)) return [];
  const command = `${commandPrefix({ cmd, node, bin }).map(quote).join(" ")} ask codex`;
  const r = rewriteHooks(exists ? fs.readFileSync(file, "utf8") : "", { command, enable: ask && !uninstall });
  if (r.error) return [`✗ ${file} is ${r.error}. Fix it first; nothing changed.`];
  if (!r.changed) return [];
  const b = backup(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, r.text);
  const on = ask && !uninstall;
  return [
    `✓ Codex approval hooks ${on ? "added to" : "removed from"} ${file}${b ? `  (backup: ${path.basename(b)})` : ""}`,
    ...(on ? ["• Codex asks you to trust new hooks once: run /hooks in Codex and trust the Earpiece ones."] : []),
  ];
}

function installNotify({ node, bin, cmd, uninstall = false, chain = false }) {
  {
    const file = tomlFile();
    const exists = fs.existsSync(file);
    if (!exists && uninstall) return [];
    const ours = `notify = [${[...commandPrefix({ cmd, node, bin }), "codex"].map(quote).join(", ")}]`;
    const savedChain = readJson(P.config, {}).codexChain || null;
    const r = rewriteToml(exists ? fs.readFileSync(file, "utf8") : "", { ours, uninstall, chain, savedChain });
    const msgs = r.message ? [r.message] : [];
    if (!r.changed) return msgs;
    if (r.chainSaved) {
      updateConfig({ codexChain: r.chainSaved });
      msgs.push(`• Kept your existing Codex notify (${r.chainSaved.join(" ")}); Earpiece will forward events to it.`);
    }
    if (r.restored) updateConfig({ codexChain: null });
    const b = backup(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, r.text);
    msgs.push(`✓ Codex notify ${uninstall ? "removed from" : "added to"} ${file}${b ? `  (backup: ${path.basename(b)})` : ""}`);
    return msgs;
  }
}
