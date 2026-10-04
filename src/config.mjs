import fs from "node:fs";
import { P } from "./paths.mjs";
import { readJson, writeJson } from "./util.mjs";

export const DEFAULTS = {
  envFile: null, // path to a .env with SMALLEST_API_KEY / OPENAI_API_KEY
  ttsProviders: ["smallest", "openai", "say"], // tried in order until one speaks
  smallest: { model: "lightning_v3.1_pro", voice: "meher", speed: 1.0, sampleRate: 24000 },
  smallestTimeoutMs: 8000,
  speakLanguage: "en", // en | hinglish | hi | ta | mr | … (summaries are written in this language)
  summaryProvider: "openai", // openai | smallest (Electron; not on every Smallest plan) | none (first sentence, nothing sent)
  summaryModel: "gpt-4o-mini",
  summaryTimeoutMs: 6000,
  ttsModel: "gpt-4o-mini-tts",
  voice: "nova", // OpenAI voice
  voiceInstructions: "Calm, warm, quietly confident assistant. Brief and clear. Never excited.",
  ttsTimeoutMs: 15000,
  sayVoice: "Samantha", // macOS last resort; Hindi lines use Lekha
  minTurnSeconds: 30, // turns and `run` commands shorter than this stay silent
  maxChars: 200,
  // During quiet hours only the kinds in `allow` are spoken. allow: [] = total silence; null disables.
  quietHours: { start: "23:00", end: "08:00", allow: ["needs_input"] },
  chimes: true,
  // Approve/deny tool requests and reply to questions from the floating card. Off until you turn it
  // on: it installs blocking hooks (Claude Code, Codex) that wait for the card.
  answerFromCard: false,
  replyFromNotch: false, // a Reply on the card after every finished turn (see docs/answer-from-card.md)
  announceAgent: false, // prefix lines with the agent name ("Codex, checkout. …")
  // Per-agent overrides, keyed by adapter id:
  //   { "codex": { "voice": "sophie", "minTurnSeconds": 0 }, "claude-code": { "enabled": true } }
  // Supported keys: enabled, voice (Smallest voice id), model, openaiVoice, sayVoice, minTurnSeconds, label.
  agents: {},
};

export function config() {
  const user = readJson(P.config, {});
  return {
    ...DEFAULTS,
    ...user,
    smallest: { ...DEFAULTS.smallest, ...(user.smallest || {}) },
    agents: { ...(user.agents || {}) },
  };
}

// Merge a patch into config.json (one level deep for object keys).
export function updateConfig(patch) {
  const cur = readJson(P.config, {});
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    next[k] = v && typeof v === "object" && !Array.isArray(v) && cur[k] && typeof cur[k] === "object" ? { ...cur[k], ...v } : v;
  }
  writeJson(P.config, next);
  return next;
}

// Effective settings for one agent: global config with that agent's overrides applied.
export function agentConfig(cfg, agentId) {
  const o = (cfg.agents && cfg.agents[agentId]) || {};
  return {
    ...cfg,
    enabled: o.enabled !== false,
    label: o.label || null,
    minTurnSeconds: o.minTurnSeconds ?? cfg.minTurnSeconds,
    voice: o.openaiVoice || cfg.voice,
    sayVoice: o.sayVoice || cfg.sayVoice,
    smallest: { ...cfg.smallest, ...(o.voice ? { voice: o.voice } : {}), ...(o.model ? { model: o.model } : {}) },
  };
}

// Key lookup order: environment, then cfg.envFile, then ~/.earpiece/.env. Never logged.
export function apiKey(cfg, name = "OPENAI_API_KEY") {
  if (process.env[name]) return process.env[name];
  const re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)\\s*$`);
  for (const f of [cfg.envFile, P.env].filter(Boolean)) {
    try {
      for (const raw of fs.readFileSync(f, "utf8").split("\n")) {
        const m = raw.match(re);
        if (m) return m[1].replace(/^['"]|['"]$/g, "").trim() || null;
      }
    } catch {}
  }
  return null;
}
