// The hub: adapters hand it normalized events, it keeps the session registry current
// and decides what (if anything) to say.
//
//   agent hook ──► adapter.toEvents() ──► ingest() ──► session registry
//                                              └──► worker ──► processEvent() ──► speak()
//
// ingest() runs inside the agent's hook process, so it only does cheap sync work and hands
// everything slow (transcript reads, LLM summaries, TTS) to a detached worker process.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getAdapter } from "../adapters/index.mjs";
import { showCard } from "../card.mjs";
import { agentConfig, config } from "../config.mjs";
import { phrase } from "../i18n.mjs";
import { BIN, P } from "../paths.mjs";
import { summarize } from "../summary/summarize.mjs";
import { classifyTurn } from "../summary/turn.mjs";
import { ensureDirs, log, now, projectName, readJson } from "../util.mjs";
import { speak } from "../voice/speak.mjs";
import { endsWithQuestion, normalizeEvent } from "./events.mjs";
import { deliverRoutes } from "../outputs/router.mjs";
import { forgetSession, getSession, pruneSessions, updateSession } from "./sessions.mjs";

/** Entry point for every agent. Returns the normalized events (handy for tests). */
export async function ingest(agentId, payload, { deps = {}, foreground } = {}) {
  ensureDirs();
  const adapter = getAdapter(agentId);
  const events = (adapter.toEvents(payload || {}) || []).map((e) => normalizeEvent(e, agentId));
  for (const ev of events) await ingestEvent(ev, { deps, ...(foreground !== undefined ? { foreground } : {}) });
  return events;
}

/**
 * Handle one already-normalized hub event. turn_start is recorded inline (it must be quick);
 * everything else goes to a background worker unless `foreground` or EARPIECE_FOREGROUND=1.
 */
export async function ingestEvent(ev, { foreground = process.env.EARPIECE_FOREGROUND === "1", deps = {} } = {}) {
  if (ev.type === "turn_start") {
    updateSession(ev.agent, ev.session, {
      status: "working",
      cwd: ev.cwd || getSession(ev.agent, ev.session)?.cwd || null,
      project: ev.project || getSession(ev.agent, ev.session)?.project || projectName(ev.cwd),
      turnStart: ev.at,
      spokeAfterStop: false,
      lastEvent: ev.lastEvent || "turn_start", // "answered": you answered from the card or the notch
      activeAt: ev.at,
      activeTool: null,
    });
    if (Math.random() < 0.05) pruneSessions();
    return { recorded: "turn_start" };
  }
  if (ev.type === "session_end") {
    forgetSession(ev.agent, ev.session);
    return { recorded: "session_end" };
  }
  // The turn a card answer continued (Claude Code's Stop with stop_hook_active). Any other
  // Stop-hook loop stays silent, as before.
  if (ev.continued && getSession(ev.agent, ev.session)?.lastEvent !== "answered") return { skipped: "continued" };
  if (ev.type === "activity") {
    // Runs on every tool call, so it only touches the session file.
    updateSession(ev.agent, ev.session, (cur) => ({
      activeAt: ev.at,
      activeTool: ev.tool || null,
      ...(cur.status === "waiting" ? { status: "working" } : {}),
    }));
    return { recorded: "activity" };
  }
  if (ev.type === "turn_end") updateSession(ev.agent, ev.session, { activeAt: ev.at, activeTool: null });
  if (foreground) return processEvent(ev, deps);
  detach(ev);
  return { detached: true };
}

function detach(ev) {
  const file = path.join(P.tmp, `job-${process.pid}-${now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(file, JSON.stringify(ev), { mode: 0o600 });
  spawn(process.execPath, [BIN, "_worker", file], { detached: true, stdio: "ignore", env: process.env })
    .on("error", (e) => log({ error: `worker spawn failed: ${e.message}`, agent: ev.agent }))
    .unref();
}

/** Background worker: `earpiece _worker <jobfile>`. */
export async function runWorker(file) {
  const ev = readJson(file, null);
  fs.rmSync(file, { force: true });
  if (!ev) return;
  try {
    await processEvent(ev);
  } catch (e) {
    log({ error: String(e?.stack || e), agent: ev.agent, type: ev.type });
  }
}

// The worker can take seconds (summary, TTS). If the user started a new turn meanwhile, the
// session already says "working" with a fresh turnStart; keep those and only record the line.
const guarded = (ev, patch) => (cur) => {
  if (cur.turnStart && cur.turnStart > ev.at) {
    const { status, turnStart, spokeAfterStop, lastEvent, ...rest } = patch;
    return rest;
  }
  return patch;
};

const STATUS_FOR = { turn_end: "done", needs_input: "waiting", idle: "waiting", error: "error", info: null };

// Has the user already dealt with this "needs you" event? True once the session moved on after
// it: a new prompt, the end of the turn, or the tool it asked about running. Activity from a
// different tool doesn't count, since parallel tool calls can finish while another one waits.
export function answered(ev, session) {
  if (!session?.activeAt || session.activeAt <= ev.at) return false;
  if (!session.activeTool || !ev.tool) return true;
  return session.activeTool.toLowerCase() === String(ev.tool).toLowerCase();
}
const NEEDS_YOU = new Set(["needs_input", "idle"]);

/** Decide what to say for one event, update the registry, speak. */
export async function processEvent(input, deps = {}) {
  const adapter = getAdapter(input.agent);
  let ev = adapter.enrich ? await adapter.enrich(input) : input;
  const cfg = agentConfig(config(), ev.agent);
  const prev = getSession(ev.agent, ev.session) || {};
  const project = ev.project || prev.project || projectName(ev.cwd || prev.cwd);
  const name = cfg.label || adapter.name;
  const who = cfg.announceAgent || cfg.label ? `${name}, ${project}` : project;
  const meta = { agent: ev.agent, session: ev.session, project, type: ev.type };
  if (NEEDS_YOU.has(ev.type) && answered(ev, prev)) {
    log({ skipped: "resolved", ...meta });
    return { skipped: "resolved" };
  }
  const base = { cwd: ev.cwd || prev.cwd || null, project, lastEvent: ev.type };

  let say = null; // { text, kind, lang, via? }
  let status = STATUS_FOR[ev.type];
  const patch = {};

  switch (ev.type) {
    case "turn_end": {
      const durationMs = ev.durationMs ?? (prev.turnStart ? ev.at - prev.turnStart : null);
      patch.lastDurationMs = durationMs;
      if (durationMs != null && durationMs < cfg.minTurnSeconds * 1000) {
        log({ skipped: "short_turn", secs: Math.round(durationMs / 1000), ...meta });
        updateSession(ev.agent, ev.session, guarded(ev, { ...base, ...patch, status: "done", turnStart: null }));
        return { skipped: "short_turn" };
      }
      if (ev.line) {
        const question = endsWithQuestion(ev.text);
        say = { text: ev.line, kind: question ? "needs_input" : "done", lang: ev.lang || "en" };
      } else {
        const [turn, s] = await Promise.all([classifyTurn(ev.text, cfg, { fetch: deps.fetch }), summarize(ev.text, cfg, { fetch: deps.fetch })]);
        say = { text: `${who}. ${s.line}`, kind: turn === "ask" ? "needs_input" : "done", lang: s.lang, via: s.via, background: turn === "progress" };
      }
      status = say.kind === "needs_input" ? "waiting" : "done";
      patch.turnStart = null;
      break;
    }
    case "idle": {
      if (prev.spokeAfterStop) {
        updateSession(ev.agent, ev.session, base); // keep "done"/"waiting" from the turn we already announced
        return { skipped: "already_spoke" };
      }
      const ph = phrase(cfg, "waiting", who);
      say = { text: ph.text, kind: "needs_input", lang: ph.lang };
      break;
    }
    case "needs_input": {
      const ph = ev.tool
        ? phrase(cfg, "permission", who, ev.tool)
        : ev.message
          ? phrase(cfg, "attention", who, ev.message)
          : phrase(cfg, "waiting", who);
      say = { text: ev.line || ph.text, kind: "needs_input", lang: ev.line ? ev.lang || "en" : ph.lang };
      break;
    }
    case "error": {
      if (ev.line) say = { text: ev.line, kind: "error", lang: ev.lang || "en" };
      else if (ev.text || ev.message) {
        const s = await summarize(ev.text || ev.message, cfg, { fetch: deps.fetch });
        say = { text: `${who}. ${s.line}`, kind: "error", lang: s.lang, via: s.via };
      } else {
        const ph = phrase(cfg, "failed", who);
        say = { text: ph.text, kind: "error", lang: ph.lang };
      }
      patch.turnStart = null;
      break;
    }
    case "info":
      say = { text: ev.line || ev.text || ev.message || "", kind: "info", lang: ev.lang || "en" };
      break;
  }

  const line = say?.text || null;
  updateSession(
    ev.agent,
    ev.session,
    guarded(ev, {
      ...base,
      ...patch,
      ...(status ? { status } : {}),
      ...(line ? { lastLine: line } : {}),
      ...(ev.type === "turn_end" || ev.type === "needs_input" ? { spokeAfterStop: Boolean(line) } : {}),
    }),
  );

  if (!line) return { skipped: "nothing_to_say" };
  // Remote delivery is independent of local speech. A muted/quiet Earpiece can still
  // publish updates to explicitly configured Hermes channels or webhooks.
  if (config().remote?.routes?.length) {
    deliverRoutes({ event: ev, text: line, project, agent: ev.agent, session: ev.session }, config()).catch((e) => log({ error: `route delivery: ${e.message}`, agent: ev.agent }));
  }
  if (!cfg.enabled) {
    showCard({ line, kind: say.kind, agent: ev.agent, project, session: ev.session, state: "silent", reason: "agent_disabled" });
    log({ skipped: "agent_disabled", line, ...meta });
    return { skipped: "agent_disabled" };
  }
  if (say.background) {
    // A progress note: nothing for you to do, so it goes on the card without a voice.
    showCard({ line, kind: say.kind, agent: ev.agent, project, session: ev.session, state: "silent", reason: "background" });
    log({ skipped: "background", line, ...meta });
    return { skipped: "background" };
  }
  const stillNeeded = NEEDS_YOU.has(ev.type) ? () => !answered(ev, getSession(ev.agent, ev.session)) : undefined;
  return speak(line, say.kind, { ...meta, lang: say.lang, via: say.via, queuedAt: ev.at, stillNeeded }, deps);
}
