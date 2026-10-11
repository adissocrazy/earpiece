// speak(): policy check, cross-process lock, duplicate suppression, then the engine chain.
import fs from "node:fs";
import { SILENT_REASONS, showCard } from "../card.mjs";
import { agentConfig, config } from "../config.mjs";
import { proToken } from "../pro.mjs";
import { withLock } from "../lock.mjs";
import { P } from "../paths.mjs";
import { policyBlock } from "../policy.mjs";
import { echo, ensureDirs, isDry, log, now, plainFirstSentence, readJson, redact, writeJson } from "../util.mjs";
import { getEngine } from "./engines/index.mjs";
import { play, playBuffer as realPlayBuffer } from "./play.mjs";

// macOS system sounds. cfg.tones picks one per kind ("none" = no tone for that kind).
export const TONES = ["Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink"];
export const toneFile = (name) => (TONES.includes(name) ? `/System/Library/Sounds/${name}.aiff` : null);
// A notch question and the spoken "needs you" line for it arrive seconds apart: one tone, not two.
const TONE_DEDUPE_MS = 5_000;

/** Play the tone for this kind of line, unless tones are off or the same one just played. */
export function chime(kind, cfg = config()) {
  const file = cfg.chimes ? toneFile(cfg.tones?.[kind]) : null;
  if (!file || !fs.existsSync(file)) return Promise.resolve(false);
  const last = readJson(P.tone, {});
  if (last.kind === kind && now() - (last.at || 0) < TONE_DEDUPE_MS) return Promise.resolve(false);
  writeJson(P.tone, { kind, at: now() });
  return play(file).catch(() => false);
}
const DUPLICATE_WINDOW_MS = 60_000;
// A line that waited this long for the speaker is old news; drop it instead of reading it out late.
export const STALE_MS = 2 * 60_000;

// Why a queued line should be dropped once it reaches the front of the queue, or null.
// `stillNeeded` lets the caller withdraw a line, e.g. a permission alert the user already
// answered in the terminal while it waited.
function dropReason(queuedAt, kind, cfg, force, stillNeeded) {
  if (force) return null;
  const blocked = policyBlock(kind, cfg); // the user may have run `earpiece off` while we waited
  if (blocked) return blocked;
  if (queuedAt) {
    if (queuedAt <= (readJson(P.flushed, {}).at || 0)) return "flushed";
    if (now() - queuedAt > STALE_MS) return "stale";
  }
  if (stillNeeded && !stillNeeded()) return "resolved";
  return null;
}

/**
 * @param {string} text  line to speak
 * @param {"done"|"needs_input"|"error"|"info"} kind
 * @param {object} meta  { agent?, lang?, provider?, force?, queuedAt?, stillNeeded?, ...anything to log }
 * @param {object} deps  test seams: { playBuffer, fetch }
 */
export async function speak(text, kind = "info", meta = {}, deps = {}) {
  ensureDirs();
  const base = config();
  const cfg = meta.agent ? agentConfig(base, meta.agent) : base;
  let line = redact(String(text || "")).replace(/\s+/g, " ").trim();
  if (!line) return { skipped: "empty" };
  if (line.length > cfg.maxChars) line = plainFirstSentence(line, cfg.maxChars);

  const { provider, force, queuedAt = now(), stillNeeded, ...logMeta } = meta;
  const blocked = dropReason(queuedAt, kind, cfg, force, stillNeeded);
  const card = { line, kind, agent: logMeta.agent, project: logMeta.project, session: logMeta.session };
  if (blocked) {
    if (SILENT_REASONS.has(blocked)) showCard({ ...card, state: "silent", reason: blocked });
    log({ skipped: blocked, kind, line, ...logMeta });
    echo(`[earpiece:skipped:${blocked}] (earpiece on to reset)`);
    return { skipped: blocked };
  }

  return withLock(async () => {
    const late = dropReason(queuedAt, kind, cfg, force, stillNeeded);
    if (late) {
      if (SILENT_REASONS.has(late)) showCard({ ...card, state: "silent", reason: late });
      log({ skipped: late, kind, line, ...logMeta });
      echo(`[earpiece:skipped:${late}]`);
      return { skipped: late };
    }
    const last = readJson(P.last, {});
    if (!force && last.line === line && now() - (last.at || 0) < DUPLICATE_WINDOW_MS) {
      log({ skipped: "duplicate", kind, line, ...logMeta });
      echo(`[earpiece:skipped:duplicate] said this <60s ago`);
      return { skipped: "duplicate" };
    }
    const lang = meta.lang || "en";
    const began = now();
    const stopped = () => (readJson(P.flushed, {}).at || 0) >= began; // Stop pressed mid-line
    // Pro: hosted voice first, then the user's own chain as before.
    const chain = provider ? [provider] : [...(proToken() ? ["earpiece"] : []), ...cfg.ttsProviders.filter((e) => e !== "earpiece")];

    // The card (and the app's "speaking" indicator, which reads the card) must not appear while we
    // are still waiting on a TTS API: the voice hasn't started, and a slow or hung provider would
    // leave the window claiming to talk in silence. Engines call ready() the moment audio is
    // in hand and about to play; playBuffer() does it for them.
    let chimeDone = Promise.resolve();
    const ready = async () => {
      await chimeDone; // the voice starts after the chime, not over it
      // Stop pressed while the API was still working. Strictly after we began: a marker written in
      // the same millisecond belongs to an earlier Stop and was already handled by dropReason().
      if ((readJson(P.flushed, {}).at || 0) > began) throw new Error("stopped");
      card.id = showCard({ ...card, state: "speaking" });
    };
    const basePlay = deps.playBuffer || realPlayBuffer;
    const ctx = {
      cfg,
      lang,
      fetch: deps.fetch,
      ready,
      playBuffer: async (buf, ...rest) => {
        await ready();
        return basePlay(buf, ...rest);
      },
    };
    let engine = "none";
    let ms = null;
    const failures = [];
    if (isDry()) {
      engine = "dry-run";
      await ready();
    } else {
      // The chime plays while the TTS request is in flight instead of delaying it.
      chimeDone = chime(kind, cfg);
      for (const id of chain) {
        const e = getEngine(id);
        if (!e) {
          failures.push(`${id}: unknown engine`);
          continue;
        }
        const t0 = now();
        try {
          await e.speak(line, ctx);
          engine = id;
          ms = now() - t0; // includes playback
          break;
        } catch (err) {
          const error = String(err?.message || err);
          // A killed player looks like a failure; don't let Stop fall through to the next voice.
          if (stopped()) {
            if (card.id) showCard({ ...card, state: "stopped" }); // only if the card was ever shown
            log({ skipped: "stopped", kind, line, ...logMeta });
            echo(`[earpiece:skipped:stopped]`);
            return { skipped: "stopped" };
          }
          failures.push(`${id}: ${error}`);
          log({ warn: "tts_failed", engine: id, error });
        }
      }
    }
    for (const f of failures) echo(`[earpiece:fallback] ${f}`);
    if (engine === "none") {
      // Every voice failed or timed out, so nothing was said. Don't claim it was: show the line
      // as text with a "no voice" chip, and don't record it as spoken (a retry isn't a duplicate).
      showCard({ ...card, state: "silent", reason: "voice_failed" });
      log({ skipped: "voice_failed", kind, line, failures, ...logMeta });
      echo(`[earpiece:skipped:voice_failed] ${line}`);
      return { skipped: "voice_failed", engine, ms, failures };
    }
    writeJson(P.last, { line, at: now(), kind });
    showCard({ ...card, state: "spoken" });
    log({ spoke: line, kind, engine, lang, ms, ...logMeta });
    echo(`[earpiece:${engine}:${kind}] ${line}`);
    return { spoke: line, engine, ms, failures };
  }).catch((e) => {
    if (e?.code !== "ELOCKTIMEOUT") throw e;
    log({ skipped: "busy", kind, line, ...logMeta });
    echo(`[earpiece:skipped:busy] another line held the speaker too long`);
    return { skipped: "busy" };
  });
}
