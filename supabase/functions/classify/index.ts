// Hosted turn check for Earpiece Pro: does an agent's final message ask the developer something, report
// finished work, or note progress with nothing to do? Decided by Jev (TypeSafe AI's decision model) on
// our key. The question is fixed here, so this can't be used as a general model proxy.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CAP = 3000; // the monthly cap the other hosted functions use
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const KEY = () => Deno.env.get("JEV_API_KEY") || Deno.env.get("TYPESAFE_API_KEY") || "";
const URL_FOR = (k: string) => (k.startsWith("jv_live_") ? "https://jevtypesafeai.com/api/v1/decide" : "https://api.typesafe.ai/v1/systemone");
const MODEL = "jev-1.13.0";
const MIN_P = 0.6;

// Keep in sync with TURN in src/summary/turn.mjs.
const TURN = {
  type: "choice",
  instructions: "A coding agent just ended its turn with this message. What does the developer, who is away from the screen, need to know?",
  criteria: {
    ask: "The agent asks the developer something or waits on a decision, approval or answer before it can go on",
    done: "The agent finished the work, or hit a problem it can't solve alone, and reports the result",
    progress: "A status note on work that is still going: a plan saved, a next step it is about to start, something running in the background. Nothing for the developer to do",
  },
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Same check as summarize: signed in, Pro and under the cap → the user id.
async function proUser(req: Request): Promise<{ uid: string } | { res: Response }> {
  const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc/pro_status`, {
    method: "POST",
    headers: { apikey: req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY")!, Authorization: req.headers.get("Authorization") || "", "Content-Type": "application/json" },
    body: "{}",
  }).catch(() => null);
  const s = r?.ok ? await r.json() : null;
  if (!s?.uid) return { res: json(401, { error: "sign in to use hosted turn checks" }) };
  if (!s.pro) return { res: json(402, { error: "hosted turn checks are part of Earpiece Pro" }) };
  if (s.lines >= CAP) return { res: json(429, { error: "monthly hosted limit reached" }) };
  return { uid: s.uid };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const [who, p] = await Promise.all([proUser(req), (req.json() as Promise<Record<string, unknown>>).catch(() => null)]);
  if ("res" in who) return who.res;
  if (!p || typeof p !== "object") return json(400, { error: "bad json" });
  const text = typeof p.text === "string" ? p.text.slice(-4000) : "";
  if (!text.trim()) return json(400, { error: "text is required" });
  if (!KEY()) return json(502, { error: "classifier not configured" });

  const res = await fetch(URL_FOR(KEY()), {
    method: "POST",
    signal: AbortSignal.timeout(2500),
    headers: { Authorization: `Bearer ${KEY()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, state: { message: text }, questions: { turn: TURN } }),
  }).catch(() => null);
  if (!res?.ok) return json(502, { error: "classifier unavailable" });
  const a = (await res.json().catch(() => ({})))?.answers?.turn;
  // Unsure: null, and the app keeps its question-mark rule.
  const turn = a?.choice && Object.hasOwn(TURN.criteria, a.choice) && (a.probabilities?.[a.choice] ?? 0) >= MIN_P ? a.choice : null;

  EdgeRuntime.waitUntil(Promise.resolve(admin.rpc("record_usage", { uid: who.uid, p_lines: 0, p_chars: 0, p_summaries: 1, p_fallbacks: 0 }))); // one decision, counted with summaries
  return json(200, { turn });
});
