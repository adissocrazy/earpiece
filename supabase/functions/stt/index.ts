// Voice replies for Earpiece Pro: the card records a short clip (webm/opus) and this turns it into
// text with Earpiece's speech-to-text provider. The text goes back to the card, where you read it
// and press Enter yourself; nothing is sent to the agent from here. Counted per user per month.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CAP = 3000; // same monthly cap as hosted voice
const MAX_BYTES = 2_000_000; // ~2 minutes of opus; the card stops at 60 s
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// One round trip: PostgREST verifies the user's JWT and pro_status() reads the plan and this month's lines.
async function proUser(req: Request): Promise<{ uid: string } | { res: Response }> {
  const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc/pro_status`, {
    method: "POST",
    headers: { apikey: req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY")!, Authorization: req.headers.get("Authorization") || "", "Content-Type": "application/json" },
    body: "{}",
  }).catch(() => null);
  const s = r?.ok ? await r.json() : null;
  if (!s?.uid) return { res: json(401, { error: "sign in to use voice replies" }) };
  if (!s.pro) return { res: json(402, { error: "voice replies are part of Earpiece Pro" }) };
  if (s.lines >= CAP) return { res: json(429, { error: "monthly hosted limit reached" }) };
  return { uid: s.uid };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const [who, audio] = await Promise.all([proUser(req), req.arrayBuffer().catch(() => null)]);
  if ("res" in who) return who.res;
  if (!audio || audio.byteLength < 500) return json(400, { error: "no audio" });
  if (audio.byteLength > MAX_BYTES) return json(413, { error: "clip too long" });

  // The provider reads the format from the file name, so name it after the content type.
  const type = (req.headers.get("Content-Type") || "audio/webm").split(";")[0].trim();
  const ext: Record<string, string> = { "audio/webm": "webm", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/ogg": "ogg" };
  const form = new FormData();
  form.append("file", new Blob([audio], { type }), `reply.${ext[type] || "webm"}`);
  form.append("model", "gpt-4o-mini-transcribe");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}` },
    body: form,
  }).catch(() => null);
  if (!res?.ok) return json(502, { error: "speech-to-text unavailable" });
  const text = String((await res.json()).text || "").trim().slice(0, 4000);

  EdgeRuntime.waitUntil(Promise.resolve(admin.rpc("record_usage", { uid: who.uid, p_lines: 0, p_chars: 0, p_summaries: 0, p_fallbacks: 0, p_transcriptions: 1 })));
  return json(200, { text });
});
