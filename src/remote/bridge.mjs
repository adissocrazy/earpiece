// Turns relay frames into the hub pipeline (ingestEvent → processEvent → speak) and notch asks.
// Remote content is sanitized first. A frame cannot start a process, jump to a terminal,
// open a URL, or answer a local ask: the only outward call is a reply to this same agent.
import { agentConfig, config as readConfig } from "../config.mjs";
import { showCard as showCardFn } from "../card.mjs";
import { phrase } from "../i18n.mjs";
import { forgetSession as forgetSessionFn, getSession as getSessionFn, listSessions as listSessionsFn, updateSession as updateSessionFn } from "../hub/sessions.mjs";
import { log as logFn, readJson, writeJson, ensureDirs } from "../util.mjs";
import { P } from "../paths.mjs";
import { LIMITS, answerToReply, isNewer, toAsk, toHubEvents, validateFrame } from "./protocol.mjs";
import { backoffMs } from "./client.mjs";
import { clean, questionsLine, spokenLine, speakable } from "./sanitize.mjs";

const byQuestion = new Map();

export function createRemoteBridge({
  ingestEvent,
  asks,
  showCard = showCardFn,
  getSession = getSessionFn,
  updateSession = updateSessionFn,
  listSessions = listSessionsFn,
  forgetSession = forgetSessionFn,
  config = readConfig,
  log = logFn,
  now = Date.now,
  summarize = async () => ({ line: "" }),
  reply = async () => ({ ok: false, error: "no relay" }),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onReplyError = () => {},
  onPairing = () => {},
  onPlan = () => {},
  readState = () => readJson(P.remoteState, {}) || {},
  writeState = (s) => (ensureDirs(), writeJson(P.remoteState, s)),
  deviceId = () => readState().deviceId || "dev",
} = {}) {
  const seen = new Set(readState().seen || []);
  const order = new Map(); // hub\0session -> { seq, occurredAt, status }
  const cooldown = new Map(); // hub id -> last spoken needs_you
  let stash = [];
  let job = null;

  function remember(id) {
    if (!id) return false;
    if (seen.has(id)) return true;
    seen.add(id);
    while (seen.size > LIMITS.eventLru) seen.delete(seen.values().next().value);
    try {
      writeState({ ...readState(), seen: [...seen] });
    } catch {}
    return false;
  }

  function sessionCount(hub) {
    try {
      return listSessions().filter((s) => s.agent === hub).length;
    } catch {
      return 0;
    }
  }

  async function say(ev) {
    if (!ingestEvent) return;
    await ingestEvent(ev, { foreground: true });
  }

  function noteSession(frame, extra = {}) {
    const prev = getSession(frame.agent.hub_id, frame.session_id) || {};
    updateSession(frame.agent.hub_id, frame.session_id, {
      remote: {
        ...(prev.remote || {}),
        agentId: frame.agent.agent_id,
        kind: frame.agent.kind,
        link: frame.link || prev.remote?.link || null,
        lastEventId: frame.event_id || prev.remote?.lastEventId || null,
        lastSeq: frame.seq ?? prev.remote?.lastSeq ?? null,
      },
      lastText: extra.text ?? prev.lastText ?? "",
    });
  }

  async function compose(frame) {
    const cfg = config();
    const name = clean(frame.agent?.name || "Remote", LIMITS.name) || "Remote";
    const title = clean(frame.title || "", LIMITS.title);
    let body = speakable(frame.line || "");
    if (!body && frame.text && cfg.remote?.summarize !== "never") {
      try {
        const s = await summarize(clean(frame.text, LIMITS.text), cfg, { untrusted: true });
        body = speakable(s?.line || "");
      } catch {
        body = "";
      }
    }
    let spoken = spokenLine({ name, title, status: frame.status, body, question: frame.question });
    if (!body && cfg.remote?.summarize === "never" && title && frame.status !== "needs_you") spoken = `${spoken} ${title}`;
    return { cfg, name, title, body, spoken, text: clean(frame.text || "", LIMITS.text), prompt: frame.question ? clean(frame.question.prompt || "", LIMITS.prompt) : "" };
  }

  async function sendReply(ask, answer) {
    const body = answerToReply(ask, answer, { via: "notch" });
    if (!body) return;
    const qid = body.question_id || `${body.agent_id}:${body.session_id}`;
    body.client_reply_id = `${deviceId()}:${qid}`;
    const started = now();
    let attempt = 0;
    let last = { ok: false, error: "Couldn't reach Earpiece cloud. Will retry." };
    // A handful of tries inside the 30 s budget. `now` may be frozen in tests, so attempts are capped too.
    while (attempt < 6 && now() - started <= LIMITS.replyRetryMs) {
      try {
        last = await reply(body);
      } catch (e) {
        last = { ok: false, error: String(e?.message || e) };
      }
      if (last?.ok) return;
      const status = last?.status || 0;
      if (status && status < 500 && status !== 429) break;
      attempt++;
      await sleep(backoffMs(attempt, 0.5, null));
    }
    if (last?.status === 409) {
      onReplyError(last.error || "Already answered on another device.");
      return;
    }
    if (last?.status === 410) {
      onReplyError(last.error || "That question expired.");
      return;
    }
    onReplyError("Couldn't reach Earpiece cloud. Will retry.");
    if (asks?.open) {
      const again = { ...ask };
      delete again.id;
      delete again.at;
      delete again.expiresAt;
      asks.open(again, { timeoutMs: Math.max(1000, (ask.expiresAt || now() + 60_000) - now()) });
    }
  }

  function openAsk(frame, composed, { silent = false } = {}) {
    if (!asks?.open) return;
    if (frame.status !== "needs_you") return;
    const ask = toAsk(frame, { line: composed.spoken, text: composed.text, prompt: composed.prompt });
    const exp = Date.parse(frame.question?.expires_at || "") || now() + (frame.question?.expires_in_s || 86400) * 1000;
    const opened = asks.open(ask, { timeoutMs: Math.max(0, exp - now()) });
    if (!opened?.id) return; // sub-cap or the store refused it
    if (frame.question?.question_id) byQuestion.set(frame.question.question_id, opened.id);
    opened.promise.then((answer) => answer && sendReply(opened.ask, answer)).catch(() => {});
    if (!silent) {
      /* the spoken line already went through ingest; the ask is the buttons */
    }
  }

  async function apply(frame, { silent = false, speakNeeds = true } = {}) {
    const key = `${frame.agent.hub_id}\0${frame.session_id}`;
    const prev = order.get(key) || null;
    const session = getSession(frame.agent.hub_id, frame.session_id);
    const known = prev || (session?.remote ? { seq: session.remote.lastSeq ?? null, occurredAt: null, status: session.status } : null);
    const newer = isNewer(frame, known);
    if (!newer) {
      log({ skipped: "out_of_order", agent: frame.agent.hub_id, session: frame.session_id, event: frame.event_id });
      if (frame.status === "needs_you") {
        const composed = await compose(frame);
        openAsk(frame, composed, { silent: true });
      }
      return { skipped: "out_of_order" };
    }
    if (!session && sessionCount(frame.agent.hub_id) >= LIMITS.sessionsShown) {
      log({ skipped: "session_cap", agent: frame.agent.hub_id, session: frame.session_id });
      return { skipped: "session_cap" };
    }
    const composed = await compose(frame);
    const events = toHubEvents(frame, { status: known?.status || session?.status }, composed.spoken);
    const cooled = frame.status === "needs_you" && speakNeeds && (now() - (cooldown.get(frame.agent.hub_id) || 0) < LIMITS.voiceCooldownMs);
    for (const ev of events) {
      if (silent) ev.silent = "remote_backlog";
      else if (cooled) ev.silent = "remote_cooldown";
      await say(ev);
    }
    if (frame.status === "needs_you" && speakNeeds && !silent && !cooled) cooldown.set(frame.agent.hub_id, now());
    if (["working", "done", "error"].includes(frame.status)) {
      for (const a of asks?.list?.() || []) {
        if (a.remote && a.agent === frame.agent.hub_id && a.session === frame.session_id) asks.cancel(a.id, "superseded");
      }
    }
    if (frame.status === "needs_you") openAsk(frame, composed, { silent: silent || cooled });
    noteSession(frame, { text: composed.text });
    order.set(key, { seq: frame.seq ?? null, occurredAt: frame.occurred_at || frame.received_at || null, status: frame.status === "needs_you" ? "waiting" : frame.status === "working" ? "working" : frame.status });
    const day = new Date(now()).toISOString().slice(0, 10);
    const st = readState();
    const same = st.day === day;
    writeState({
      ...st,
      day,
      seen: [...seen],
      eventsToday: (same ? st.eventsToday || 0 : 0) + 1,
      questionsToday: (same ? st.questionsToday || 0 : 0) + (frame.status === "needs_you" ? 1 : 0),
    });
    log({ remote: frame.status, agent: frame.agent.hub_id, session: frame.session_id, event: frame.event_id, title: composed.title, line: composed.spoken });
    return { applied: frame.status, spoken: silent || cooled ? null : composed.spoken };
  }

  function applyControl(frame) {
    if (frame.frame === "question_closed") {
      const id = byQuestion.get(frame.question_id);
      if (id) asks?.cancel?.(id, frame.reason || "closed");
      byQuestion.delete(frame.question_id);
      return;
    }
    if (frame.frame === "pairing") {
      onPairing(frame);
      return;
    }
    if (frame.frame === "plan_lapsed") {
      onPlan(frame);
      return;
    }
    if (frame.frame === "agent_revoked") {
      for (const a of asks?.list?.() || []) if (a.remote?.agentId === frame.agent_id || a.agent === frame.hub_id) asks.cancel(a.id, "revoked");
    }
  }

  async function flushBatch(frames) {
    if (!frames.length) return;
    const latest = new Map();
    for (const f of frames) {
      if (f.frame !== "event") {
        applyControl(f);
        continue;
      }
      const k = `${f.agent.hub_id}\0${f.session_id}`;
      const prev = latest.get(k);
      if (!prev || isNewer(f, { seq: prev.seq ?? null, occurredAt: prev.occurred_at || prev.received_at })) latest.set(k, f);
    }
    const waiting = [];
    for (const f of latest.values()) {
      await apply(f, { silent: true, speakNeeds: false });
      if (f.status === "needs_you") waiting.push(f);
    }
    const byAgent = new Map();
    for (const f of waiting) {
      const cur = byAgent.get(f.agent.hub_id) || { n: 0, name: f.agent.name };
      cur.n++;
      byAgent.set(f.agent.hub_id, cur);
    }
    for (const [hub, info] of byAgent) {
      const cfg = config();
      const line = questionsLine(cfg, clean(info.name, LIMITS.name) || "Remote", info.n);
      await say({ type: "info", agent: hub, session: "remote-backlog", project: info.name, cwd: null, at: now(), line });
      // The sentence is on the card. Don't leave a fake session row behind it.
      try {
        forgetSession(hub, "remote-backlog");
      } catch {}
    }
  }

  async function runJob() {
    try {
      while (stash.length) await flushBatch(stash.splice(0));
    } finally {
      job = null;
      if (stash.length) job = Promise.resolve().then(runJob);
    }
  }

  function hold(frame) {
    stash.push(frame);
    // One in-flight drain. idle() awaits it, including frames that arrive mid-flush.
    if (!job) job = Promise.resolve().then(runJob);
  }

  async function flush() {
    if (!job && stash.length) job = runJob();
    while (job) await job;
  }

  function backlog(frame) {
    const t = Date.parse(frame.received_at || "");
    return Number.isFinite(t) && now() - t > LIMITS.backlogSilentMs;
  }

  return {
    async handleFrame(frame, meta = {}) {
      const v = validateFrame(frame);
      if (!v.ok) {
        log({ skipped: "bad_frame", error: v.error });
        return { skipped: "bad_frame" };
      }
      if (frame.frame !== "event") {
        await flush();
        applyControl(frame);
        return { applied: frame.frame };
      }
      if (remember(frame.event_id)) return { skipped: "duplicate" };
      if (meta.id) {
        try {
          writeState({ ...readState(), cursor: meta.id });
        } catch {}
      }
      if (backlog(frame)) {
        hold(frame);
        return { stashed: true };
      }
      await flush();
      return apply(frame, {});
    },
    idle: () => flush(),
    flush,
    resync(list) {
      const jobs = [];
      for (const q of list || []) {
        const frame = {
          frame: "event",
          event_id: `resync:${q.question_id}`,
          agent: q.agent,
          session_id: q.session_id,
          status: "needs_you",
          title: q.title || q.agent?.name,
          line: q.line || "",
          text: q.text || "",
          question: q,
          link: q.link || null,
          received_at: new Date(now()).toISOString(),
        };
        jobs.push(apply(frame, { silent: true, speakNeeds: false }));
      }
      return Promise.all(jobs);
    },
    noteAnswer() {
      const st = readState();
      const day = new Date(now()).toISOString().slice(0, 10);
      const same = st.day === day;
      writeState({ ...st, day, answersToday: (same ? st.answersToday || 0 : 0) + 1 });
    },
    pending: () => stash.length,
  };
}

/** One spoken line for a backlog of questions. Exported for tests of the phrase. */
export function backlogLine(cfg, name, n) {
  return questionsLine(cfg, name, n) || phrase(cfg, "remoteQuestions", name, n).text;
}
