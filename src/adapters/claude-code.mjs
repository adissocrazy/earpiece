// Claude Code adapter: hooks in ~/.claude/settings.json → hub events.
// Hook docs: https://docs.anthropic.com/en/docs/claude-code/hooks
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ASK_HOOK_TIMEOUT_SEC, REPLY_HOOK_TIMEOUT_SEC } from "../hub/asks.mjs";
import { sleep } from "../util.mjs";
import { permissionAsk, permissionOutput, replyAsk, replyOutput, replyText, turnReply } from "./ask-util.mjs";
import { backup, commandPrefix, isOurCommand, quote } from "./install-util.mjs";

// PostToolUse tells Earpiece the agent is moving again, so a permission alert you already
// answered in the terminal isn't read out after the fact.
const HOOK_EVENTS = ["UserPromptSubmit", "Stop", "Notification", "PostToolUse"];
// With "answer from the card" on, these two also get a blocking hook that waits for the card.
const ASK_EVENTS = ["PermissionRequest", "Stop"];
const settingsFile = () => path.join(os.homedir(), ".claude", "settings.json");

// Read the tail of the transcript and return the last assistant text block.
export function lastAssistantText(transcriptPath) {
  if (!transcriptPath) return "";
  let buf;
  try {
    const fd = fs.openSync(transcriptPath, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 512 * 1024);
    buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
  } catch {
    return "";
  }
  for (const l of buf.toString("utf8").split("\n").reverse()) {
    if (!l.trim()) continue;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    const msg = o.message || o;
    if ((o.type === "assistant" || msg.role === "assistant") && msg.content) {
      const text = Array.isArray(msg.content)
        ? msg.content.filter((c) => c.type === "text").map((c) => c.text).join("\n")
        : String(msg.content);
      if (text.trim()) return text;
    }
  }
  return "";
}

export default {
  id: "claude-code",
  name: "Claude Code",

  toEvents(p) {
    const base = { agent: "claude-code", session: p.session_id || "unknown", cwd: p.cwd };
    switch (p.hook_event_name) {
      case "UserPromptSubmit":
        return [{ ...base, type: "turn_start" }];
      case "Stop":
        if (p.stop_hook_active) return []; // a Stop hook is already continuing the turn
        return [{ ...base, type: "turn_end", text: p.last_assistant_message || "", transcriptPath: p.transcript_path }];
      case "Notification": {
        const msg = String(p.message || "").trim();
        if (p.notification_type === "idle_prompt" || /waiting for your input/i.test(msg)) return [{ ...base, type: "idle" }];
        const perm = msg.match(/permission to use (.+?)\.?$/i);
        if (perm) return [{ ...base, type: "needs_input", tool: perm[1] }];
        return [{ ...base, type: "needs_input", message: msg.replace(/^Claude\s+/i, "") || "needs your attention" }];
      }
      case "PostToolUse":
        return [{ ...base, type: "activity", tool: p.tool_name }];
      default:
        return []; // SubagentStop, PreToolUse, … are ignored
    }
  },

  // Blocking hooks (`earpiece ask claude-code`): a question the card can answer, or null.
  toAsk(p) {
    if (p.hook_event_name === "PermissionRequest") return permissionAsk("claude-code", p);
    if (p.hook_event_name === "Stop") return replyAsk("claude-code", p);
    return null;
  },

  // Reply from the notch (`earpiece-hook reply claude-code`, an asyncRewake Stop hook): any finished turn.
  toReply(p) {
    return p.hook_event_name === "Stop" ? turnReply("claude-code", p) : null; // every reply needs a person, so no loop guard
  },
  replyText,

  // What the hook prints for the answer. null = print nothing, the terminal prompt carries on.
  askOutput(p, ask, answer) {
    return ask.kind === "permission" ? permissionOutput(p, answer) : replyOutput(answer);
  },

  // Runs in the background worker, never in the hook process.
  async enrich(ev) {
    if (ev.type !== "turn_end" || ev.text || !ev.transcriptPath) return ev;
    let text = lastAssistantText(ev.transcriptPath);
    if (!text) {
      await sleep(400); // the transcript can lag the Stop event slightly
      text = lastAssistantText(ev.transcriptPath);
    }
    return { ...ev, text };
  },

  configFile: settingsFile, // the file install() edits; the desktop app reads it to show hook status

  isInstalled() {
    try {
      return isOurCommand(fs.readFileSync(settingsFile(), "utf8").replace(/\\"/g, '"'));
    } catch {
      return false;
    }
  },

  // ask: Answer from the card (blocking PermissionRequest + Stop). reply: Reply from the notch, an
  // asyncRewake Stop hook that replaces the blocking Stop one (it covers questions too, without
  // holding the turn open).
  install({ node, bin, cmd, uninstall = false, ask = false, reply = false }) {
    const file = settingsFile();
    if (uninstall && !fs.existsSync(file)) return [];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let settings = {};
    if (fs.existsSync(file)) {
      try {
        settings = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return [`✗ ${file} is not valid JSON. Fix it first; nothing changed.`];
      }
    }
    const b = backup(file);
    const prefix = commandPrefix({ cmd, node, bin }).map(quote).join(" ");
    const command = `${prefix} hook claude-code`;
    const askCommand = `${prefix} ask claude-code`;
    const replyCommand = `${prefix} reply claude-code`;
    settings.hooks ||= {};
    for (const ev of new Set([...HOOK_EVENTS, ...ASK_EVENTS])) {
      const groups = (settings.hooks[ev] || [])
        .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurCommand(h.command)) }))
        .filter((g) => g.hooks.length);
      if (!uninstall) {
        if (HOOK_EVENTS.includes(ev)) groups.push({ hooks: [{ type: "command", command, timeout: 10 }] });
        // Waits for an answer from the card, so it needs far longer than the 10 s above.
        if (ask && ASK_EVENTS.includes(ev) && !(reply && ev === "Stop"))
          groups.push({ hooks: [{ type: "command", command: askCommand, timeout: ASK_HOOK_TIMEOUT_SEC }] });
        if (reply && ev === "Stop") groups.push({ hooks: [{ type: "command", command: replyCommand, asyncRewake: true, timeout: REPLY_HOOK_TIMEOUT_SEC }] });
      }
      if (groups.length) settings.hooks[ev] = groups;
      else delete settings.hooks[ev];
    }
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
    const tmp = `${file}.earpiece-${process.pid}.tmp`; // atomic: a running Claude Code never reads half a file
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
    fs.renameSync(tmp, file);
    return [`✓ Claude Code hooks ${uninstall ? "removed from" : "added to"} ${file}${b ? `  (backup: ${path.basename(b)})` : ""}`];
  },
};
