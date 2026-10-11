// The one event shape every adapter produces. The hub only ever sees these.
//
//   {
//     agent:      "claude-code" | "codex" | "aider" | any id      (required)
//     session:    id of the conversation/thread within that agent (default: project)
//     type:       "turn_start" | "turn_end" | "needs_input" | "idle" | "error" | "info" | "activity" | "session_end"
//     cwd:        working directory (used for the spoken project name)
//     project:    explicit project name (overrides cwd)
//     text:       the agent's own final message, to be summarised
//     line:       an exact line to speak (skips summarising)
//     message:    free-text reason for needs_input / error
//     tool:       tool name for a permission request, or the tool that just ran (activity)
//     durationMs: how long the turn took, if the agent reports it
//     at:         epoch ms
//   }

// "activity" means the agent is moving again (a tool just ran). It is never spoken; it withdraws
// a pending "needs you" alert the user already answered in the terminal.
// "session_end": the agent closed the session (Claude Code's SessionEnd); its row goes away.
export const EVENT_TYPES = ["turn_start", "turn_end", "needs_input", "idle", "error", "info", "activity", "session_end"];

export function normalizeEvent(e, agentId) {
  const ev = { ...e };
  ev.agent = String(ev.agent || agentId || "unknown");
  if (!EVENT_TYPES.includes(ev.type)) throw new Error(`unknown event type "${ev.type}" (expected ${EVENT_TYPES.join(", ")})`);
  if (!ev.session) ev.session = ev.project || (ev.cwd ? ev.cwd : "default");
  ev.session = String(ev.session);
  ev.at = Number(ev.at) || Date.now();
  if (ev.durationMs != null) ev.durationMs = Number(ev.durationMs);
  return ev;
}

// A turn that ends on a question is waiting on the human, not done.
export const endsWithQuestion = (text) => /\?\s*["')\]]?\s*$/.test(String(text || "").trim());
