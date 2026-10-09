// Popover: live list of agent sessions plus the mode switch. Talks to the app only through
// window.earpiece (preload.cjs).
const $ = (id) => document.getElementById(id);
$("wave").append(window.EarpieceLogos.mascot());
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const OPEN = new Set(["waiting", "working", "error"]);
const LABEL = { waiting: "needs you", working: "working", done: "done", error: "error", idle: "idle" };

function statusText(s) {
  const bits = [];
  if (!s.hub.ok) bits.push(`<span class="warn">${esc(s.hub.error || "Hub not running")}</span>`);
  if (s.mode === "quiet") bits.push(`Quiet${s.until ? ` until ${new Date(s.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}: only “needs you” pings`);
  else if (s.mode === "off") bits.push("Off: Earpiece won't speak");
  else if (s.quietNow) {
    const allow = Array.isArray(s.quietHours?.allow) ? s.quietHours.allow : ["needs_input"];
    bits.push(`Quiet hours until ${esc(s.quietHours.end)}${allow.length ? "" : ": fully silent"}`);
  }
  const waiting = s.sessions.filter((r) => r.status === "waiting").length;
  const working = s.sessions.filter((r) => r.status === "working").length;
  if (s.sessions.length) bits.push(`${working} working · ${waiting} waiting on you`);
  return bits.join(" · ");
}

function render(s) {
  $("list").addEventListener("click", async (e) => {
  const b = e.target.closest(".done-btn");
  if (!b) return;
  b.disabled = true;
  try {
    await window.earpiece.session("done", b.dataset.agent, b.dataset.session);
  } catch {
    b.disabled = false;
  }
});

for (const b of document.querySelectorAll(".seg button")) b.setAttribute("aria-checked", String(b.dataset.mode === s.mode));
  $("wave").classList.toggle("on", s.speaking);
  $("status").innerHTML = statusText(s);

  const connected = s.hooks.some((h) => h.target === "app");
  $("connect").hidden = connected && $("connectResult").hidden;

  const list = $("list");
  if (!s.sessions.length) {
    list.innerHTML = `<div class="empty">${connected ? "No agent activity in the last 24 hours.<br />Start Claude Code or Codex and it shows up here." : ""}</div>`;
    return;
  }
  const now = Date.now();
  list.innerHTML = s.sessions
    .map(
      (r) => `<div class="row ${esc(r.status)}" title="${esc(LABEL[r.status] || r.status)}">
        <span class="dot" data-agent="${esc(r.agentId || "")}"></span>
        <span class="name">${esc(r.project)}<small>${esc(r.agent)}</small></span>
        <span class="age">${ago(now - r.updated)}${OPEN.has(r.status) ? `<button class="done-btn" data-agent="${esc(r.agentId || "")}" data-session="${esc(r.session || "")}" title="Mark done" aria-label="Mark done">✓</button>` : ""}</span>
        ${r.lastLine ? `<span class="line">${esc(r.lastLine)}</span>` : ""}
      </div>`,
    )
    .join("");
  // Logos are built as DOM nodes, not HTML strings.
  for (const d of list.querySelectorAll(".dot[data-agent]")) d.append(window.EarpieceLogos.logo(d.dataset.agent));
}

for (const b of document.querySelectorAll(".seg button"))
  b.addEventListener("click", () => window.earpiece.setMode(b.dataset.mode, b.dataset.mode === "quiet" ? 60 : 0));
$("stopBtn").addEventListener("click", () => window.earpiece.stop());
$("testBtn").addEventListener("click", async () => {
  $("testBtn").disabled = true;
  try {
    await window.earpiece.testVoice();
  } finally {
    $("testBtn").disabled = false;
  }
});
$("moreBtn").addEventListener("click", () => window.earpiece.menu());
$("openBtn").addEventListener("click", () => window.earpiece.showMain());
$("connectBtn").addEventListener("click", async () => {
  $("connectBtn").disabled = true;
  const out = await window.earpiece.connect();
  $("connectResult").textContent = out;
  $("connectResult").hidden = false;
  $("connectBtn").textContent = "Connected";
  // Leave the result up long enough to read, then give the space back to the session list.
  setTimeout(() => {
    $("connectResult").hidden = true;
    window.earpiece.state().then(render);
  }, 8000);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.earpiece.hide();
});

window.earpiece.onState(render);
window.earpiece.state().then(render);
setInterval(() => window.earpiece.state().then(render), 30_000);
