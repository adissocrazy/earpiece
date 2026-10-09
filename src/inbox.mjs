// The Inbox: everything waiting on you (questions, permission requests, agents stopped in their own
// terminal) and the work that finished in the last day, in the order the notch panel shows it.
const FINISHED = new Set(["done", "error", "idle"]);
const OLD_MS = 3 * 3600_000; // "needs you" with nothing new for this long folds into Older
const OPTION = /^\s*(?:\d{1,2}[.)]|[-*•])\s+(.{1,200})$/;

/**
 * Options in a question the agent wrote as plain text: a numbered or bulleted list at the end of it
 * ("Should I:\n1. Keep it\n2. Drop it"). Picking one sends its text as the reply. [] when there is none.
 */
export function textOptions(text) {
  const lines = String(text || "").trim().split("\n");
  // A closing question after the list ("Which one?") is fine; anything else means it isn't one.
  if (lines.length > 2 && !OPTION.test(lines.at(-1)) && /\?\s*$/.test(lines.at(-1))) lines.pop();
  const out = [];
  for (let i = lines.length - 1; i >= 0 && OPTION.test(lines[i]); i--) out.unshift(lines[i].match(OPTION)[1].replace(/\*\*/g, "").trim());
  return out.length >= 2 && out.length <= 9 ? out : [];
}

// "Should I also add tests?" → Yes / No. Not when it offers a choice ("A, or B?"): reply to those.
const YES_NO = /(?:^|[.!:]\s+)(?:should|shall|do|does|did|can|could|would|will|is|are|want me to|ok(?:ay)? to)\b[^.!?]*\?\s*$/i;
export function quickAnswers(text) {
  const t = String(text || "").trim();
  const opts = textOptions(t);
  if (opts.length) return opts;
  const last = t.split("\n").at(-1);
  return YES_NO.test(last) && !/\bor\b/i.test(last) ? ["Yes", "No"] : [];
}

const key = (agentId, session) => `${agentId}:${session}`;

/**
 * The list, from the open asks and the sessions (state().sessions rows). `cleared`: { "agent:session":
 * the session's `updated` when you cleared it }, so it comes back only once the session moves on.
 * `answered`: { "agent:session": when you last prompted it in the agent itself } (Codex's own file),
 * so a question you've already replied to there leaves too.
 * Order: what holds an agent first (oldest first), then finished work (newest first). Waiting
 * sessions untouched for 3 h go to `older`.
 */
export function buildInbox({ asks = [], sessions = [], cleared = {}, answered = {}, label = (id) => id, now = Date.now() }) {
  const bySession = new Map(sessions.map((s) => [key(s.agentId, s.session), s]));
  const soft = new Map(asks.filter((a) => a.soft).map((a) => [key(a.agent, a.session), a]));
  const held = new Set();
  const needs = [];
  const older = [];
  for (const a of asks) {
    if (a.soft) continue;
    held.add(key(a.agent, a.session));
    const kind = a.questions ? "question" : a.kind === "permission" ? "permission" : "reply";
    const options = kind === "reply" ? quickAnswers(a.line) : [];
    needs.push({
      id: a.id,
      kind,
      agentId: a.agent,
      agent: label(a.agent),
      session: a.session,
      project: a.project || bySession.get(key(a.agent, a.session))?.project || "",
      at: a.at,
      line: a.line,
      ...(kind === "permission" ? { tool: a.tool, detail: a.detail, why: a.why, canAlways: a.canAlways, alwaysRule: a.alwaysRule, partial: a.partial } : {}),
      ...(a.questions ? { questions: a.questions } : {}),
      ...(options.length ? { options } : {}),
      run: bySession.get(key(a.agent, a.session))?.run || null,
    });
  }
  needs.sort((a, b) => a.at - b.at);
  const finished = [];
  for (const s of sessions) {
    const k = key(s.agentId, s.session);
    if (held.has(k) || (cleared[k] ?? -1) >= (s.updated || 0)) continue;
    // Waiting with no ask open: the agent asked in its own terminal (hooks off, or it timed out).
    const waiting = s.status === "waiting";
    if (waiting && (answered[k] || 0) > (s.updated || 0)) continue; // you already replied there
    if (!waiting && !FINISHED.has(s.status)) continue;
    const reply = soft.get(k);
    const options = waiting || reply ? quickAnswers(s.lastLine) : [];
    const item = {
      id: `s:${k}`,
      kind: waiting ? "terminal" : s.status,
      agentId: s.agentId,
      agent: s.agent || label(s.agentId),
      session: s.session,
      project: s.project || "",
      at: s.updated || 0,
      line: s.lastLine || "",
      run: s.run || null,
      replyId: reply?.id || null,
      ...(options.length ? { options } : {}),
    };
    (!waiting ? finished : item.at < now - OLD_MS ? older : needs).push(item);
  }
  finished.sort((a, b) => b.at - a.at);
  older.sort((a, b) => b.at - a.at);
  return { needs, older, finished };
}
