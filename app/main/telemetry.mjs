// Usage stats, so we can tell how many people run Earpiece and which features they use. A few
// times a day the app sends exactly what payload() returns: a random install id, the app and
// macOS versions, the CPU architecture, the locale, which agents are connected, and the feature
// settings and counts listed in features(). Never code, prompts, summaries, project names, paths
// or API keys. Anonymous unless you sign in, then linked to your account. Signed out: off with the
// General switch. Signed in: always on (signing out stops it). EARPIECE_TELEMETRY=0 always wins.
//
// No Electron imports here: main.mjs passes in what it needs, so the logic can be tested in Node.
import crypto from "node:crypto";

export const SUPABASE = "https://xqlcwdmgikqbicwvgfbj.supabase.co";
// Publishable key. It can only call the ping() function (one row per install per day) and the
// sign-in endpoints: it can't read, change or delete anything in the database.
export const KEY = "sb_publishable_EH82KH93ZvUQAN_yHprfAA_Y2dIbyVX";
export const ENDPOINT = `${SUPABASE}/rest/v1/rpc/ping`;
const FIRST_PING_MS = 30_000;
// The row for today is updated in place, so the last ping of the day carries the day's counts.
const PING_EVERY_MS = 6 * 3600_000;

export const enabled = (shareStats, env = process.env, signedIn = false) => env.EARPIECE_TELEMETRY !== "0" && (signedIn || shareStats !== false);

const num = (n) => (Number.isFinite(n) ? n : 0);
const word = (s) => (typeof s === "string" && /^[\w.-]{1,24}$/.test(s) ? s : null);

// Settings and today's counts, reduced to booleans, numbers and short ids. No free text.
export function features({ config: c = {}, prefs: p = {}, keys = [], stats: s = {} }) {
  const hasKey = (name) => keys.some((k) => k.name === name && k.set);
  return {
    answer_from_card: c.answerFromCard === true,
    show_card: p.showCard !== false,
    notch_icon: p.notchIcon === "updates" ? "updates" : "always",
    quiet_hours_on: Boolean(c.quietHours),
    announce_agent: c.announceAgent === true,
    language: word(c.speakLanguage) || "en",
    tts_first: word((c.ttsProviders || [])[0]),
    has_smallest_key: hasKey("SMALLEST_API_KEY"),
    has_openai_key: hasKey("OPENAI_API_KEY"),
    per_agent_voices: Object.values(c.agents || {}).filter((a) => a?.voice || a?.openaiVoice || a?.sayVoice).length,
    spoken_today: num(s.spoken),
    skipped_today: num(s.skipped),
    last_engine: word(s.lastSpoke?.engine),
    // Remote agents: counts and booleans only. Never names, titles, text or answers.
    remote_enabled: c.remote?.enabled === true,
    remote_agents: num(s.remoteAgents),
    remote_has_grokbot: s.remoteHasGrokbot === true,
    remote_has_dots: s.remoteHasDots === true,
    remote_has_openclaw: s.remoteHasOpenclaw === true,
    remote_has_hermes: s.remoteHasHermes === true,
    remote_has_custom: s.remoteHasCustom === true,
    remote_events_today: num(s.remoteEventsToday),
    remote_questions_today: num(s.remoteQuestionsToday),
    remote_answers_today: num(s.remoteAnswersToday),
    remote_transport: s.remoteTransport === "sse" || s.remoteTransport === "poll" ? s.remoteTransport : "off",
    remote_reconnects_today: num(s.remoteReconnectsToday),
  };
}

export const payload = ({ installId, version, osVersion, arch, locale, agents, features }) => ({
  install_id: installId,
  app_version: version,
  macos_version: osVersion,
  arch,
  locale,
  agents,
  features,
});

// getPrefs() → { shareStats, installId }; saveInstallId(id) persists a new id; info() → the rest;
// accessToken() → the signed-in user's token or null.
export function createTelemetry({ getPrefs, saveInstallId, info, accessToken = async () => null, fetch = globalThis.fetch }) {
  async function ping() {
    const p = getPrefs();
    const token = await accessToken().catch(() => null);
    if (!enabled(p.shareStats, process.env, Boolean(token))) return false;
    let installId = p.installId;
    if (!installId) saveInstallId((installId = crypto.randomUUID()));
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { apikey: KEY, "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
        body: JSON.stringify({ p: payload({ installId, ...info() }) }),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false; // offline or blocked: try again at the next interval, never bother the user
    }
  }

  return {
    ping,
    start() {
      setTimeout(ping, FIRST_PING_MS).unref?.();
      setInterval(ping, PING_EVERY_MS).unref?.();
    },
  };
}
