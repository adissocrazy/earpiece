// The notch island. The app sends it one card at a time, plus the shape of the screen it is on
// (notch or not), and the list of running agents. Six views:
//   gone  - nothing on screen (the app hides the window); only when the resting icon is off
//   rest  - the resting icon: Earpiece mark and running count on the left wing, a status dot on
//           the right (green working, amber needs you, red error, grey idle); click for the list
//   list  - the agents list, dropped down from the resting icon; click a row to go to that agent
//   mini  - collapsed into the notch after a line: agent logo on the left, wave or dot on the right
//   peek  - a new line opens it for a few seconds, then it folds back into the notch
//   open  - you clicked it; it stays open while the pointer is on it
// A question an agent is waiting on ("ask" cards) never opens by itself: the island turns amber
// and pulses in the notch until you click it. Nothing is approved without a click on a button,
// and the buttons only wake up a moment after the question is opened.
const J = window.earpiece;
const $ = (id) => document.getElementById(id);
const island = $("card");
const box = $("replyText");
const REASON = { mode_quiet: "Quiet", quiet_hours: "Quiet hours", agent_disabled: "Muted", voice_failed: "No voice" };

const FULL_W = 460; // the window is 480 wide; 10 px either side for the curved shoulders
const WING = 46; // each wing next to the notch, collapsed
const VIRTUAL = { w: 230, h: 32 }; // the collapsed pill on a screen without a notch
const REST_WING = 36; // each wing of the resting icon
const REST_VIRTUAL_H = 24; // the resting pill on a screen without a notch
const STATUS = { waiting: "Needs you", error: "Error", working: "Working", done: "Done", idle: "Idle" };
const ARM_MS = 700;
// A "speaking" card is replaced within seconds by spoken/stopped. If it never is (the process
// that wrote it died), don't leave the wings up for ever.
const SPEAKING_MAX_MS = 60_000;
// The pointer left the open island (or you clicked somewhere else, which means it left): fold back.
const LEAVE_MS = 450;
const LIST_LEAVE_MS = 250;

let geom = { notch: false, notchW: 0, notchH: 0 };
let current = null;
let view = "gone";
let hovering = false;
let busy = false;
let timer = null;
let armTimer = null;
let goneTimer = null;
let rest = false; // the app wants the island resting in the notch between lines
let agents = { rows: [], more: 0, active: 0, waiting: 0, tone: "idle", mode: "on", now: Date.now() };

// Where the island goes when nothing needs showing: a waiting question stays in the notch.
const idle = () => (current?.ask ? "mini" : rest ? "rest" : "gone");

// ---------- sizes ----------

function applyGeom(g) {
  geom = { notch: Boolean(g?.notch), notchW: Number(g?.notchW) || 0, notchH: Number(g?.notchH) || 0 };
  const s = document.body.style;
  document.body.classList.toggle("virtual", !geom.notch);
  s.setProperty("--notch-w", `${geom.notch ? geom.notchW : 0}px`);
  s.setProperty("--notch-h", `${geom.notch ? geom.notchH : VIRTUAL.h}px`);
  s.setProperty("--inset", `${geom.notch ? geom.notchH : 4}px`);
  s.setProperty("--full-w", `${FULL_W}px`);
  setView(view, true);
}

function fullHeight() {
  return Math.ceil($("full").offsetHeight);
}

function agentsHeight() {
  return Math.ceil($("agents").offsetHeight);
}

function restSize() {
  if (geom.notch) return { w: geom.notchW + 2 * REST_WING, h: geom.notchH };
  const w = Math.ceil($("rest").querySelector(".wing.left").scrollWidth + $("rest").querySelector(".wing.right").scrollWidth) + 28;
  return { w: Math.max(w, 56), h: REST_VIRTUAL_H };
}

function sizeFor(v) {
  if (v === "peek" || v === "open") return { w: FULL_W, h: fullHeight() };
  if (v === "list") return { w: FULL_W, h: agentsHeight() };
  if (v === "rest") return restSize();
  if (v === "mini") return geom.notch ? { w: geom.notchW + 2 * WING, h: geom.notchH } : VIRTUAL;
  return geom.notch ? { w: geom.notchW, h: geom.notchH } : { w: 150, h: 0 };
}

// The window has a fixed size, tall enough for any view, so growing and folding are pure CSS and
// never wait for (or stutter on) a window resize. Clicks go through the empty part. The app is
// told where the island is, so it can tell when the pointer has left it.
function reportSize() {
  J.card("size", Math.max(fullHeight(), agentsHeight()) + 34);
}

function reportRect(w, h) {
  J.card("rect", { w: Math.ceil(w), h: Math.ceil(h) });
}

// ---------- views ----------

function setView(v, force = false) {
  if (v === view && !force) return;
  const was = view;
  if (v === "list" && was !== "list") renderAgents(); // fill it before measuring it
  const before = sizeFor(was);
  view = v;
  island.dataset.view = v;
  const { w, h } = sizeFor(v);
  island.dataset.motion = w * h >= before.w * before.h ? "grow" : "shrink";
  reportRect(v === "gone" ? 0 : w, v === "gone" ? 0 : h);
  island.style.setProperty("--w", `${w}px`);
  island.style.setProperty("--h", `${h}px`);
  clearTimeout(goneTimer);
  if (v === "gone") {
    goneTimer = setTimeout(() => view === "gone" && J.card("hidden"), 380);
  }
  if (v === "rest" && was !== "rest") {
    if (!current?.ask) current = null; // the line has been seen; the next one peeks fresh
    J.card("rest");
  }
  if (current?.ask) {
    if (v === "open" && (was !== "open" || force)) {
      arm(false); // buttons wake up ARM_MS after you can see them
      J.card("expanded", current.ask.id);
    } else if (v !== "open" && was === "open") {
      arm(false);
      J.card("expanded", null);
    }
  }
  if (v !== "open" && document.activeElement === box) (box.blur(), J.card("focus", false));
  schedule();
}

function peekFor(c) {
  if (c.brief) return 1800;
  const words = String(c.line || "").split(/\s+/).length;
  return Math.min(Math.max(3000, words * 240 + 1200), 5500);
}

function lingerFor(c) {
  if (c.state === "speaking") return SPEAKING_MAX_MS;
  return c.kind === "needs_input" || c.kind === "error" ? 45_000 : 15_000;
}

// One timer decides what happens next from the current view.
function schedule() {
  clearTimeout(timer);
  if (hovering) return;
  if (view === "list") return void (timer = setTimeout(() => setView(idle()), LIST_LEAVE_MS));
  if (!current) return;
  if (view === "peek") timer = setTimeout(() => setView(current?.brief ? idle() : "mini"), peekFor(current));
  else if (view === "mini" && !current.ask) timer = setTimeout(() => setView(idle()), lingerFor(current));
  else if (view === "open") timer = setTimeout(foldIfIdle, LEAVE_MS);
}

function foldIfIdle() {
  if (hovering || busy || rec || transcribing || document.activeElement === box || (current?.ask && box.value.trim())) return;
  setView(current?.brief ? idle() : "mini");
}

// ---------- questions ----------

const choiceButtons = () => [$("allow"), $("always"), $("deny"), $("terminal"), $("send"), $("replyTerminal")];

function setBusy(on) {
  busy = on;
  for (const b of choiceButtons()) b.disabled = on || b.dataset.armed !== "1";
}

function arm(on) {
  clearTimeout(armTimer);
  for (const b of choiceButtons()) b.dataset.armed = on ? "1" : "0";
  setBusy(false);
  if (!on && view === "open") armTimer = setTimeout(() => arm(true), ARM_MS);
}

function startTimer(expiresAt) {
  const bar = $("timerBar");
  const left = Math.max(0, expiresAt - Date.now());
  bar.style.transition = "none";
  bar.style.transform = "scaleX(1)";
  void bar.offsetWidth;
  bar.style.transition = `transform ${left}ms linear`;
  bar.style.transform = "scaleX(0)";
}

function showAsk(c) {
  const a = c.ask;
  const perm = a.kind === "permission";
  $("ask").hidden = false;
  $("detail").textContent = a.detail || "";
  $("detail").hidden = !a.detail;
  $("why").textContent = a.why || "";
  $("why").hidden = !a.why;
  $("rule").textContent = a.canAlways && a.alwaysRule ? `Always allow adds: ${a.alwaysRule}` : "";
  $("rule").hidden = !$("rule").textContent;
  $("allow").hidden = Boolean(a.partial);
  $("askErr").textContent = a.partial ? "Too long to approve here. Check the whole command in the terminal." : "";
  $("choices").hidden = !perm;
  $("always").hidden = !a.canAlways;
  $("reply").hidden = perm;
  $("mic").hidden = perm || !a.canDictate;
  box.value = "";
  box.placeholder = `Reply to ${c.agentName || "the agent"}…  (Enter to send, Shift+Enter for a new line)`;
  $("askErr").hidden = !a.partial;
  arm(false);
  startTimer(a.expiresAt);
}

function hideAsk() {
  stopDictation(true);
  $("ask").hidden = true;
  clearTimeout(armTimer);
  if (document.activeElement === box) box.blur();
}

async function answer(payload) {
  if (!current?.ask || busy || view !== "open") return;
  const id = current.ask.id;
  setBusy(true);
  let r;
  try {
    r = await J.answer(id, payload);
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  if (r?.ok || current?.ask?.id !== id) return; // the app has already moved the card on
  $("askErr").textContent = r?.error || "Couldn't send that.";
  $("askErr").hidden = false;
  setBusy(false);
  reportSize();
}

$("allow").addEventListener("click", () => answer({ behavior: "allow" }));
$("always").addEventListener("click", () => answer({ behavior: "always" }));
$("deny").addEventListener("click", () => answer({ behavior: "deny" }));
const toTerminal = () => current?.ask && view === "open" && J.card("defer", current.ask.id);
$("terminal").addEventListener("click", toTerminal);
// Reply from the notch: turn this done line into a reply box for its session. The island keeps
// the line's colour (no amber); sending goes through the same checked path as question replies.
$("replyBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  if (!current?.reply) return;
  pointerEntered();
  current = { ...current, ask: { id: current.reply.id, kind: "reply", expiresAt: current.reply.expiresAt, canDictate: Boolean(current.reply.canDictate) } };
  $("replyBtn").hidden = true;
  showAsk(current);
  setView("open", true);
  // You clicked Reply, so the box may take the keyboard (same request the box itself makes on click).
  requestAnimationFrame(async () => {
    reportSize();
    await J.card("focus", true);
    box.focus();
  });
});
$("replyTerminal").addEventListener("click", toTerminal);

// ---------- voice replies ----------
// Tap the mic to record, tap again to stop (60 s at most). The clip is turned into text by the app
// (Earpiece Pro, or your own OpenAI key) and lands in the box. Nothing is sent until you press Send.
const MAX_REC_MS = 60_000;
let rec = null; // { recorder, stream, timer }
let transcribing = false;

function replyError(msg) {
  $("askErr").textContent = msg || "Something went wrong.";
  $("askErr").hidden = false;
  reportSize();
}

async function startDictation() {
  if (rec || transcribing || !current?.ask) return;
  $("askErr").hidden = true;
  const ok = await J.dictate("start");
  if (!ok?.ok) return replyError(ok?.error);
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return replyError("Couldn't open the microphone.");
  }
  const chunks = [];
  const recorder = new MediaRecorder(stream, MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? { mimeType: "audio/webm;codecs=opus" } : undefined);
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    $("mic").classList.remove("recording");
    if (recorder.cancelled || !chunks.length) return;
    transcribing = true;
    $("mic").classList.add("busy");
    const type = (recorder.mimeType || "audio/webm").split(";")[0];
    const r = await J.dictate("transcribe", new Uint8Array(await new Blob(chunks, { type }).arrayBuffer()), type);
    transcribing = false;
    $("mic").classList.remove("busy");
    if (!r?.ok) return replyError(r?.error);
    if (r.text) box.value = box.value.trim() ? `${box.value.trimEnd()} ${r.text}` : r.text;
    await J.card("focus", true); // you tapped the mic, so the box may take the keyboard to review and send
    box.focus();
    reportSize();
  };
  recorder.start();
  rec = { recorder, stream, timer: setTimeout(() => stopDictation(false), MAX_REC_MS) };
  $("mic").classList.add("recording");
  $("mic").title = "Stop recording";
}

function stopDictation(cancel) {
  if (!rec) return;
  const r = rec;
  rec = null;
  clearTimeout(r.timer);
  $("mic").title = "Speak your reply (it lands in the box; you press Send)";
  if (cancel) r.recorder.cancelled = true;
  if (r.recorder.state !== "inactive") r.recorder.stop();
  else r.stream.getTracks().forEach((t) => t.stop());
}

$("mic").addEventListener("click", (e) => {
  e.stopPropagation();
  if (rec) stopDictation(false);
  else startDictation();
});

// The island never takes the keyboard on its own. Clicking into the box makes it focusable;
// the app gives the keyboard back to your terminal when the box is done with.
box.addEventListener("mousedown", async (e) => {
  if (document.activeElement === box) return;
  e.preventDefault();
  await J.card("focus", true);
  box.focus();
});
box.addEventListener("blur", () => {
  if (!box.value.trim()) J.card("focus", false);
  schedule();
});
box.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    box.blur();
    J.card("focus", false);
  } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (box.value.trim()) answer({ text: box.value });
  }
});
$("send").addEventListener("click", () => box.value.trim() && answer({ text: box.value }));

// ---------- showing cards ----------

function setLogo(el, agentId) {
  el.querySelector(".logo")?.remove();
  el.prepend(window.EarpieceLogos.logo(agentId));
}

function show(c) {
  // A soft reply ended without an answer (timed out, you typed in the terminal, a newer turn).
  if (c.state === "reply-gone") {
    if (current?.reply?.id !== c.replyId) return;
    current.reply = null;
    $("replyBtn").hidden = true;
    if (current.ask?.id === c.replyId) {
      current.ask = null;
      hideAsk();
      setView(idle());
    }
    return;
  }
  if (c.state === "clear") {
    if (current?.ask) {
      current = null;
      hideAsk();
      if (view !== "list") setView(idle());
    }
    return;
  }
  const same = current && current.id === c.id && view !== "gone";
  const isAsk = Boolean(c.ask);
  const wasAskId = current?.ask?.id || null;
  current = c;
  // A silent "needs you" or error keeps its colour; only the voice is held back.
  island.className = `island ${c.kind} ${c.state}${isAsk ? " asking" : ""}`;
  if (!same) {
    setLogo($("avatar"), c.agentId);
    setLogo($("miniLogo"), c.agentId);
    $("who").textContent = c.agentName || "Earpiece";
    $("miniName").textContent = c.agentName || "Earpiece";
    $("project").textContent = c.project || "";
    $("line").textContent = c.line;
    island.title = isAsk ? "" : c.line;
    $("full").querySelector(".head").title = isAsk ? "" : `Go to ${c.agentName || "the agent"}`;
    $("close").title = isAsk ? "Fold back into the notch" : "Dismiss";
    if (isAsk) showAsk(c);
    else hideAsk();
  }
  $("replyBtn").hidden = !(c.reply && !isAsk);
  const chip = $("chip");
  const urgent = c.kind === "needs_input" ? "Needs you" : c.kind === "error" ? "Error" : "";
  const hush = c.state === "silent" ? REASON[c.reason] || "Silent" : "";
  let label = [urgent, hush].filter(Boolean).join(" · ");
  if (isAsk && c.more > 0) label += ` · +${c.more} more`;
  chip.textContent = label;
  chip.hidden = !label;
  $("miniCount").textContent = isAsk && c.more > 0 ? String(c.more + 1) : "";
  $("miniCount").hidden = !(isAsk && c.more > 0);

  requestAnimationFrame(() => {
    reportSize();
    if (view === "list" && hovering) return; // you're looking at the list; the row has the news
    if (isAsk) {
      // A new question while you have one open: keep it open, re-arm for the new one.
      if (view === "open") return wasAskId !== c.ask.id ? setView("open", true) : undefined;
      return setView("mini", true);
    }
    if (same) return setView(view, true); // e.g. speaking -> spoken: keep the view, size and timers fresh
    if (view === "open" && hovering) return setView("open", true); // you're reading: swap the text in place
    if (view === "gone") {
      // Start from the notch's own size so it visibly grows out of it.
      setView("gone", true);
      void island.offsetWidth;
    }
    setView("peek", true);
  });
}

// ---------- the agents list ----------

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderRest() {
  const { active, waiting, tone, mode } = agents;
  island.dataset.tone = tone;
  island.dataset.mode = mode || "on";
  $("restCount").textContent = active ? String(active) : "";
  const bits = [active ? `${active} running` : "No agents running"];
  if (waiting) bits.push(`${waiting} need${waiting === 1 ? "s" : ""} you`);
  if (mode && mode !== "on") bits.push(mode === "off" ? "Earpiece is off" : "Quiet");
  $("rest").title = `Earpiece: ${bits.join(", ")}`;
  if (view === "rest") setView("rest", true); // the pill's width follows the count off-notch
}

function renderAgents() {
  const list = $("agentRows");
  const now = Date.now();
  const skew = now - (agents.now || now); // ages are counted from the app's clock
  list.replaceChildren(
    ...agents.rows.map((r) => {
      const li = el("li", r.status);
      li.title = `Go to ${r.agent}${r.project ? ` · ${r.project}` : ""}`;
      const av = el("span", "av");
      av.append(window.EarpieceLogos.logo(r.agentId));
      const tx = el("div", "tx");
      const mt = el("div", "mt");
      mt.append(el("b", "", r.agent), el("span", "pj", r.project || ""), el("span", "st", STATUS[r.status] || r.status), el("span", "age", r.updated ? ago(now - skew - r.updated) : ""));
      tx.append(mt);
      if (r.lastLine) tx.append(el("p", "ln", r.lastLine));
      li.append(av, tx);
      li.addEventListener("click", (e) => {
        e.stopPropagation();
        J.card("jump", { agent: r.agentId, session: r.session });
        setView(idle());
      });
      return li;
    }),
  );
  $("agentsEmpty").hidden = agents.rows.length > 0;
  $("agentsSub").textContent = agents.active ? `${agents.active} running` : "";
  $("agentsMore").textContent = agents.more ? `+${agents.more} more` : "";
  for (const b of $("modes").querySelectorAll("button")) b.classList.toggle("on", b.dataset.mode === (agents.mode || "on"));
}

function onAgents(a) {
  agents = { ...agents, ...(a || {}) };
  if (typeof a?.rest === "boolean") setRest(a.rest);
  renderRest();
  renderAgents();
  requestAnimationFrame(() => {
    reportSize();
    if (view === "list") setView("list", true); // the list grew or shrank
  });
}

function setRest(on) {
  rest = Boolean(on);
  if (rest && view === "gone") setView("rest");
  else if (!rest && (view === "rest" || view === "list")) setView("gone");
}

for (const b of $("modes").querySelectorAll("button")) {
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    const m = b.dataset.mode;
    J.setMode(m, m === "quiet" ? 60 : 0);
  });
}
$("openDash").addEventListener("click", (e) => {
  e.stopPropagation();
  J.card("open");
  setView(idle());
});

setLogo($("restMark"), null); // the Earpiece wave

J.onCard(show);
J.onGeom?.(applyGeom);
J.onAgents?.(onAgents);
J.onRest?.(setRest);
applyGeom(geom);

function pointerEntered() {
  if (hovering) return;
  J.card("hover", true);
}
island.addEventListener("mouseenter", pointerEntered);
// After the app has said the pointer left, the page may not see a fresh mouseenter.
island.addEventListener("mousemove", pointerEntered);
function pointerLeft() {
  if (!hovering) return;
  hovering = false;
  schedule();
}
island.addEventListener("mouseleave", () => {
  J.card("hover", false);
});
// Only the native cursor check can end hover. CSS expansion and click-through changes can
// emit mouseleave while the pointer is still moving into the full panel.
J.onPointer?.((inside) => {
  if (!inside) return pointerLeft();
  hovering = true;
  clearTimeout(timer);
});
island.addEventListener("click", (e) => {
  pointerEntered();
  if (view === "rest") return setView("list");
  if (view === "list") return; // rows and buttons handle their own clicks
  if (!current) return;
  if (view === "mini") return setView("open");
  if (e.target.closest("#close")) return setView(idle());
  if (current.ask) return; // only the buttons act on a question
  if (e.target.closest("#stop")) return J.card("stop");
  if (e.target.closest(".head")) {
    // Take you to the agent's terminal tab or window; the app opens the dashboard if it can't.
    J.card("jump", { agent: current.agentId || null, session: current.session || null });
    setView(idle());
  }
});
