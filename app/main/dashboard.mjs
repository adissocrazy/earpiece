// Everything the main window reads and does. Runs in the main process; the renderer only gets
// plain data back, and never an API key.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const KEY_NAMES = ["SMALLEST_API_KEY", "OPENAI_API_KEY"];
const KINDS = ["done", "needs_input", "error", "info"];
const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;
const AGENT_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const VOICE_ID = /^[A-Za-z0-9_.-]{1,64}$/;
export const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];
const REPO = "adissocrazy/earpiece";

export const tidyPath = (p) => (p ? String(p).split(os.homedir()).join("~") : p);
const bad = (msg) => Object.assign(new Error(msg), { user: true });
const int = (v, lo, hi) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`expected a whole number from ${lo} to ${hi}`);
  return n;
};

// ---------- key files ----------

const keyLine = (name) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)\\s*$`);
function fileHasKey(file, name) {
  try {
    const re = keyLine(name);
    return fs.readFileSync(file, "utf8").split("\n").some((l) => {
      const m = l.match(re);
      return m && m[1].replace(/^['"]|['"]$/g, "").trim();
    });
  } catch {
    return false;
  }
}

// Rewrite one KEY=value line in a .env file (0600), leaving every other line as it was.
export function writeKey(file, name, value) {
  let lines = [];
  try {
    lines = fs.readFileSync(file, "utf8").split("\n");
  } catch {}
  const re = keyLine(name);
  lines = lines.filter((l) => !re.test(l));
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  if (value) lines.push(`${name}=${value}`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, lines.length ? lines.join("\n") + "\n" : "", { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

// ---------- log ----------

function tailLines(file, bytes = 384 * 1024) {
  try {
    const fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n");
    if (len < size) lines.shift(); // partial first line
    return lines.filter(Boolean);
  } catch {
    return [];
  }
}

const SKIP_LABEL = {
  duplicate: "said the same thing under a minute ago",
  forwarded_echo: "echo from a chained Codex notify",
  mode_off: "Earpiece was off",
  mode_quiet: "Quiet mode",
  quiet_hours: "quiet hours",
  flushed: "cleared by Stop",
  stale: "waited too long for the speaker",
  resolved: "you already answered it",
  busy: "speaker was busy",
  stopped: "stopped",
  voice_failed: "no voice answered in time",
  short_turn: "turn was shorter than the minimum",
  agent_disabled: "agent is muted",
  already_spoke: "already announced",
  empty: "nothing to say",
};

export function friendlyLog(lines, redact = (s) => s) {
  const out = [];
  for (const raw of lines) {
    let e;
    try {
      e = JSON.parse(raw);
    } catch {
      continue;
    }
    const at = Date.parse(e.t) || 0;
    const who = [e.agent, e.project].filter(Boolean).join(" · ");
    let row;
    if (e.spoke) row = { kind: "spoke", text: e.spoke, detail: [e.engine, e.ms ? `${(e.ms / 1000).toFixed(1)} s` : null, e.via].filter(Boolean).join(" · ") };
    else if (e.skipped) row = { kind: "skipped", text: e.line || SKIP_LABEL[e.skipped] || e.skipped, detail: `Skipped: ${SKIP_LABEL[e.skipped] || e.skipped}` };
    else if (e.warn) row = { kind: "warn", text: e.warn === "tts_failed" ? `${e.engine} couldn't speak` : e.warn === "summary_failed" ? `${e.provider} summary failed` : e.warn.replace(/_/g, " "), detail: e.error || "" };
    else if (e.error) row = { kind: "error", text: String(e.error).split("\n")[0].slice(0, 200), detail: "" };
    else if (e.hub) row = { kind: "hub", text: e.hub === "listening" ? "Hub started" : `Hub ${e.hub}`, detail: "" };
    else continue;
    row.text = redact(row.text);
    row.detail = redact(tidyPath(row.detail));
    row.who = who;
    row.at = at;
    const prev = out.at(-1);
    // A stuck loop can write the same line a thousand times; show it once with a count.
    if (prev && prev.kind === row.kind && prev.text === row.text && prev.who === row.who) {
      prev.count = (prev.count || 1) + 1;
      prev.at = at;
    } else out.push(row);
  }
  return out;
}

// ---------- dashboard ----------

export function createDashboard({ app, dialog, shell, lib, core, state, hookStatus, connect, disconnect, refresh, prefs, updater, auth, account, syncAccount, openBilling }) {
  const voiceCache = new Map();
  let sayVoices = null;

  function keyStatus() {
    const cfg = lib.config();
    return KEY_NAMES.map((name) => {
      const sources = [];
      if (process.env[name]) sources.push({ id: "env", label: "Environment variable" });
      if (cfg.envFile && fileHasKey(cfg.envFile, name)) sources.push({ id: "envFile", label: tidyPath(cfg.envFile) });
      if (fileHasKey(lib.P.env, name)) sources.push({ id: "app", label: tidyPath(lib.P.env) });
      return {
        name,
        set: sources.length > 0,
        source: sources[0] || null,
        // Saved in the app's file, but another source wins (see apiKey() lookup order).
        shadowed: sources.length > 1 && sources.some((s) => s.id === "app") && sources[0].id !== "app",
      };
    });
  }

  function stats() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const s = { spoken: 0, skipped: 0, failed: 0, lastSpoke: null };
    for (const raw of tailLines(lib.P.log)) {
      let e;
      try {
        e = JSON.parse(raw);
      } catch {
        continue;
      }
      const at = Date.parse(e.t) || 0;
      if (e.spoke) s.lastSpoke = { text: lib.redact(e.spoke), at, engine: e.engine };
      if (at < today.getTime()) continue;
      if (e.spoke) s.spoken++;
      else if (e.skipped && e.skipped !== "forwarded_echo") s.skipped++;
      else if (e.warn || e.error) s.failed++;
    }
    return s;
  }

  const AGENT_INFO = {
    "claude-code": { how: "Hooks in ~/.claude/settings.json", note: "Terminal Claude Code, and the Code tab in Claude Desktop if it runs your hooks." },
    codex: { how: "notify in ~/.codex/config.toml", note: "Codex CLI. An existing notify command keeps working." },
    "claude-desktop": {
      how: "MCP server in claude_desktop_config.json",
      note: "Chats and Cowork. Claude calls an earpiece_notify tool when it finishes real work or needs you, and writes the line itself. Quit and reopen Claude Desktop after connecting.",
    },
  };

  function agents() {
    const cfg = lib.config();
    const hooks = hookStatus();
    const known = hooks.map((h) => ({
      ...h,
      ...(AGENT_INFO[h.id] || {}),
      file: tidyPath(lib.getAdapter(h.id).configFile?.()),
      settings: cfg.agents[h.id] || {},
    }));
    // Agents that talk through `earpiece emit` show up once they've sent something.
    const seen = new Set(known.map((a) => a.id));
    const others = [...new Set(lib.listSessions({}).map((s) => s.agent))]
      .filter((id) => !seen.has(id))
      .map((id) => ({ id, name: lib.getAdapter(id).name, target: "emit", present: true, how: "earpiece emit", settings: cfg.agents[id] || {} }));
    return [...known, ...others];
  }

  function settings() {
    const c = lib.config();
    return {
      ttsProviders: c.ttsProviders,
      smallest: c.smallest,
      speakLanguage: c.speakLanguage,
      summaryProvider: c.summaryProvider,
      voice: c.voice,
      sayVoice: c.sayVoice,
      minTurnSeconds: c.minTurnSeconds,
      chimes: c.chimes,
      announceAgent: c.announceAgent,
      quietHours: c.quietHours,
      envFile: tidyPath(c.envFile),
    };
  }

  async function data() {
    const { listEngines } = await core("src/voice/engines/index.mjs");
    const { LANG_NAMES } = await core("src/i18n.mjs");
    return {
      ...state(),
      settings: settings(),
      agents: agents(),
      keys: keyStatus(),
      stats: stats(),
      account: account(),
      prefs: { showInDock: prefs.get().showInDock !== false, showCard: prefs.get().showCard !== false, notch: prefs.get().notch || "auto", notchIcon: prefs.get().notchIcon === "updates" ? "updates" : "always", answerFromCard: lib.config().answerFromCard === true, replyFromNotch: lib.config().replyFromNotch === true, shareStats: prefs.get().shareStats !== false, hideSignInNudge: prefs.get().hideSignInNudge === true, openAtLogin: app.getLoginItemSettings().openAtLogin },
      engines: listEngines().map((e) => ({ id: e.id, label: e.label || e.id, keyName: e.keyName || null })),
      languages: [["en", "English"], ["hinglish", "Hinglish"], ...Object.entries(LANG_NAMES)],
      openaiVoices: OPENAI_VOICES,
      home: tidyPath(lib.HOME),
      platform: process.platform,
    };
  }

  // ----- settings writes: every field is checked here, the renderer is not trusted -----

  async function setConfig(patch = {}) {
    const { listEngines } = await core("src/voice/engines/index.mjs");
    const { MODELS } = await core("src/voice/engines/smallest.mjs");
    const { isKnownLang } = await core("src/i18n.mjs");
    const cur = lib.config();
    const out = {};
    for (const [k, v] of Object.entries(patch)) {
      switch (k) {
        case "ttsProviders": {
          const ids = listEngines().map((e) => e.id);
          if (!Array.isArray(v) || !v.length || v.some((x) => !ids.includes(x)) || new Set(v).size !== v.length) throw bad("pick at least one voice provider");
          out.ttsProviders = v;
          break;
        }
        case "smallest": {
          const s = { ...cur.smallest };
          if ("voice" in v) {
            if (!VOICE_ID.test(v.voice)) throw bad("bad voice id");
            s.voice = v.voice;
          }
          if ("model" in v) {
            if (!MODELS.includes(v.model)) throw bad("unknown model");
            s.model = v.model;
          }
          if ("speed" in v) {
            const n = Number(v.speed);
            if (!(n >= 0.5 && n <= 2)) throw bad("speed must be 0.5 to 2");
            s.speed = Math.round(n * 100) / 100;
          }
          out.smallest = s;
          break;
        }
        case "speakLanguage":
          if (!isKnownLang(v)) throw bad("unknown language");
          out.speakLanguage = v;
          break;
        case "summaryProvider":
          if (!["openai", "smallest", "none"].includes(v)) throw bad("unknown summary provider");
          out.summaryProvider = v;
          break;
        case "voice":
          if (!OPENAI_VOICES.includes(v)) throw bad("unknown OpenAI voice");
          out.voice = v;
          break;
        case "sayVoice":
          if (typeof v !== "string" || !/^[\w .()'-]{1,40}$/.test(v)) throw bad("bad macOS voice name");
          out.sayVoice = v;
          break;
        case "minTurnSeconds":
          out.minTurnSeconds = int(v, 0, 3600);
          break;
        case "chimes":
        case "announceAgent":
          out[k] = Boolean(v);
          break;
        case "quietHours": {
          if (v === null) {
            out.quietHours = null;
            break;
          }
          if (!HHMM.test(v.start) || !HHMM.test(v.end)) throw bad("times look like 23:00");
          const allow = Array.isArray(v.allow) ? v.allow : [];
          if (allow.some((x) => !KINDS.includes(x))) throw bad("unknown ping kind");
          out.quietHours = { start: v.start, end: v.end, allow };
          break;
        }
        default:
          throw bad(`unknown setting ${k}`);
      }
    }
    // quietHours and smallest are complete objects; replace rather than merge.
    const file = lib.readJson(lib.P.config, {});
    lib.writeJson(lib.P.config, { ...file, ...out });
    refresh();
    return settings();
  }

  function setAgent(id, patch = {}) {
    if (!AGENT_ID.test(String(id))) throw bad("bad agent id");
    const file = lib.readJson(lib.P.config, {});
    const cur = { ...((file.agents || {})[id] || {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (k === "enabled") cur.enabled = Boolean(v);
      else if (k === "label") {
        const s = String(v ?? "").trim();
        if (s.length > 40) throw bad("label is too long");
        if (s) cur.label = s;
        else delete cur.label;
      } else if (k === "voice") {
        const s = String(v ?? "").trim();
        if (s && !VOICE_ID.test(s)) throw bad("bad voice id");
        if (s) cur.voice = s;
        else delete cur.voice;
        if (patch.model) cur.model = patch.model;
        if (!s) delete cur.model;
      } else if (k === "model") continue;
      else if (k === "minTurnSeconds") {
        if (v === null || v === "") delete cur.minTurnSeconds;
        else cur.minTurnSeconds = int(v, 0, 3600);
      } else throw bad(`unknown agent setting ${k}`);
    }
    if (cur.enabled === true) delete cur.enabled; // enabled is the default
    const agentsMap = { ...(file.agents || {}) };
    if (Object.keys(cur).length) agentsMap[id] = cur;
    else delete agentsMap[id];
    lib.writeJson(lib.P.config, { ...file, agents: agentsMap });
    refresh();
    return agents();
  }

  // ----- voices -----

  async function voices(model) {
    const { fetchVoices, MODELS } = await core("src/voice/engines/smallest.mjs");
    if (!MODELS.includes(model)) throw bad("unknown model");
    const hit = voiceCache.get(model);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.list;
    const list = await fetchVoices(lib.config(), model);
    voiceCache.set(model, { at: Date.now(), list });
    return list;
  }

  async function macVoices() {
    if (process.platform !== "darwin") return [];
    if (sayVoices) return sayVoices;
    sayVoices = await new Promise((resolve) =>
      execFile("say", ["-v", "?"], { timeout: 5000 }, (err, out) =>
        resolve(
          err
            ? []
            : String(out)
                .split("\n")
                .map((l) => l.match(/^(.+?)\s{2,}([a-z]{2}[_-][A-Z]{2})/))
                .filter(Boolean)
                .map((m) => ({ name: m[1].trim(), locale: m[2] })),
        ),
      ),
    );
    return sayVoices;
  }

  // Play a sample in one engine and voice without saving anything.
  async function preview({ engine = "smallest", voiceId, model, openaiVoice, sayVoice } = {}) {
    const { getEngine } = await core("src/voice/engines/index.mjs");
    const { playBuffer } = await core("src/voice/play.mjs");
    const { phrase } = await core("src/i18n.mjs");
    const e = getEngine(engine);
    if (!e) throw bad("unknown engine");
    const base = lib.config();
    const cfg = { ...base, smallest: { ...base.smallest } };
    if (voiceId) {
      if (!VOICE_ID.test(voiceId)) throw bad("bad voice id");
      cfg.smallest.voice = voiceId;
    }
    if (model) cfg.smallest.model = model;
    if (openaiVoice) {
      if (!OPENAI_VOICES.includes(openaiVoice)) throw bad("unknown OpenAI voice");
      cfg.voice = openaiVoice;
    }
    if (sayVoice) cfg.sayVoice = String(sayVoice).slice(0, 40);
    const ph = phrase(cfg, "test");
    lib.stopSpeaking();
    await e.speak(ph.text, { cfg, lang: ph.lang, playBuffer });
    return { ok: true };
  }

  // ----- keys -----

  function setKey(name, value) {
    if (!KEY_NAMES.includes(name)) throw bad("unknown key");
    const v = String(value ?? "").trim().replace(/^['"]|['"]$/g, "");
    if (v && (v.length < 8 || v.length > 400 || /\s/.test(v))) throw bad("that doesn't look like an API key");
    writeKey(lib.P.env, name, v);
    voiceCache.clear();
    return keyStatus();
  }

  async function testKey(name) {
    if (!KEY_NAMES.includes(name)) throw bad("unknown key");
    const key = lib.apiKey(lib.config(), name);
    if (!key) return { ok: false, message: "Not set" };
    const url = name === "OPENAI_API_KEY" ? "https://api.openai.com/v1/models" : "https://api.smallest.ai/waves/v1/lightning-v3.1/get_voices";
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
      if (res.ok) return { ok: true, message: "Works" };
      return { ok: false, message: res.status === 401 ? "Rejected (401): check the key" : `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, message: `Couldn't reach the API (${e.name === "TimeoutError" ? "timeout" : "network"})` };
    }
  }

  async function chooseEnvFile(win) {
    const r = await dialog.showOpenDialog(win, {
      title: "Choose a .env file with your API keys",
      properties: ["openFile", "showHiddenFiles"],
      defaultPath: os.homedir(),
    });
    if (r.canceled || !r.filePaths[0]) return keyStatus();
    lib.updateConfig({ envFile: r.filePaths[0] });
    voiceCache.clear();
    return keyStatus();
  }

  const OPENABLE = {
    log: () => lib.P.log,
    config: () => lib.P.config,
    home: () => lib.HOME,
    envFile: () => lib.config().envFile,
  };

  // The one entry point for renderer actions.
  async function action(win, name, a = {}) {
    switch (name) {
      case "data":
        return data();
      case "activity":
        return friendlyLog(tailLines(lib.P.log), lib.redact).slice(-Math.min(Number(a.limit) || 200, 500)).reverse();
      case "setConfig":
        return setConfig(a.patch);
      case "setAgent":
        return setAgent(a.id, a.patch);
      case "connect":
        return connect(a.id);
      case "disconnect":
        return disconnect(a.id);
      case "voices":
        return voices(a.model);
      case "macVoices":
        return macVoices();
      case "preview":
        return preview(a);
      case "setKey":
        return setKey(a.name, a.value);
      case "clearKey":
        return setKey(a.name, "");
      case "testKey":
        return testKey(a.name);
      case "chooseEnvFile":
        return chooseEnvFile(win);
      case "clearEnvFile":
        lib.updateConfig({ envFile: null });
        voiceCache.clear();
        return keyStatus();
      case "signIn":
        return auth.signIn();
      case "upgrade":
        return openBilling({ action: "checkout", interval: a.interval === "year" ? "year" : "month" });
      case "manageBilling":
        return openBilling({ action: "portal" });
      case "signOut":
        return auth.signOut().then(syncAccount);
      case "setPref":
        return prefs.set(a.key, a.value);
      case "checkUpdate":
        return updater.check();
      case "installUpdate":
        return updater.install();
      case "downloadUpdate":
        return updater.openDownload();
      case "openUrl":
        if (a.url !== `https://github.com/${REPO}/releases` && !String(a.url).startsWith(`https://github.com/${REPO}/releases/`)) throw bad("not allowed");
        return shell.openExternal(a.url);
      case "open": {
        const p = OPENABLE[a.what]?.();
        if (!p) throw bad("nothing to open");
        return a.reveal ? shell.showItemInFolder(p) : shell.openPath(p);
      }
      default:
        throw bad(`unknown action ${name}`);
    }
  }

  return { action, data, keyStatus, stats };
}
