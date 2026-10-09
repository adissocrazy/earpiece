// Hosted Talk routing for Earpiece Pro: which of your agents a spoken message is for, decided by Jev
// (TypeSafe AI's decision model) on our key. Jev only picks among the choices built here, so this
// can't be used as a general model proxy, and the app checks every answer against its own agents,
// apps and folders before acting on it.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CAP = 3000; // the monthly cap the other hosted functions use
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Keep in sync with the app's Talk router (jevRequest / fromJev).
const KEY = () => Deno.env.get("JEV_API_KEY") || Deno.env.get("TYPESAFE_API_KEY") || "";
const URL_FOR = (k: string) => (k.startsWith("jv_live_") ? "https://jevtypesafeai.com/api/v1/decide" : "https://api.typesafe.ai/v1/systemone");
const MODEL = "jev-1.13.0";
const MIN_P = 0.6;
const APP_P = 0.4; // the app is shown on the receipt (2 s, Esc), so a lower bar; below it, the default
const APPS: Record<string, string> = {
  "earpiece-claude": "Claude Code in an Earpiece terminal",
  "earpiece-codex": "Codex in an Earpiece terminal",
  "codex-app": "The Codex app",
  "claude-code-app": "Claude Code in the Claude desktop app",
  "claude-chat": "A chat in the Claude desktop app",
};
// What Jev reads for each app, option names included, so no "earpiece" (a project can be called that).
const APP_CRITERIA: Record<string, string> = {
  claude_cli: "Claude Code in a terminal: they say Claude or Claude Code, without 'app' or 'desktop'",
  codex_cli: "Codex in a terminal: they say Codex, without 'app'",
  codex_app: "The Codex desktop app: they say 'Codex app'",
  claude_desktop: "Claude Code inside the Claude desktop app: they say 'Claude desktop' or 'Claude app'",
  claude_chat: "A plain chat in the Claude desktop app, not coding in a folder: they say 'chat'",
};
const JEV_APP: Record<string, string> = { claude_cli: "earpiece-claude", codex_cli: "earpiece-codex", codex_app: "codex-app", claude_desktop: "claude-code-app", claude_chat: "claude-chat" };
const APP_JEV: Record<string, string> = Object.fromEntries(Object.entries(JEV_APP).map(([k, v]) => [v, k]));

type Agent = { id: string; agent: string; app: string; project: string; status: string; last: string };
type Answer = { choice?: string; probabilities?: Record<string, number>; noul?: number; probability?: number };

function jevRequest(text: string, agents: Agent[], folders: string[], defaultApp: string) {
  const criteria: Record<string, string> = {};
  agents.forEach((a, i) => (criteria[`a${i}`] = `${a.agent}${a.app ? ` (${a.app})` : ""} in the ${a.project || "unnamed"} project, ${a.status}. Its last message: ${a.last || "none"}`));
  criteria.none = "No listed agent clearly fits the message";
  const questions: Record<string, unknown> = {
    start_new: { type: "noul", instructions: "The developer asks to start, open or spin up something new (a new agent, task or chat), rather than talk to an agent that is already running." },
    target: {
      type: "choice",
      instructions: "Which of the developer's coding agents is this spoken message meant for? Match on project names, the agent's or app's name, and what each agent was last doing.",
      criteria,
    },
    intent: {
      type: "choice",
      instructions: "Is the developer giving the agent something to do, or asking about it?",
      criteria: {
        instruct: "Telling or answering the agent: a task, a reply, a yes or no, a change",
        status: "Asking what the agent is doing, did, or is waiting for, without giving it anything to do",
      },
    },
  };
  if (folders.length) {
    questions.app = { type: "choice", instructions: `If the developer asks to start something new, in which app? When they don't name one: ${APP_CRITERIA[APP_JEV[defaultApp]] || APP_CRITERIA.claude_cli}.`, criteria: APP_CRITERIA };
    questions.folder = { type: "choice", instructions: "If the developer asks to start something new, in which folder or project?", criteria: Object.fromEntries(folders.map((f, i) => [`f${i}`, f])) };
  }
  return { model: MODEL, state: { message: text }, questions };
}

const sure = (a?: Answer, floor = MIN_P) => Boolean(a?.choice) && (a!.probabilities?.[a!.choice!] ?? 0) >= floor;
const yes = (a?: Answer) => (a?.noul ?? a?.probability ?? 0) >= MIN_P;

function fromJev(j: { answers?: Record<string, Answer> }, text: string, agents: Agent[], folders: string[], defaultApp: string) {
  const out: { target: string | null; new: { app: string; folder: string } | null; status: boolean; message: string } = { target: null, new: null, status: false, message: text };
  const ans = j?.answers || {};
  if (yes(ans.start_new)) {
    const app = sure(ans.app, APP_P) && Object.hasOwn(JEV_APP, ans.app!.choice!) ? JEV_APP[ans.app!.choice!] : defaultApp;
    const fi = /^f(\d+)$/.exec(ans.folder?.choice || "")?.[1];
    const folder = sure(ans.folder) && fi != null ? folders[Number(fi)] : null;
    if (folder || app === "claude-chat") out.new = { app, folder: folder || "" };
    return out;
  }
  const t = ans.target;
  if (!sure(t)) return out;
  const ai = /^a(\d+)$/.exec(t!.choice!)?.[1];
  out.target = ai != null ? agents[Number(ai)]?.id ?? null : null;
  out.status = sure(ans.intent) && ans.intent!.choice === "status";
  return out;
}

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
  if (!s?.uid) return { res: json(401, { error: "sign in to use Talk" }) };
  if (!s.pro) return { res: json(402, { error: "Talk is part of Earpiece Pro" }) };
  if (s.lines >= CAP) return { res: json(429, { error: "monthly hosted limit reached" }) };
  return { uid: s.uid };
}

const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const [who, p] = await Promise.all([proUser(req), (req.json() as Promise<Record<string, unknown>>).catch(() => null)]);
  if ("res" in who) return who.res;
  if (!p || typeof p !== "object") return json(400, { error: "bad json" });
  const text = str(p.text, 1000).trim();
  if (!text) return json(400, { error: "text is required" });
  if (!KEY()) return json(502, { error: "router not configured" });
  // Only the fields the router needs, each cut short.
  const agents: Agent[] = (Array.isArray(p.agents) ? p.agents : []).slice(0, 20).map((a: Record<string, unknown>) => ({
    id: str(a?.id, 120),
    agent: str(a?.agent, 40),
    app: str(a?.app, 40),
    project: str(a?.project, 80),
    status: str(a?.status, 12),
    last: str(a?.last, 160),
  }));
  const folders = (Array.isArray(p.folders) ? p.folders : []).slice(0, 20).map((f: unknown) => str(f, 80)).filter(Boolean);
  const defaultApp = Object.hasOwn(APPS, str(p.defaultApp, 20)) ? str(p.defaultApp, 20) : "earpiece-claude";

  const res = await fetch(URL_FOR(KEY()), {
    method: "POST",
    signal: AbortSignal.timeout(4000),
    headers: { Authorization: `Bearer ${KEY()}`, "Content-Type": "application/json" },
    body: JSON.stringify(jevRequest(text, agents, folders, defaultApp)),
  }).catch(() => null);
  if (!res?.ok) return json(502, { error: "router unavailable" });
  const answer = fromJev(await res.json().catch(() => ({})), text, agents, folders, defaultApp);

  EdgeRuntime.waitUntil(Promise.resolve(admin.rpc("record_usage", { uid: who.uid, p_lines: 0, p_chars: 0, p_summaries: 1, p_fallbacks: 0 }))); // one decision, counted with summaries
  return json(200, answer);
});
