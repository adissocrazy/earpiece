// Questions an agent is waiting on. A blocking hook (Claude Code / Codex PermissionRequest or
// Stop) sends one to the hub and holds its connection open; the Mac app shows it on the floating
// card; the answer goes back through the same connection and out of the hook as its decision.
//
// Nothing here is persisted. If the app quits or the timeout passes, the hook prints nothing and the
// agent carries on with its normal terminal prompt, exactly as if Earpiece were not installed.
import crypto from "node:crypto";
import { now } from "../util.mjs";

// The hook's own `timeout` (seconds) must outlast the hub's, or the agent would kill the hook
// before the hub can answer "nothing".
export const ASK_TIMEOUT_MS = 115_000;
export const ASK_HOOK_TIMEOUT_SEC = 125;
export const ASK_CURL_TIMEOUT_SEC = 120;
// "Reply from the notch" for Claude Code runs as an asyncRewake Stop hook: nothing waits on it, so
// the window can be long. Hub < curl < hook timeout, like above.
export const REPLY_TIMEOUT_MS = 29 * 60_000;
export const REPLY_CURL_TIMEOUT_SEC = 29 * 60 + 30;
export const REPLY_HOOK_TIMEOUT_SEC = 30 * 60;
// Codex can't be woken later, so its reply holds the Stop hook: short, and only while you're away.
export const HELD_REPLY_TIMEOUT_MS = 60_000;

const BEHAVIORS = new Set(["allow", "always", "deny"]);
const MAX_REPLY = 4000;
export const MAX_OPEN_ASKS = 20; // a flood of asks must not bury the real ones

/** Check what the card sent back for an ask. Returns the clean answer, or throws. */
export function checkAnswer(ask, answer) {
  if (ask.kind === "permission") {
    const behavior = String(answer?.behavior || "");
    if (!BEHAVIORS.has(behavior)) throw new Error("unknown answer");
    if (behavior === "always" && !ask.canAlways) throw new Error("this request can't be always-allowed");
    if (ask.partial && behavior !== "deny") throw new Error("too long to approve here, check it in the terminal");
    const text = behavior === "deny" ? String(answer?.text || "").trim().slice(0, MAX_REPLY) : "";
    return { behavior, ...(text ? { text } : {}) };
  }
  const text = String(answer?.text ?? "").trim().slice(0, MAX_REPLY);
  if (!text) throw new Error("empty reply");
  return { text };
}

/**
 * @param {object} o
 * @param {(list: object[], change: {type: string, ask: object}) => void} [o.onChange] called after every open/close
 * @param {(ask: object) => Promise<boolean>} [o.away] for a soft reply that holds the agent (Codex): is
 *   the person away from that agent's terminal? The app answers; without one, never hold.
 */
export function createAsks({ onChange = () => {}, away = async () => false } = {}) {
  const open = new Map(); // id -> { ask, settle, timer }
  let uiCount = 0;

  const publicAsk = (a) => ({ ...a });
  const list = () => [...open.values()].map((e) => publicAsk(e.ask)).sort((a, b) => a.at - b.at);
  const notify = (type, ask) => {
    try {
      onChange(list(), { type, ask: publicAsk(ask) });
    } catch {}
  };

  function close(id, result, type) {
    const e = open.get(id);
    if (!e) return false;
    open.delete(id);
    clearTimeout(e.timer);
    e.settle(result);
    notify(type, e.ask);
    return true;
  }

  return {
    /** The app calls this with true while it can show cards. With no UI, asks are never opened. */
    setUi(on) {
      uiCount = on ? 1 : 0;
    },
    available: () => uiCount > 0,
    away: (ask) => Promise.resolve(away(ask)).catch(() => false),

    /**
     * Open an ask. Resolves to the answer, or null (timed out, cancelled, superseded).
     * `ask`: { kind, agent, session, project?, cwd?, tool?, detail?, line, canAlways? }
     */
    open(ask, { timeoutMs = ASK_TIMEOUT_MS } = {}) {
      const id = crypto.randomUUID();
      const full = { ...ask, id, at: now(), expiresAt: now() + timeoutMs };
      let settle;
      const promise = new Promise((r) => (settle = r));
      const timer = setTimeout(() => close(id, null, "timeout"), timeoutMs);
      timer.unref?.();
      open.set(id, { ask: full, settle, timer });
      notify("open", full);
      return { id, ask: full, promise };
    },

    /** The card answered. Returns the clean answer that was sent on, or throws (bad shape / unknown id). */
    answer(id, answer) {
      const e = open.get(id);
      if (!e) throw new Error("That question is gone.");
      const clean = checkAnswer(e.ask, answer);
      close(id, clean, "answered");
      return clean;
    },

    cancel: (id, why = "cancelled") => close(id, null, why),

    /** A newer finished turn replaces the soft reply waiting on the same session (one per session). */
    replaceSoft(agent, session) {
      for (const { ask } of [...open.values()]) if (ask.soft && ask.agent === agent && ask.session === session) close(ask.id, null, "superseded");
    },

    /**
     * The session moved on by itself, so a question about it is stale: a new prompt (turn_start)
     * ends everything for that session; a tool running (activity) ends the permission questions
     * about that tool. The hook then prints nothing and the agent continues as normal.
     */
    supersede(ev) {
      let n = 0;
      for (const { ask } of [...open.values()]) {
        if (ask.agent !== ev.agent || ask.session !== ev.session) continue;
        const stale =
          ev.type === "turn_start" ||
          (ev.type === "activity" && ask.kind === "permission" && (!ev.tool || !ask.tool || ask.tool.toLowerCase() === String(ev.tool).toLowerCase()));
        if (stale && close(ask.id, null, "superseded")) n++;
      }
      return n;
    },

    list,
    get: (id) => (open.has(id) ? publicAsk(open.get(id).ask) : null),
    size: () => open.size,
    /** Cancel everything (shutdown). */
    closeAll() {
      for (const id of [...open.keys()]) close(id, null, "shutdown");
    },
  };
}
