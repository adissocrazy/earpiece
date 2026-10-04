// Command-line interface. Every entry point (bin/earpiece.mjs, the legacy ./jarvis.mjs,
// ./install.mjs) ends up in main().
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { getAdapter, listAdapters } from "../adapters/index.mjs";
import { agentConfig, apiKey, config, updateConfig } from "../config.mjs";
import { ASK_CURL_TIMEOUT_SEC } from "../hub/asks.mjs";
import { EVENT_TYPES, normalizeEvent } from "../hub/events.mjs";
import { handleCodex } from "../hub/entry.mjs";
import { ingest, ingestEvent, runWorker } from "../hub/hub.mjs";
import { startHubServer } from "../hub/server.mjs";
import { stopSpeaking } from "../control.mjs";
import { writeShim } from "../shim.mjs";
import { cmdDoctor } from "./doctor.mjs";
import { betterOrigin, describeOrigin, jumpPrecision, rawFromEnv, resolveOrigin } from "../hub/origin.mjs";
import { jumpPlan, jumpTo, resolveTarget } from "../hub/jump.mjs";
import { listSessions, updateSession } from "../hub/sessions.mjs";
import { isKnownLang, LANG_NAMES, langLabel, phrase } from "../i18n.mjs";
import { BIN, HOME, P, ROOT } from "../paths.mjs";
import { currentMode, inQuietHours, QUIET_ALLOW_DEFAULT, setMode } from "../policy.mjs";
import { ago, ensureDirs, log, now, parseFlags, projectName, readJson, which } from "../util.mjs";
import { listEngines } from "../voice/engines/index.mjs";
import { fetchVoices, findVoice } from "../voice/engines/smallest.mjs";
import { speak } from "../voice/speak.mjs";

const pkg = readJson(path.join(ROOT, "package.json"), {});

export const HELP = `earpiece ${pkg.version || ""} — spoken pings for terminal coding agents

Setup
  earpiece install [--only claude-code,codex,claude-desktop] [--chain] [--env path/.env] [--hub | --node]
                                        hooks already set by the Mac app stay on the app (--node overrides)
  earpiece env <path/.env>              where API keys are read from (the app uses this too)
  earpiece uninstall
  earpiece test [--provider smallest|openai|say] [--agent id]

Agents
  earpiece agents [--all] [--json]      every agent session Earpiece has seen, and its state
  earpiece where [--here] [--refresh]   which terminal, tab and tmux pane each agent runs in (--here: this shell)
  earpiece jump [n] [--dry-run]         bring forward the window of the nth most recent session (default 1)
  earpiece emit --agent <id> --type <type> [--session s] [--project p] [--tool t] [--message m] [--wait] [text…]
                                        send an event from any tool (JSON on stdin also works);
                                        returns at once unless run in a terminal or with --wait
                                        types: ${EVENT_TYPES.join(", ")}
  earpiece run -- <cmd …>               run a command, speak when a long one finishes

Voice
  earpiece say "text" [--kind done|needs_input|error|info] [--provider id] [--lang code]
  earpiece voices [--gender female] [--accent indian] [--lang hi] [--std]
  earpiece voice <id> [--agent id]      pick a Smallest voice (globally or for one agent)
  earpiece lang <code>                  en | hinglish | hi | ta | mr | es | …

Control
  earpiece quiet [minutes]              no voice, updates still show on screen (default 60 min)
  earpiece off [minutes]                silence everything (default: until \`on\`)
  earpiece on
  earpiece stop                         stop talking now and drop every queued line
  earpiece serve                        run the hub in the foreground (what the desktop app does)
                                        (install with --hub so hooks send to it)
  earpiece quiet-hours [23:00-08:00] [--silent | --allow needs_input,error] [off]
                                        nightly window; by default only "needs you" pings get through
  earpiece answers on|off               approve/deny tool requests and reply to questions from the
                                        floating card (Claude Code, Codex; needs the app or \`serve\`)
  earpiece status
  earpiece doctor                      check every hook and config points at this copy, the hub and keys

Agent entry points (written by \`earpiece install\`)
  earpiece hook [adapter]               Claude Code hooks (payload on stdin)
  earpiece ask [adapter]                blocking hook that waits for the card (only with \`answers on\`)
  earpiece codex '<json>'               Codex CLI notify (payload as last argument)
  earpiece mcp                          MCP server for Claude Desktop (stdio)
`;

// Hooks pipe a small payload and close stdin. The timeout covers callers that leave it open.
async function readStdin(timeoutMs = 3000) {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve) => {
    let data = "";
    const done = () => {
      clearTimeout(timer);
      process.stdin.pause();
      resolve(data);
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

const parseJson = (s) => {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
};

const pad = (s, n) => String(s ?? "").slice(0, n - 1).padEnd(n);

// ---------- commands ----------

async function cmdEmit(rest) {
  const { flags, words } = parseFlags(rest, ["agent", "type", "session", "project", "tool", "message", "line", "cwd", "duration"]);
  let ev = {};
  if (!process.stdin.isTTY && !flags.type) ev = parseJson(await readStdin(1000));
  const agent = flags.agent || ev.agent || "cli";
  ev = {
    ...ev,
    agent,
    type: flags.type || ev.type || "info",
    cwd: flags.cwd || ev.cwd || process.cwd(),
    ...(flags.session ? { session: flags.session } : {}),
    ...(flags.project ? { project: flags.project } : {}),
    ...(flags.tool ? { tool: flags.tool } : {}),
    ...(flags.message ? { message: flags.message } : {}),
    ...(flags.line ? { line: flags.line } : {}),
    ...(flags.duration ? { durationMs: Number(flags.duration) * 1000 } : {}),
  };
  if (words.length) ev.text = words.join(" ");
  if (!EVENT_TYPES.includes(ev.type)) {
    process.exitCode = 2;
    return console.error(`earpiece: unknown --type "${ev.type}" (expected ${EVENT_TYPES.join(", ")})`);
  }
  // `emit` takes hub-shaped events (no adapter translation), even for agents that have an adapter.
  // From a terminal it waits and prints the line; from a hook or script it hands off to the
  // background worker and returns at once. --wait / --background override.
  const interactive = Boolean(process.stdout.isTTY);
  if (interactive) process.env.EARPIECE_ECHO = "1";
  const foreground = flags.wait ? true : flags.background ? false : interactive || process.env.EARPIECE_FOREGROUND === "1";
  return ingestEvent(normalizeEvent(ev, agent), { foreground });
}

async function cmdRun(rest) {
  const args = rest[0] === "--" ? rest.slice(1) : rest;
  if (!args.length) return console.error("usage: earpiece run -- <command …>");
  const cfg = agentConfig(config(), "run");
  const start = now();
  const r = spawnSync(args[0], args.slice(1), { stdio: "inherit" });
  const durationMs = now() - start;
  const code = r.status ?? 1;
  const label = args.slice(0, 2).map((a) => path.basename(a)).join(" ");
  const project = projectName(process.cwd());
  const ph = phrase(cfg, code === 0 ? "runOk" : "runFail", project, label);
  if (durationMs >= cfg.minTurnSeconds * 1000) {
    if (process.stdout.isTTY) process.env.EARPIECE_ECHO = "1";
    await ingestEvent(normalizeEvent({
      agent: "run",
      type: code === 0 ? "turn_end" : "error",
      session: `${project}:${label}`,
      project,
      cwd: process.cwd(),
      line: ph.text,
      lang: ph.lang,
      durationMs,
    }), { foreground: true });
  }
  process.exitCode = code;
}

async function cmdVoices(rest) {
  const { flags } = parseFlags(rest, ["lang", "gender", "accent"]);
  const cfg = config();
  const model = flags.std ? "lightning_v3.1" : "lightning_v3.1_pro";
  let vs = await fetchVoices(cfg, model);
  if (flags.lang) {
    const want = (LANG_NAMES[flags.lang === "hinglish" ? "hi" : flags.lang] || flags.lang).toLowerCase();
    vs = vs.filter((v) => v.tags.language.includes(want));
  }
  if (flags.gender) vs = vs.filter((v) => v.tags.gender.toLowerCase() === String(flags.gender).toLowerCase());
  if (flags.accent) vs = vs.filter((v) => v.tags.accent.toLowerCase().includes(String(flags.accent).toLowerCase()));
  console.log(`${model}: ${vs.length} voices${vs.length ? "" : " (try without filters, or --std)"}\n`);
  console.log(" " + pad("id", 13) + pad("gender", 8) + pad("accent", 12) + pad("age", 12) + "languages");
  for (const v of vs)
    console.log(
      (v.voiceId === cfg.smallest.voice ? "*" : " ") + pad(v.voiceId, 13) + pad(v.tags.gender, 8) + pad(v.tags.accent, 12) + pad(v.tags.age, 12) + v.tags.language.join(", "),
    );
  console.log(`\n* = current. Set with: earpiece voice <id> [--agent codex]`);
}

async function cmdVoice(rest) {
  const { flags, words } = parseFlags(rest, ["agent"]);
  const id = words[0];
  const cfg = config();
  if (!id) {
    console.log(`voice: ${cfg.smallest.voice} (${cfg.smallest.model})`);
    for (const [a, o] of Object.entries(cfg.agents)) if (o.voice) console.log(`  ${a}: ${o.voice}${o.model ? ` (${o.model})` : ""}`);
    return;
  }
  const v = await findVoice(cfg, id);
  if (!v) {
    process.exitCode = 1;
    return console.error(`earpiece: no Smallest voice "${id}". See: earpiece voices --gender female`);
  }
  if (flags.agent) updateConfig({ agents: { [flags.agent]: { ...(cfg.agents[flags.agent] || {}), voice: id, model: v.model } } });
  else updateConfig({ smallest: { ...cfg.smallest, voice: id, model: v.model } });
  console.log(`earpiece: ${flags.agent ? `${flags.agent} voice` : "voice"} → ${id} (${v.model}; ${v.tags.gender} ${v.tags.accent}; ${v.tags.language.join(", ")})`);
  console.log(`  hear it: earpiece test${flags.agent ? ` --agent ${flags.agent}` : ""}`);
}

async function cmdLang(rest) {
  const code = (rest[0] || "").toLowerCase();
  if (!code) return console.log(`speakLanguage: ${config().speakLanguage}   (en | hinglish | hi | ta | mr | kn | …)`);
  if (!isKnownLang(code)) {
    process.exitCode = 1;
    return console.error(`earpiece: unknown language "${code}". Try en, hinglish, hi, ta, te, kn, ml, mr, gu, bn, pa, or, es, fr, de …`);
  }
  updateConfig({ speakLanguage: code });
  const cfg = config();
  console.log(`earpiece: summaries now spoken in ${langLabel(code)}`);
  if (code !== "en" && code !== "hinglish" && apiKey(cfg, "SMALLEST_API_KEY")) {
    const v = (await fetchVoices(cfg, cfg.smallest.model).catch(() => [])).find((x) => x.voiceId === cfg.smallest.voice);
    const want = (LANG_NAMES[code] || "").toLowerCase();
    if (v && want && !v.tags.language.includes(want))
      console.log(`  ! voice "${cfg.smallest.voice}" isn't trained on ${LANG_NAMES[code]}. Pick one: earpiece voices --lang ${code}`);
  }
}

function cmdAgents(rest) {
  const { flags } = parseFlags(rest, []);
  const sessions = listSessions({ sinceMs: flags.all ? null : 24 * 3600_000 });
  if (flags.json) return console.log(JSON.stringify(sessions, null, 2));
  if (!sessions.length)
    return console.log(`No agent activity${flags.all ? "" : " in the last 24 h"}. Run \`earpiece install\`, then start Claude Code or Codex.`);
  const icon = { working: "●", waiting: "◆", done: "✓", error: "✗", idle: "○" };
  console.log(pad("STATUS", 10) + pad("AGENT", 14) + pad("PROJECT", 22) + pad("AGE", 6) + "LAST");
  for (const s of sessions) {
    const name = agentConfig(config(), s.agent).label || getAdapter(s.agent).name;
    const st = s.status || "idle";
    console.log(
      pad(`${icon[st] || " "} ${st}`, 10) + pad(name, 14) + pad(s.project || projectName(s.cwd), 22) + pad(ago(now() - (s.updated || 0)), 6) + (s.lastLine || "").slice(0, 70),
    );
  }
  const waiting = sessions.filter((s) => s.status === "waiting").length;
  const working = sessions.filter((s) => s.status === "working").length;
  console.log(`\n${working} working, ${waiting} waiting on you, ${sessions.length} total`);
}

const EDITOR_WHY = { window: "the window opened at this folder", "window-root": "the window whose root holds this folder", "repo-root": "this repo root" };

// What a click on the card does, from the command line: handy to check each terminal setup.
async function cmdJump(rest) {
  const { flags, words } = parseFlags(rest, ["agent"]);
  let sessions = listSessions({ sinceMs: 24 * 3600_000 });
  if (flags.agent) sessions = sessions.filter((s) => s.agent === flags.agent);
  const n = Math.max(Number(words[0]) || 1, 1);
  const s = sessions[n - 1];
  if (!s) {
    process.exitCode = 1;
    return console.error("earpiece: no such session in the last 24 h. See `earpiece agents`.");
  }
  const target = { agent: s.agent, origin: s.origin || null, cwd: s.cwd || null };
  const label = `${agentConfig(config(), s.agent).label || getAdapter(s.agent).name} · ${s.project || projectName(s.cwd)}`;
  if (flags["dry-run"]) {
    const t = resolveTarget(target);
    const steps = jumpPlan(t);
    console.log(`${label}: ${steps.length ? steps.map((x) => `${x.how} (${x.precision}${x.why ? `, ${x.why}` : ""})`).join(", then ") : "nowhere to go"}`);
    if (t.note === "folder-missing") console.log(`  the session's folder is gone: ${target.cwd}`);
    if (t.editorWindows) {
      console.log(`  folder: ${t.cwd || target.cwd || "unknown"}`);
      console.log(`  editor windows found: ${t.editorWindows.length ? "" : "none"}`);
      for (const w of t.editorWindows) console.log(`    ${w.open}${w.folders.length > 1 || w.folders[0] !== w.open ? ` (${w.folders.join(", ")})` : ""}`);
      console.log(`  opens: ${t.editorTarget ? `${t.editorTarget.open} (${EDITOR_WHY[t.editorTarget.why] || t.editorTarget.why})` : "nothing, the editor just comes forward (no open window holds this folder)"}`);
    }
    return;
  }
  const r = await jumpTo(target);
  if (r.ok) console.log(`${label}: opened the ${r.precision === "app" ? "app" : r.precision}${r.note === "folder-missing" ? " (the session's folder is gone)" : ""}`);
  else {
    process.exitCode = 1;
    console.error(`earpiece: couldn't open ${label}${r.error ? `: ${r.error}` : ""}`);
  }
}

// Which terminal is each agent in? `--here` shows what Earpiece sees from the shell you run it in,
// which is the quickest way to check the detection for a terminal setup.
async function cmdWhere(rest) {
  const { flags } = parseFlags(rest, []);
  if (flags.here) {
    const raw = rawFromEnv();
    if (!raw) return console.log("earpiece: couldn't read this shell's process id.");
    const o = await resolveOrigin(raw, { agent: "" });
    if (flags.json) return console.log(JSON.stringify(o, null, 2));
    console.log(`This shell: ${describeOrigin(o)}`);
    console.log(`  terminal app   ${o.app ? `${o.app.name}${o.app.bundle ? ` (${o.app.bundle})` : ""}` : "not found"}`);
    console.log(`  tty            ${o.tty || "none"}${o.tabTty && o.tabTty !== o.tty ? `  (terminal tab: ${o.tabTty})` : ""}`);
    console.log(`  tmux           ${o.tmux ? `${o.tmux.session ?? "?"}:${o.tmux.window ?? "?"}.${o.tmux.paneIndex ?? "?"} pane ${o.tmux.pane}${o.tmux.clients ? `, ${o.tmux.clients} client(s)` : ", no client attached"}` : "no"}`);
    console.log(`  iTerm session  ${o.iterm || "n/a"}`);
    console.log(`  found through  ${o.via.join(", ") || "nothing"}`);
    console.log(`  a click would  ${o.jump === "none" ? "not know where to go" : `${o.jump} (${jumpPrecision(o)})`}`);
    return;
  }
  const sessions = listSessions({ sinceMs: flags.all ? null : 24 * 3600_000 });
  if (flags.refresh) {
    for (const s of sessions) {
      if (!s.origin?.raw) continue;
      try {
        const fresh = await resolveOrigin(s.origin.raw, { agent: s.agent });
        if (!betterOrigin(s.origin, fresh)) continue; // the agent is gone or a lookup failed: keep what we knew
        s.origin = fresh;
        updateSession(s.agent, s.session, { origin: fresh }, { touch: false });
      } catch {}
    }
  }
  if (flags.json) return console.log(JSON.stringify(sessions.map((s) => ({ agent: s.agent, session: s.session, project: s.project || null, cwd: s.cwd || null, origin: s.origin || null })), null, 2));
  if (!sessions.length) return console.log(`No agent activity${flags.all ? "" : " in the last 24 h"}.`);
  console.log(pad("AGENT", 14) + pad("PROJECT", 20) + pad("TERMINAL", 12) + pad("TTY", 10) + pad("TMUX", 16) + "CLICK LANDS ON");
  let unknown = 0;
  for (const s of sessions) {
    const o = s.origin;
    const name = agentConfig(config(), s.agent).label || getAdapter(s.agent).name;
    if (!o) unknown++;
    const tmux = o?.tmux?.session ? `${o.tmux.session}:${o.tmux.window ?? "?"}.${o.tmux.paneIndex ?? "?"}` : o?.tmux ? o.tmux.pane : "-";
    console.log(
      pad(name, 14) + pad(s.project || projectName(s.cwd), 20) + pad(o ? o.app?.name || "?" : "?", 12) + pad(o?.tty ? o.tty.replace("/dev/", "") : "-", 10) + pad(tmux, 16) + (o ? jumpPrecision(o) : "not seen yet"),
    );
  }
  if (unknown) console.log(`\n${unknown} session${unknown === 1 ? "" : "s"} not located yet: location is learned from each agent's next hook (restart it, or send a prompt).`);
}

// Silence what's playing and throw away everything queued. Lines already waiting for the
// speaker see the flush marker and drop themselves; stray workers and players are killed.
function cmdStop() {
  const { jobs, killed } = stopSpeaking();
  console.log(`earpiece: stopped. Cleared ${jobs} queued job${jobs === 1 ? "" : "s"}${killed.length ? `, killed ${killed.join(" and ")}` : ""}.`);
}

// Run the hub in the foreground: hooks sent to the socket are handled in this process.
// The desktop app does the same thing; this is for people who only want the CLI.
async function cmdServe() {
  const hub = await startHubServer();
  console.log(`earpiece: hub listening on ${hub.socket}. Ctrl-C to stop.`);
  const bye = () => hub.close().then(() => process.exit(0));
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;
const describeQuiet = (qh) =>
  !qh
    ? "quiet hours: off"
    : `quiet hours: ${qh.start}-${qh.end}, ${(() => {
        const allow = Array.isArray(qh.allow) ? qh.allow : QUIET_ALLOW_DEFAULT;
        return allow.length ? `only ${allow.join(" and ")} pings get through` : "completely silent";
      })()}`;

// earpiece quiet-hours 21:00-08:00 --silent  |  --allow needs_input,error  |  off
function cmdQuietHours(rest) {
  const { flags, words } = parseFlags(rest, ["allow"]);
  const cur = config().quietHours;
  if (words[0] === "off") {
    updateConfig({ quietHours: null });
    return console.log("earpiece: quiet hours: off");
  }
  if (!words.length && !flags.silent && !flags.allow) return console.log(describeQuiet(cur));
  const range = words.join(" ").replace(/\s*(-|to)\s*/, " ").split(/\s+/).filter(Boolean);
  const [start, end] = range.length ? range : [cur?.start || "23:00", cur?.end || "08:00"];
  if (!HHMM.test(start) || !HHMM.test(end)) {
    process.exitCode = 2;
    return console.error("usage: earpiece quiet-hours 23:00-08:00 [--silent | --allow needs_input,error] | off");
  }
  const kinds = ["done", "needs_input", "error", "info"];
  let allow = Array.isArray(cur?.allow) ? cur.allow : QUIET_ALLOW_DEFAULT;
  if (flags.silent) allow = [];
  else if (typeof flags.allow === "string") {
    allow = flags.allow === "none" ? [] : flags.allow.split(",").map((k) => k.trim()).filter(Boolean);
    const bad = allow.filter((k) => !kinds.includes(k));
    if (bad.length) {
      process.exitCode = 2;
      return console.error(`earpiece: unknown kind "${bad[0]}" (expected ${kinds.join(", ")} or none)`);
    }
  }
  const qh = { start, end, allow };
  updateConfig({ quietHours: qh });
  console.log(`earpiece: ${describeQuiet(qh)}`);
}

function cmdStatus() {
  const cfg = config();
  const all = fs.existsSync(P.log) ? fs.readFileSync(P.log, "utf8").trim().split("\n").filter(Boolean) : [];
  const lastSpoke = all
    .map((l) => parseJson(l))
    .reverse()
    .find((e) => e.spoke);
  const status = {
    mode: currentMode(),
    quietHours: describeQuiet(cfg.quietHours),
    quietHoursNow: inQuietHours(cfg.quietHours),
    engines: cfg.ttsProviders.join(" → "),
    smallestKey: apiKey(cfg, "SMALLEST_API_KEY") ? "found" : "missing",
    openaiKey: apiKey(cfg, "OPENAI_API_KEY") ? "found" : "missing",
    smallestVoice: `${cfg.smallest.voice} (${cfg.smallest.model})`,
    speakLanguage: cfg.speakLanguage,
    summaryProvider: cfg.summaryProvider,
    adapters: Object.fromEntries(listAdapters().map((a) => [a.id, a.isInstalled?.() ? "installed" : "not installed"])),
    agentOverrides: cfg.agents,
    lastEngine: lastSpoke ? `${lastSpoke.engine}${lastSpoke.ms ? ` (${lastSpoke.ms} ms)` : ""}` : null,
    audioPlayer: ["afplay", "paplay", "aplay", "ffplay"].find(which) || null,
    home: HOME,
  };
  console.log(JSON.stringify(status, null, 2));
  console.log("\nlast events:\n" + all.slice(-8).join("\n"));
  console.log(`\navailable engines: ${listEngines().map((e) => e.id).join(", ")}`);
}

async function cmdTest(rest) {
  const { flags } = parseFlags(rest, ["provider", "agent"]);
  process.env.EARPIECE_ECHO = "1";
  const cfg = flags.agent ? agentConfig(config(), flags.agent) : config();
  const ph = phrase(cfg, "test");
  const r = await speak(ph.text, "done", { src: "test", force: true, provider: flags.provider, lang: ph.lang, ...(flags.agent ? { agent: flags.agent } : {}) });
  if (r.ms) console.log(`  (${r.engine}, ${(r.ms / 1000).toFixed(1)} s including playback)`);
  if (r.engine === "none") process.exitCode = 1;
}

function cmdInstall(rest, uninstall = false) {
  const { flags } = parseFlags(rest, ["only", "env"]);
  uninstall ||= Boolean(flags.uninstall);
  ensureDirs();
  const only = flags.only ? String(flags.only).split(",").map((s) => s.trim()) : null;
  const opts = { node: process.execPath, bin: BIN, uninstall, chain: Boolean(flags.chain), ask: config().answerFromCard === true, reply: config().replyFromNotch === true };
  // --hub: hooks call the curl shim, which talks to `earpiece serve` or the desktop app.
  // Hooks the Mac app set up stay on the shim, so re-running install doesn't disconnect the app;
  // --node switches back to calling this checkout directly.
  const onShim = !flags.node && !uninstall && usesShim(only);
  if (!uninstall && (flags.hub || onShim)) {
    // The app rewrites the shim with its own fallback on every launch; don't clobber it.
    opts.cmd = [onShim && fs.existsSync(P.shim) ? P.shim : writeShim()];
    if (onShim && !flags.hub) console.log(`• Hooks go through ${P.shim} (the Mac app or \`earpiece serve\`); keeping that. Use --node to call this checkout directly.`);
  }
  for (const a of listAdapters()) {
    if (!a.install || (only && !only.includes(a.id))) continue;
    try {
      for (const m of a.install(opts)) console.log(m);
    } catch (e) {
      console.log(`✗ ${a.name}: ${e.message}`);
    }
  }
  if (uninstall) return console.log("\nEarpiece hooks removed. Your settings in ~/.earpiece were kept.");

  setEnvFile(flags.env);
  console.log(`\nNext:\n  earpiece test          # you should hear Earpiece\n  earpiece agents        # see every agent session\n  Restart running Claude Code / Codex sessions so they pick up the hooks.`);
  if (!process.env.PATH?.split(":").some((d) => fs.existsSync(path.join(d, "earpiece"))))
    console.log(`\n  No \`earpiece\` on PATH yet. Either \`npm link\` in ${ROOT}, or:\n  alias earpiece='node "${BIN}"'`);
}

// POST the hook payload to the hub and print whatever it answers. Never throws, never fails the agent.
async function cmdAsk(agent, raw) {
  const body = raw || "{}";
  const out = await new Promise((resolve) => {
    if (!fs.existsSync(P.socket)) return resolve("");
    const req = http.request(
      { socketPath: P.socket, path: `/ask/${encodeURIComponent(agent)}`, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, timeout: ASK_CURL_TIMEOUT_SEC * 1000 },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(res.statusCode === 200 ? data : ""));
        res.on("error", () => resolve(""));
      },
    );
    req.on("timeout", () => (req.destroy(), resolve("")));
    req.on("error", () => resolve(""));
    req.end(body);
  });
  if (out) process.stdout.write(out);
}

// Turn "answer from the card" on or off, then rewrite the agents' hooks to match.
function cmdAnswers(rest) {
  const arg = (rest[0] || "").toLowerCase();
  if (!["on", "off"].includes(arg)) {
    return console.log(`Answer from the card is ${config().answerFromCard === true ? "on" : "off"}.\nUsage: earpiece answers on|off   (needs the Mac app or \`earpiece serve\` running)`);
  }
  updateConfig({ answerFromCard: arg === "on" });
  console.log(`✓ Answer from the card: ${arg}`);
  cmdInstall(["--only", "claude-code,codex"]);
}

// True when every installed Earpiece hook for these adapters already calls the shim.
function usesShim(only) {
  const files = listAdapters()
    .filter((a) => a.install && a.configFile && (!only || only.includes(a.id)))
    .map((a) => {
      try {
        return fs.readFileSync(a.configFile(), "utf8");
      } catch {
        return "";
      }
    })
    .filter((t) => /(?:earpiece|jarvis)(?:\.mjs|-hook)/.test(t));
  return files.length > 0 && files.every((t) => /(?:earpiece|jarvis)-hook/.test(t));
}

function cmdEnv(rest) {
  const file = rest.find((a) => !a.startsWith("--"));
  if (!file) {
    const cfg = config();
    return console.log(cfg.envFile ? `Keys are read from ${cfg.envFile}` : "No envFile set. Usage: earpiece env /path/to/.env");
  }
  if (!fs.existsSync(path.resolve(file))) {
    process.exitCode = 1;
    return console.log(`✗ ${file} not found`);
  }
  setEnvFile(file);
}

function setEnvFile(explicit) {
  // Where API keys live: --env, else a .env next to this checkout. ~/.earpiece/.env and the
  // environment are always read too (see apiKey()).
  const cfgNow = readJson(P.config, {});
  const guess = [explicit, path.join(ROOT, ".env")]
    .filter(Boolean)
    .map((f) => path.resolve(f))
    .find((f) => fs.existsSync(f));
  if (explicit && !fs.existsSync(path.resolve(explicit))) console.log(`! --env ${explicit} not found; ignoring`);
  if (guess && (explicit || !cfgNow.envFile)) updateConfig({ envFile: guess });
  const cfg = config();
  const keys = ["SMALLEST_API_KEY", "OPENAI_API_KEY"].filter((k) => apiKey(cfg, k));
  console.log(`✓ Earpiece config at ${P.config}${cfg.envFile ? ` (keys from ${cfg.envFile})` : ""}`);
  console.log(`  keys found: ${keys.length ? keys.join(", ") : "none — Earpiece will use your system voice"}`);
}

// ---------- dispatch ----------

export async function main(argv) {
  ensureDirs();
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "hook": {
      // Claude Code (and any hook-style agent) sends its payload on stdin.
      const agent = rest[0] && !rest[0].startsWith("-") ? rest[0] : "claude-code";
      return ingest(agent, parseJson(await readStdin()));
    }
    case "ask": {
      // A blocking hook. Needs the hub (the desktop app or `earpiece serve`) to show the card;
      // with none running it prints nothing and the agent's own prompt carries on.
      const agent = rest[0] && !rest[0].startsWith("-") ? rest[0] : "claude-code";
      return cmdAsk(agent, await readStdin());
    }
    case "answers":
      return cmdAnswers(rest);
    case "codex":
      return handleCodex(rest[rest.length - 1] || "{}", { forwarded: process.env.EARPIECE_FORWARDED === "1" });
    case "serve":
      return cmdServe(rest);
    case "mcp": {
      const { runMcpServer } = await import("../mcp/server.mjs");
      return runMcpServer();
    }
    case "_worker":
      return runWorker(rest[0]);
    case "emit":
      return cmdEmit(rest);
    case "run":
      return cmdRun(rest);
    case "say": {
      const { flags, words } = parseFlags(rest, ["kind", "provider", "lang", "agent"]);
      process.env.EARPIECE_ECHO = "1";
      const lang = flags.lang || (/[^\x00-\x7F]/.test(words.join(" ")) ? config().speakLanguage : "en");
      return speak(words.join(" "), flags.kind || "info", { src: "cli", provider: flags.provider, lang, ...(flags.agent ? { agent: flags.agent } : {}) });
    }
    case "voices":
      return cmdVoices(rest);
    case "voice":
      return cmdVoice(rest);
    case "lang":
      return cmdLang(rest);
    case "where":
      return cmdWhere(rest);
    case "jump":
      return cmdJump(rest);
    case "agents":
    case "ls":
      return cmdAgents(rest);
    case "quiet":
    case "off": {
      const mins = Number(rest[0]) || (cmd === "quiet" ? 60 : 0);
      setMode(cmd, mins);
      return console.log(`earpiece: ${cmd}${mins ? ` for ${mins} min` : " until `earpiece on`"}`);
    }
    case "on":
      setMode("on");
      return console.log("earpiece: on");
    case "status":
      return cmdStatus();
    case "doctor":
      return cmdDoctor();
    case "stop":
    case "flush":
      return cmdStop();
    case "quiet-hours":
    case "night":
      return cmdQuietHours(rest);
    case "test":
      return cmdTest(rest);
    case "install":
      return cmdInstall(rest);
    case "env":
      return cmdEnv(rest);
    case "uninstall":
      return cmdInstall(rest, true);
    case "version":
    case "--version":
    case "-v":
      return console.log(pkg.version || "unknown");
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return process.stdout.write(HELP);
    default:
      // stderr only: if this ever runs from a hook, stdout could be fed back to the agent.
      process.exitCode = 2;
      console.error(`earpiece: unknown command "${cmd}". Run \`earpiece help\`.`);
  }
}

// Shared by every entry file. Hook paths never fail the agent because of a voice problem.
export function run(argv = process.argv.slice(2)) {
  const hookPath = ["hook", "ask", "codex", "_worker"].includes(argv[0]);
  return main(argv).catch((e) => {
    log({ error: String(e?.stack || e), cmd: argv[0] });
    if (hookPath) process.exitCode = 0;
    else {
      console.error(`earpiece: ${e?.message || e}`);
      process.exitCode = 1;
    }
  });
}
