// Shared by the adapters whose agents can wait on a hook for a decision (Claude Code and Codex use
// the same PermissionRequest and Stop hook shapes). Pure functions, so they are easy to test.
import { endsWithQuestion } from "../hub/events.mjs";
import { projectName, redact } from "../util.mjs";

const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+\n/g, "\n").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

// Control characters, bidi overrides and zero-width characters can make a command look like
// something else on screen, so none of them reach the card.
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;
const DETAIL_MAX = 420;

/** The raw text to decide on: the command, the file, or the arguments. Redacted and cleaned, not cut. */
function rawDetail(input) {
  const i = input && typeof input === "object" ? input : {};
  let s;
  if (typeof i.command === "string") s = i.command;
  else if (typeof i.file_path === "string") s = i.file_path;
  else if (typeof i.path === "string") s = i.path;
  else if (typeof i.url === "string") s = i.url;
  else if (typeof i.pattern === "string") s = i.pattern;
  else if (Object.keys(i).length) s = JSON.stringify(i);
  else s = "";
  return redact(s).replace(INVISIBLE, "").replace(/\s+\n/g, "\n").trim();
}

/**
 * Fit text on the card without hiding the end of it. A long command keeps its start AND its end
 * (that's where `&& curl … | sh` lives) with a marker for what's left out, and is flagged partial
 * so the card won't offer Allow for something nobody could read in full.
 */
export function elide(text, max = DETAIL_MAX) {
  if (text.length <= max) return { text, partial: false };
  const tail = Math.floor(max * 0.3);
  const head = max - tail;
  const hidden = text.length - head - tail;
  return { text: `${text.slice(0, head).trimEnd()}\n… [${hidden} more characters not shown] …\n${text.slice(text.length - tail).trimStart()}`, partial: true };
}

/** What the person needs to see to decide: the command, the file, or the arguments. */
export function describeToolInput(tool, input) {
  return elide(rawDetail(input)).text;
}

// Claude Code sends the permission updates it would offer ("Yes, and don't ask again for …").
// Echoing one back makes "Always allow" do exactly what the terminal's own option does.
const alwaysOf = (p) => (Array.isArray(p.permission_suggestions) ? p.permission_suggestions.find((s) => s?.type === "addRules" && s.behavior === "allow") || null : null);

/** "Bash(npm test:*)": the rule "Always allow" would add, so the card can say so. */
function ruleLabel(sug) {
  const rules = Array.isArray(sug?.rules) ? sug.rules : [];
  const parts = rules.map((r) => (r?.ruleContent ? `${r.toolName}(${r.ruleContent})` : String(r?.toolName || ""))).filter(Boolean);
  return clip(redact(parts.join(", ")).replace(INVISIBLE, ""), 140);
}

/**
 * A PermissionRequest payload → an ask, or null.
 * @param {{ alwaysAllow?: boolean }} opts alwaysAllow: this agent accepts updatedPermissions (Codex doesn't yet)
 */
export function permissionAsk(agent, p, { alwaysAllow = true } = {}) {
  if (!p?.tool_name) return null;
  const tool = clip(String(p.tool_name).replace(INVISIBLE, ""), 60);
  const { text: detail, partial } = elide(rawDetail(p.tool_input));
  const why = typeof p.tool_input?.description === "string" ? clip(redact(p.tool_input.description).replace(INVISIBLE, ""), 160) : "";
  const always = alwaysAllow && !partial ? alwaysOf(p) : null;
  return {
    kind: "permission",
    agent,
    session: String(p.session_id || "unknown"),
    cwd: p.cwd || null,
    project: p.cwd ? projectName(p.cwd) : null,
    tool,
    detail,
    why,
    line: `Allow ${tool}?`,
    canAlways: Boolean(always),
    alwaysRule: always ? ruleLabel(always) : "",
    partial, // too long to show in full: the card won't offer Allow for it
  };
}

/** A Stop payload → an ask, only when the agent ended its turn with a question. */
export function replyAsk(agent, p) {
  const text = String(p?.last_assistant_message || "").trim();
  if (!text || !endsWithQuestion(text)) return null;
  // The last paragraph is the question itself; the rest is context the person has already read.
  const last = text.split(/\n{2,}/).filter(Boolean).pop() || text;
  return {
    kind: "reply",
    agent,
    session: String(p.session_id || "unknown"),
    cwd: p.cwd || null,
    project: p.cwd ? projectName(p.cwd) : null,
    line: clip(redact(last).replace(INVISIBLE, ""), 360),
    canAlways: false,
  };
}

/**
 * A Stop payload → a reply the card can offer after ANY finished turn ("Reply from the notch").
 * A turn that ends with a question stays a normal, loud ask; anything else is soft: it rides on the
 * done line as a Reply button instead of turning the island amber.
 */
export function turnReply(agent, p) {
  const text = String(p?.last_assistant_message || "").trim();
  if (!text) return null;
  const ask = replyAsk(agent, p);
  if (ask) return ask;
  const last = text.split(/\n{2,}/).filter(Boolean).pop() || text;
  return {
    kind: "reply",
    soft: true,
    agent,
    session: String(p.session_id || "unknown"),
    cwd: p.cwd || null,
    project: p.cwd ? projectName(p.cwd) : null,
    line: clip(redact(last).replace(INVISIBLE, ""), 360),
    canAlways: false,
  };
}

/** The hook's stdout for a card answer. null = print nothing (the agent's own flow continues). */
export function permissionOutput(payload, answer, { alwaysAllow = true } = {}) {
  if (!answer) return null;
  let decision;
  if (answer.behavior === "deny") decision = { behavior: "deny", message: answer.text || "Denied from the Earpiece card." };
  else if (answer.behavior === "always") {
    const s = alwaysAllow ? alwaysOf(payload) : null; // Codex fails closed on updatedPermissions

    decision = s ? { behavior: "allow", updatedPermissions: [s] } : { behavior: "allow" };
  } else if (answer.behavior === "allow") decision = { behavior: "allow" };
  else return null;
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
}

/** The words the agent receives for a reply from the card. */
export const replyText = (answer) => {
  const text = String(answer?.text || "").trim();
  return text ? `The user replied from the Earpiece card: ${text}` : null;
};

/** A reply typed on the card becomes the agent's next instruction, the way a prompt would. */
export function replyOutput(answer) {
  const reason = replyText(answer);
  return reason ? { decision: "block", reason } : null;
}
