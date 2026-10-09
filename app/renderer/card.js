// The notch island. The app sends it one card at a time, plus the shape of the screen it is on
// (notch or not), the list of running agents and what is waiting on you. Six views:
//   gone  - nothing on screen (the app hides the window); only when the resting icon is off
//   rest  - the resting icon: Earpiece mark and a count on the left wing (amber: how many need
//           you; else how many run), a status dot on the right; click for the panel
//   list  - the panel, dropped down from the notch: "Needs you" (panel.js) and "Agents"
//   mini  - collapsed into the notch after a line: agent logo on the left, wave or dot on the right
//   peek  - a new line opens it for a few seconds, then it folds back into the notch
//   open  - you clicked a line; it stays open while the pointer is on it
// A question an agent is waiting on never opens by itself: the island turns amber and pulses in
// the notch until you click it, which opens the panel on it. Nothing is approved without a key or
// a click there, held 2 s so Esc can take it back.
const J = window.earpiece;
const $ = (id) => document.getElementById(id);
const island = $("card");
const P = window.EarpiecePanel;
const REASON = { mode_quiet: "Quiet", quiet_hours: "Quiet hours", agent_disabled: "Muted", voice_failed: "No voice" };

const FULL_W = 460; // the window is 480 wide; 10 px either side for the curved shoulders
const WING = 46; // each wing next to the notch, collapsed
const VIRTUAL = { w: 230, h: 32 }; // the collapsed pill on a screen without a notch
const REST_WING = 36; // each wing of the resting icon
const REST_VIRTUAL_H = 24; // the resting pill on a screen without a notch
const STATUS = { waiting: "Needs you", error: "Error", working: "Working", done: "Done", idle: "Idle" };
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
let timer = null;
let goneTimer = null;
let rest = false; // the app wants the island resting in the notch between lines
let touched = false; // the pointer has been on the open panel (opened with ⌥⌘I it hasn't, yet)
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
  if (was === "list" && v !== "list") (P.close(), J.card("panel", false)); // the keyboard goes back
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
  // The pointer left the panel: fold, unless you're typing in it or an answer is still held.
  if (view === "list") return void (touched && (timer = setTimeout(() => !document.activeElement?.matches?.("input, textarea, select") && !P.busy() && setView(idle()), LIST_LEAVE_MS)));
  if (!current) return;
  if (view === "peek") timer = setTimeout(() => setView(current?.brief ? idle() : "mini"), peekFor(current));
  else if (view === "mini" && !current.ask) timer = setTimeout(() => setView(idle()), lingerFor(current));
  else if (view === "open") timer = setTimeout(foldIfIdle, LEAVE_MS);
}

function foldIfIdle() {
  if (hovering) return;
  setView(current?.brief ? idle() : "mini");
}

// ---------- the panel ----------

// Needs you when something waits (or you asked for one item), otherwise your agents. Opening it is
// the one time the island takes the keyboard (1-9, J, K); folding it gives the keyboard back.
function openPanel(focus = null, reply = false) {
  if (focus) P.focus(focus, reply);
  else P.setTab(P.count() ? "needs" : "agents");
  touched = hovering;
  if (view !== "list") J.card("panel", true);
  setView("list", true);
}
const closePanel = () => view === "list" && setView(idle());
window.addEventListener("panel-close", closePanel);
window.addEventListener("panel-resize", () => view === "list" && setView("list", true));
// You clicked somewhere else: the panel had the keyboard, so it folds like a menu would. Not while
// you'd lose something, or while Pro's run form has a folder picker open.
window.addEventListener("blur", () => !P.busy() && !document.activeElement?.closest?.("#runs") && closePanel());
document.addEventListener("keydown", (e) => view === "list" && P.onKey(e));
$("tabNeeds").addEventListener("click", (e) => (e.stopPropagation(), P.setTab("needs")));
$("tabAgents").addEventListener("click", (e) => (e.stopPropagation(), P.setTab("agents")));

// Reply on a finished line: the panel opens on that session, with its reply box.
$("replyBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  if (!current?.reply) return;
  pointerEntered();
  openPanel(`s:${current.agentId}:${current.session}`, true);
});

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
    return;
  }
  if (c.state === "clear") {
    if (current?.ask) {
      current = null;
      if (view !== "list") setView(idle());
    }
    return;
  }
  const same = current && current.id === c.id && view !== "gone";
  const isAsk = Boolean(c.ask);
  current = c;
  // A silent "needs you" or error keeps its colour; only the voice is held back.
  island.className = `island ${c.kind} ${c.state}${isAsk ? " asking" : ""}${c.soft ? " soft" : ""}`;
  if (!same) {
    setLogo($("avatar"), c.agentId);
    setLogo($("miniLogo"), c.agentId);
    $("who").textContent = c.agentName || "Earpiece";
    $("miniName").textContent = c.agentName || "Earpiece";
    $("project").textContent = c.project || "";
    $("line").textContent = c.line;
    island.title = isAsk ? "" : c.line;
    $("full").querySelector(".head").title = isAsk ? "" : `Go to ${c.agentName || "the agent"}`;
  }
  $("replyBtn").hidden = !(c.reply && !isAsk);
  const chip = $("chip");
  const urgent = c.kind === "needs_input" ? "Needs you" : c.kind === "error" ? "Error" : "";
  const hush = c.state === "silent" ? REASON[c.reason] || "Silent" : "";
  let label = [urgent, hush].filter(Boolean).join(" · ");
  chip.textContent = label;
  chip.hidden = !label;
  $("miniCount").textContent = isAsk && c.more > 0 ? String(c.more + 1) : "";
  $("miniCount").hidden = !(isAsk && c.more > 0);

  requestAnimationFrame(() => {
    reportSize();
    if (view === "list") return; // the panel is open; its lists have the news
    // A question waits in the notch, amber, until you click it.
    if (isAsk) return setView("mini", true);
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
  // Amber: how many things the panel has waiting for you. Otherwise how many agents run.
  const needs = P.count();
  $("restCount").textContent = needs ? String(needs) : active ? String(active) : "";
  $("restCount").classList.toggle("needs", needs > 0);
  const bits = [active ? `${active} running` : "No agents running"];
  if (needs || waiting) bits.unshift(`${needs || waiting} need${(needs || waiting) === 1 ? "s" : ""} you`);
  if (mode && mode !== "on") bits.push(mode === "off" ? "Earpiece is off" : "Quiet");
  $("rest").title = `Earpiece: ${bits.join(", ")}`;
  if (view === "rest") setView("rest", true); // the pill's width follows the count off-notch
}

function renderAgents() {
  const list = $("agentRows");
  const now = Date.now();
  const skew = now - (agents.now || now); // ages are counted from the app's clock
  list.replaceChildren(
    ...agents.rows.filter((r) => !r.run).map((r) => {
      const li = el("li", r.status);
      li.title = `Go to ${r.agent}${r.project ? ` · ${r.project}` : ""}`;
      const av = el("span", "av");
      av.append(window.EarpieceLogos.logo(r.agentId));
      const tx = el("div", "tx");
      const mt = el("div", "mt");
      mt.append(el("b", "", r.agent), el("span", "pj", r.project || ""), el("span", "st", STATUS[r.status] || r.status), el("span", "age", r.updated ? ago(now - skew - r.updated) : ""));
      tx.append(mt);
      if (r.lastLine) tx.append(el("p", "ln", r.lastLine));
      // ×: off the list (it comes back with the agent's next update).
      const x = el("button", "rm", "×");
      x.title = "Clear from the list";
      x.setAttribute("aria-label", `Clear ${r.agent}${r.project ? ` · ${r.project}` : ""}`);
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        li.remove();
        J.session("forget", r.agentId, r.session).catch(() => {});
      });
      li.append(av, tx, x);
      li.addEventListener("click", (e) => {
        e.stopPropagation();
        J.card("jump", { agent: r.agentId, session: r.session });
        setView(idle());
      });
      return li;
    }),
  );
  $("agentsEmpty").hidden = agents.rows.length > 0;
  $("agentsSub").textContent = agents.active ? String(agents.active) : "";
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
J.onInbox?.((l) => (P.update(l), renderRest()));
J.onPanel?.((m) => openPanel(m?.focus || null));
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
  if (view === "list") touched = true;
  clearTimeout(timer);
});
island.addEventListener("click", (e) => {
  pointerEntered();
  if (view === "rest") return openPanel();
  if (view === "list") return; // rows and buttons handle their own clicks
  if (!current) return;
  if (view === "mini") return current.ask ? openPanel(current.ask.id) : setView("open");
  // × while a line is playing stops it too, like ■: dismissing it means you don't want to hear it.
  if (e.target.closest("#close")) {
    if (current.state === "speaking") J.card("stop");
    return setView(idle());
  }
  if (e.target.closest("#stop")) return J.card("stop");
  if (e.target.closest(".head")) {
    // Take you to the agent's terminal tab or window; the app opens the dashboard if it can't.
    J.card("jump", { agent: current.agentId || null, session: current.session || null });
    setView(idle());
  }
});
