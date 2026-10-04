// Turn an agent's final message into one spoken sentence, in the configured language.
import { apiKey } from "../config.mjs";
import { appClosed } from "../policy.mjs";
import { hosted, proToken } from "../pro.mjs";
import { langInstruction, SCRIPT } from "../i18n.mjs";
import { isDry, log, plainFirstSentence, redact } from "../util.mjs";

// OpenAI-compatible chat providers. Add one here to use another LLM for summaries.
export const LLMS = {
  openai: { url: "https://api.openai.com/v1/chat/completions", key: "OPENAI_API_KEY", model: (cfg) => cfg.summaryModel },
  // Electron returns 403 "not available for your plan" on some Smallest plans; the chain then falls back to OpenAI.
  smallest: { url: "https://api.smallest.ai/waves/v1/chat/completions", key: "SMALLEST_API_KEY", model: () => "electron" },
};

const SYSTEM =
  "You turn a coding agent's final message into ONE spoken sentence (max 18 words) for a developer who is away from the screen. " +
  "Say what got done, and if the agent is asking something or hit a problem, say that. No file paths, code, IDs, URLs, markdown or lists. ";

async function chat(provider, cfg, messages, fetch) {
  const p = LLMS[provider];
  const key = p && apiKey(cfg, p.key);
  if (!key) throw new Error(`no ${p ? p.key : provider}`);
  const res = await fetch(p.url, {
    method: "POST",
    signal: AbortSignal.timeout(cfg.summaryTimeoutMs),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: p.model(cfg), temperature: 0.3, max_tokens: 160, messages }),
  });
  if (!res.ok) throw new Error(`${provider} summary HTTP ${res.status}: ${redact((await res.text()).slice(0, 120))}`);
  const j = await res.json();
  return (j.choices?.[0]?.message?.content || "").trim().replace(/^["“]|["”]$/g, "");
}

/** @returns {Promise<{line: string, via: string, lang: string}>} */
export async function summarize(text, cfg, { fetch = globalThis.fetch } = {}) {
  text = redact(text); // secrets never leave the machine, even for a summary
  const fallback = { line: plainFirstSentence(text) || "Finished.", via: "first-sentence", lang: "en" };
  // "none": nothing leaves the machine; speak the agent's own first sentence.
  // App quit: nothing will be spoken, so nothing is sent anywhere either.
  if (isDry() || !text || cfg.summaryProvider === "none" || appClosed()) return fallback;
  const lang = cfg.speakLanguage || "en";
  // Pro: Earpiece's hosted summary first (same prompt, on Earpiece's key), then the user's own.
  if (proToken()) {
    try {
      const res = await hosted("summarize", { text: String(text).slice(-6000), instruction: langInstruction(lang) }, { fetch, timeoutMs: cfg.summaryTimeoutMs + 2000 });
      const line = redact(String((await res.json()).line || "").trim());
      if (line) return { line, via: "earpiece", lang: SCRIPT[lang] && !SCRIPT[lang].test(line) ? "en" : lang };
    } catch (e) {
      log({ warn: "summary_failed", provider: "earpiece", error: String(e?.message || e) });
    }
  }
  const order = [...new Set([cfg.summaryProvider, "openai"])].filter((n) => LLMS[n]);
  for (const provider of order) {
    try {
      let line = await chat(provider, cfg, [
        { role: "system", content: SYSTEM + langInstruction(lang) },
        { role: "user", content: String(text).slice(-6000) },
      ], fetch);
      if (!line) continue;
      line = redact(line);
      if (SCRIPT[lang] && !SCRIPT[lang].test(line)) {
        // Small models often answer in romanised Hindi. Ask once for a script rewrite.
        log({ warn: "summary_wrong_script", lang, provider, line });
        const fixed = await chat(provider, cfg, [
          { role: "system", content: `Rewrite the sentence exactly in meaning. ${langInstruction(lang)} Output only the sentence.` },
          { role: "user", content: line },
        ], fetch).catch(() => "");
        if (fixed && SCRIPT[lang].test(fixed)) return { line: fixed, via: `${provider}+rewrite`, lang };
        return { line, via: provider, lang: "en" }; // speak romanised text as English rather than garble it
      }
      return { line, via: provider, lang };
    } catch (e) {
      log({ warn: "summary_failed", provider, error: String(e?.message || e) });
    }
  }
  return fallback;
}
