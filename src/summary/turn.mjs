// Does a finished turn need you? Jev (TypeSafe AI's decision model) reads the agent's final message
// and picks one of three answers in about 0.3 s: it asks you something, it finished, or it's a
// progress note with nothing for you to do (shown on the card, not spoken). Pro asks Earpiece's
// hosted `classify` function (keep TURN in sync with app/supabase/functions/classify/index.ts);
// otherwise your own JEV_API_KEY / TYPESAFE_API_KEY. No key, an error or an unsure answer: the old
// rule, a question mark at the end.
// ponytail: the hub server (card) and the worker (voice) each classify the same turn, 2 calls at
// ~$0.00002. Share a cache in P.tmp if they ever disagree.
import { apiKey } from "../config.mjs";
import { endsWithQuestion } from "../hub/events.mjs";
import { appClosed } from "../policy.mjs";
import { hosted, proToken } from "../pro.mjs";
import { isDry, log, redact } from "../util.mjs";

const jevUrl = (key) => (String(key).startsWith("jv_live_") ? "https://jevtypesafeai.com/api/v1/decide" : "https://api.typesafe.ai/v1/systemone");
const MODEL = "jev-1.13.0"; // pinned, so the floor below doesn't drift with jev-latest
const MIN_P = 0.6; // below this Jev isn't sure: keep the old rule rather than silence a real question

export const TURN = {
  type: "choice",
  instructions: "A coding agent just ended its turn with this message. What does the developer, who is away from the screen, need to know?",
  criteria: {
    ask: "The agent asks the developer something or waits on a decision, approval or answer before it can go on",
    done: "The agent finished the work, or hit a problem it can't solve alone, and reports the result",
    progress: "A status note on work that is still going: a plan saved, a next step it is about to start, something running in the background. Nothing for the developer to do",
  },
};

const regex = (text) => (endsWithQuestion(text) ? "ask" : "done");

/** @returns {Promise<"ask"|"done"|"progress">} */
export async function classifyTurn(text, cfg, { fetch = globalThis.fetch } = {}) {
  text = redact(String(text || "")).slice(-4000);
  if (!text.trim() || isDry() || cfg.summaryProvider === "none" || appClosed()) return regex(text);
  try {
    let turn;
    if (proToken()) turn = (await (await hosted("classify", { text }, { fetch, timeoutMs: 3000 })).json()).turn;
    else {
      const key = apiKey(cfg, "JEV_API_KEY") || apiKey(cfg, "TYPESAFE_API_KEY");
      if (!key) return regex(text);
      const res = await fetch(jevUrl(key), {
        method: "POST",
        signal: AbortSignal.timeout(1500),
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, state: { message: text }, questions: { turn: TURN } }),
      });
      if (!res.ok) throw new Error(`jev HTTP ${res.status}`);
      const a = (await res.json())?.answers?.turn;
      if ((a?.probabilities?.[a?.choice] ?? 0) >= MIN_P) turn = a.choice;
    }
    if (Object.hasOwn(TURN.criteria, turn)) return turn;
  } catch (e) {
    log({ warn: "turn_classify_failed", error: String(e?.message || e) });
  }
  return regex(text);
}
