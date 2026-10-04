// Main window. Talks to the app only through window.earpiece (preload.cjs). Everything is built
// with DOM calls, so text from logs or agents is never parsed as HTML.
const J = window.earpiece;
const $ = (id) => document.getElementById(id);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "style") el.style.cssText = v; // CSSOM, allowed by the CSP (a style attribute is not)
    else if (k === "checked" || k === "disabled" || k === "selected") el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const SECTIONS = {
  overview: "Overview",
  agents: "Agents",
  voice: "Voice",
  quiet: "Quiet",
  keys: "API Keys",
  activity: "Activity",
  general: "General",
};
const STATUS = { waiting: "needs you", working: "working", done: "done", error: "error", idle: "idle" };
const KIND_LABEL = { needs_input: "Needs you (questions, approvals)", error: "Errors", done: "Finished work", info: "Other updates" };

let D = null; // last data() payload
let section = "overview";
let voiceList = null; // { model, list } or { model, error }
let voiceFilter = { q: "", gender: "", accent: "", lang: "" };
let macVoiceList = null;
let activityFilter = "all";
const agentOutput = {};

// ---------- helpers ----------

function ago(t) {
  if (!t) return "never";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const dayClock = (t) => {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today ? clock(t) : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${clock(t)}`;
};

let toastTimer;
function toast(msg, err = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("err", err);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), err ? 6000 : 3000);
}

// Run a dashboard action; show failures as a toast instead of throwing.
async function act(name, args, { ok, quiet } = {}) {
  try {
    const v = await J.dash(name, args);
    if (ok) toast(ok);
    return v;
  } catch (e) {
    if (!quiet) toast(e.message || String(e), true);
    throw e;
  }
}

async function reload() {
  D = await J.dash("data");
  chrome();
}

async function saveConfig(patch, msg = "Saved") {
  try {
    const settings = await act("setConfig", { patch }, { ok: msg });
    D.settings = settings;
  } catch {}
  render();
}

function sw(checked, onchange, label) {
  return h("label", { class: "switch", title: label }, h("input", { type: "checkbox", role: "switch", "aria-label": label, checked, onchange: (e) => onchange(e.target.checked) }), h("span"));
}

function row(title, sub, ...ctrl) {
  return h("div", { class: "row" }, h("div", { class: "label" }, title, sub ? h("small", {}, sub) : null), h("div", { class: "ctrl" }, ...ctrl));
}

function select(options, value, onchange, label) {
  return h(
    "select",
    { "aria-label": label, onchange: (e) => onchange(e.target.value) },
    options.map(([v, l]) => h("option", { value: v, selected: v === value }, l)),
  );
}

function btn(text, onclick, cls = "") {
  return h("button", {
    class: `btn ${cls}`,
    onclick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        await onclick(e);
      } catch {
      } finally {
        b.disabled = false;
      }
    },
  }, text);
}

function modeSeg() {
  const set = (mode) => J.setMode(mode, mode === "quiet" ? 60 : 0);
  return h(
    "div",
    { class: "seg", role: "radiogroup", "aria-label": "Mode" },
    ["on", "quiet", "off"].map((m) => h("button", { role: "radio", "aria-checked": String(D.mode === m), onclick: () => set(m) }, m[0].toUpperCase() + m.slice(1))),
  );
}

function modeSentence() {
  if (!D.hub.ok) return { dot: "off", text: "Hub not running", sub: D.hub.error || "Earpiece can't hear your agents right now. Quit and reopen the app." };
  if (D.mode === "off") return { dot: "off", text: "Off", sub: D.until ? `Back on at ${clock(D.until)}` : "Earpiece won't speak until you turn it back on." };
  if (D.mode === "quiet") return { dot: "quiet", text: "Quiet", sub: `Shows every update in the notch without speaking${D.until ? `, until ${clock(D.until)}` : ""}.` };
  if (D.quietNow) {
    const allow = Array.isArray(D.quietHours?.allow) ? D.quietHours.allow : ["needs_input"];
    return { dot: "quiet", text: "Quiet hours", sub: allow.length ? `Until ${D.quietHours.end}. Still says: ${allow.map((k) => KIND_LABEL[k]?.split(" (")[0].toLowerCase()).join(", ")}.` : `Silent until ${D.quietHours.end}.` };
  }
  return { dot: "on", text: "Listening", sub: "Speaks when an agent finishes, needs you, or fails." };
}

// Sidebar badge, footer, speaking wave, header border.
function chrome() {
  if (!D) return;
  const waiting = D.sessions.filter((s) => s.status === "waiting").length;
  $("navWaiting").hidden = !waiting;
  $("navWaiting").textContent = waiting;
  $("wave").classList.toggle("on", Boolean(D.speaking));
  const m = modeSentence();
  $("sideMode").replaceChildren(h("span", { class: `dot ${m.dot}` }), m.text);
  if (section === "overview") {
    const spk = document.querySelector("[data-speaking]");
    if (spk) spk.hidden = !D.speaking;
  }
}

// ---------- sections ----------

// ---------- updates ----------
// The app checks GitHub a few seconds after launch and every 6 hours (main/updater.mjs). With
// one click it downloads, checks and installs the new version, then reopens.
let laterFor = null; // the version you said "Later" to; the banner comes back for the next one
const UPDATE_BUSY = new Set(["downloading", "verifying", "installing"]);
function updateBanner(where) {
  const u = D.update;
  if (!u?.newer) return null;
  const busy = UPDATE_BUSY.has(u.status);
  if (where === "overview" && laterFor === u.latest && !busy && u.status !== "failed") return null;
  const pct = Math.round((u.progress || 0) * 100);
  const title =
    u.status === "downloading" ? `Downloading Earpiece ${u.latest}… ${pct}%`
    : u.status === "verifying" ? "Checking the download…"
    : u.status === "installing" ? "Installing. Earpiece reopens in a moment."
    : u.status === "failed" ? "The update didn't finish"
    : `Earpiece ${u.latest} is out`;
  const sub =
    busy ? "Keep working. Nothing changes until the new version is ready."
    : u.status === "failed" ? `${(u.error || "").replace(/^Update failed: /, "").replace(/^./, (c) => c.toUpperCase())}. Download it and drag it to Applications instead; your settings stay.`
    : u.oneClick ? `You have ${u.current}. Update installs it and reopens Earpiece.`
    : `You have ${u.current}. ${u.blocker || "Download it and drag it to Applications."}`;
  const install = async () => {
    const r = await act("installUpdate");
    if (r && !r.oneClick && r.status !== "failed") toast("Opening the download in your browser");
  };
  return h(
    "div",
    { class: `group update-banner ${u.status}` },
    h(
      "div",
      { class: "row" },
      h("div", { class: "label" }, h("b", {}, title), h("small", {}, sub.trim())),
      busy
        ? h("div", { class: "update-bar", role: "progressbar", "aria-valuenow": String(pct) }, h("i", { style: `width:${u.status === "downloading" ? pct : 100}%` }))
        : h(
            "div",
            { class: "ctrl" },
            where === "overview" ? btn("Later", () => ((laterFor = u.latest), render())) : null,
            btn("What's new", () => act("openUrl", { url: u.url })),
            u.oneClick && u.status !== "failed" ? btn("Update", install, "primary") : btn("Download", () => act("downloadUpdate"), "primary"),
          ),
    ),
  );
}

// Always on Overview for anyone not on Pro. Signed out, the button signs in first: Pro needs an account.
function proBanner() {
  if (D.account?.plan?.plan === "pro") return null;
  const signedIn = Boolean(D.account?.user);
  return h(
    "div",
    { class: "group pro-banner" },
    row(
      "Upgrade to Earpiece Pro",
      "Natural voices and one-line summaries on Earpiece's keys, so you don't need any API keys. $10 a month, or $96 a year.",
      signedIn ? btn("Upgrade", () => act("upgrade", { interval: "month" }), "primary") : btn("Sign in to upgrade", () => act("signIn"), "primary"),
    ),
  );
}

function overview() {
  const m = modeSentence();
  const connected = D.agents.filter((a) => a.target);
  const s = D.stats;
  const parts = [
    updateBanner("overview"),
    proBanner(),
    h(
      "div",
      { class: "group" },
      h(
        "div",
        { class: "hero" },
        h("span", { class: `dot ${m.dot}`, style: "width:12px;height:12px" }),
        h("div", { class: "label", style: "flex:1" }, h("div", { class: "big" }, m.text), h("div", { class: "sub" }, m.sub)),
        h("button", { class: "btn", "data-speaking": "", hidden: !D.speaking, onclick: () => J.stop() }, "Stop speaking"),
        modeSeg(),
      ),
    ),
  ];
  if (!connected.length)
    parts.push(
      h("h2", {}, "Get started"),
      h("div", { class: "group" }, row("No agents connected yet", "Connect Claude Code, Codex or Claude Desktop so Earpiece can hear them.", btn("Set up agents", () => go("agents"), "primary"))),
    );
  parts.push(
    h("h2", {}, "Today"),
    h(
      "div",
      { class: "stats" },
      h("div", { class: "stat" }, h("b", {}, s.spoken), h("span", {}, "spoken")),
      h("div", { class: "stat" }, h("b", {}, s.skipped), h("span", {}, "kept quiet")),
      h("div", { class: "stat" }, h("b", { class: s.failed ? "err" : "" }, s.failed), h("span", {}, "problems")),
      h("div", { class: "stat" }, h("b", {}, connected.length), h("span", {}, `agent${connected.length === 1 ? "" : "s"} connected`)),
    ),
  );
  if (s.lastSpoke)
    parts.push(
      h("h2", {}, "Last thing Earpiece said"),
      h("div", { class: "group" }, row(h("span", { class: "last selectable" }, `“${s.lastSpoke.text}”`), `${ago(s.lastSpoke.at)}${s.lastSpoke.engine ? ` · ${s.lastSpoke.engine}` : ""}`)),
    );
  parts.push(h("h2", {}, "Sessions in the last 24 hours"));
  if (!D.sessions.length) parts.push(h("div", { class: "group" }, h("div", { class: "empty" }, connected.length ? "Nothing yet. Start an agent and it shows up here." : "Connect an agent to see its sessions here.")));
  else
    parts.push(
      h(
        "div",
        { class: "group" },
        D.sessions.map((r) =>
          h(
            "div",
            { class: "row session" },
            h("span", { class: "mini-mark", title: r.agent }, window.EarpieceLogos.logo(r.agentId), h("span", { class: `dot ${r.status}` })),
            h("div", { class: "label" }, h("b", {}, r.project || "Untitled"), h("small", { class: "clip" }, [r.agent, r.where, r.lastLine].filter(Boolean).join(" · "))),
            h("span", { class: `pill ${r.status}` }, STATUS[r.status] || r.status),
            h("time", {}, ago(r.updated)),
            sessionActions(r),
          ),
        ),
      ),
    );
  return parts;
}

// "Mark done" for anything still open, plus a quiet "Forget" that drops the row. Both go through
// the main process, which only touches sessions that exist.
const OPEN = new Set(["waiting", "working", "error"]);
function sessionActions(r) {
  const run = async (action, msg) => {
    try {
      await J.session(action, r.agentId, r.session);
      toast(msg);
      await reload();
    } catch (e) {
      toast(e.message || String(e), true);
    }
  };
  return h(
    "div",
    { class: "ctrl session-actions" },
    btn("Open", async () => {
      // Brings forward the agent's terminal tab or editor window (or just its app).
      try {
        await J.session("jump", r.agentId, r.session);
      } catch (e) {
        toast(e.message || String(e), true);
      }
    }),
    OPEN.has(r.status) ? btn("Mark done", () => run("done", `${r.project || "Session"} marked done`)) : null,
    h("button", { class: "icon-btn", title: "Forget this session", "aria-label": "Forget this session", onclick: () => run("forget", "Session removed") }, "×"),
  );
}

function agentStatus(a) {
  if (a.target === "emit") return ["connected", "Sends with earpiece emit"];
  if (a.target === "app") return ["connected", "Connected"];
  if (a.target === "cli") return ["connected", "Connected (command line)"];
  if (!a.present) return ["", "Not installed"];
  return ["", "Not connected"];
}

function agents() {
  const parts = [h("p", { class: "lede" }, "Earpiece listens to each agent in the way that agent supports. Connecting only edits the file shown, and keeps a backup.")];
  for (const a of D.agents) {
    const [cls, label] = agentStatus(a);
    const st = a.settings || {};
    const connectable = a.target !== "emit";
    const actions = [];
    if (connectable) {
      if (a.target)
        actions.push(
          btn("Disconnect", async () => {
            agentOutput[a.id] = await act("disconnect", { id: a.id });
            await reload();
            render();
          }),
        );
      else
        actions.push(
          btn(
            "Connect",
            async () => {
              agentOutput[a.id] = await act("connect", { id: a.id });
              await reload();
              render();
            },
            a.present ? "primary" : "",
          ),
        );
    }
    const setAgent = async (patch, msg = "Saved") => {
      try {
        D.agents = await act("setAgent", { id: a.id, patch }, { ok: msg });
      } catch {}
      render();
    };
    parts.push(
      h(
        "div",
        { class: "group agent" },
        h(
          "div",
          { class: "agent-head" },
          h("div", { class: "mark", "aria-hidden": "true" }, window.EarpieceLogos.logo(a.id)),
          h("div", { class: "label" }, h("b", {}, a.name || a.id), h("small", {}, a.note || "")),
          h("span", { class: `pill ${cls}` }, label),
          ...actions,
        ),
        agentOutput[a.id] ? h("div", { class: "output selectable" }, agentOutput[a.id]) : null,
        row("How", a.file ? h("span", { class: "mono selectable" }, a.file) : null, h("span", { class: "muted" }, a.how || "")),
        row("Speak for this agent", "Turn off to mute it without disconnecting.", sw(st.enabled !== false, (v) => setAgent({ enabled: v }), `Speak for ${a.name}`)),
        row(
          "Name Earpiece says",
          "Used when announcing the agent. Leave empty for the default.",
          h("input", { type: "text", placeholder: a.name, value: st.label || "", maxlength: 40, style: "width:150px", "aria-label": "Name", onchange: (e) => setAgent({ label: e.target.value }) }),
        ),
        row(
          "Voice",
          "A Smallest voice id just for this agent, so you can tell them apart. Empty uses your main voice.",
          h("input", { type: "text", placeholder: D.settings.smallest.voice, value: st.voice || "", style: "width:120px", "aria-label": "Voice id", onchange: (e) => setAgent({ voice: e.target.value }) }),
        ),
        // Claude Desktop decides for itself when a reply is worth a ping, so there is no turn length.
        a.id === "claude-desktop" ? null : row(
          "Minimum turn length",
          `Seconds. Shorter turns stay silent. Empty uses ${D.settings.minTurnSeconds} s.`,
          h("input", { type: "number", min: 0, max: 3600, placeholder: String(D.settings.minTurnSeconds), value: st.minTurnSeconds ?? "", "aria-label": "Minimum seconds", onchange: (e) => setAgent({ minTurnSeconds: e.target.value }) }),
        ),
      ),
    );
  }
  parts.push(
    h(
      "p",
      { class: "note" },
      "Any other tool can talk to Earpiece with the command line: earpiece emit --agent my-tool --type turn_end --line \"Build finished\". It shows up here once it has sent something.",
    ),
  );
  return parts;
}

async function loadVoices(model) {
  voiceList = { model, loading: true };
  render();
  try {
    voiceList = { model, list: await act("voices", { model }, { quiet: true }) };
  } catch (e) {
    voiceList = { model, error: e.message };
  }
  if (section === "voice") render();
}

function voiceBrowser() {
  const cur = D.settings.smallest;
  const keySet = D.keys.find((k) => k.name === "SMALLEST_API_KEY")?.set;
  if (!keySet) return h("div", { class: "group" }, row("Add a Smallest API key to browse voices", null, btn("API Keys", () => go("keys"))));
  if (!voiceList || voiceList.model !== cur.model) {
    queueMicrotask(() => loadVoices(cur.model));
    return h("div", { class: "group" }, h("div", { class: "empty" }, "Loading voices…"));
  }
  if (voiceList.loading) return h("div", { class: "group" }, h("div", { class: "empty" }, "Loading voices…"));
  if (voiceList.error) return h("div", { class: "group" }, row(h("span", { class: "err" }, voiceList.error), null, btn("Retry", () => loadVoices(cur.model))));
  const list = voiceList.list;
  const uniq = (f) => [...new Set(list.flatMap(f).filter(Boolean))].sort();
  const f = voiceFilter;
  const q = f.q.trim().toLowerCase();
  const shown = list.filter(
    (v) =>
      (!q || v.name.toLowerCase().includes(q) || v.voiceId.toLowerCase().includes(q)) &&
      (!f.gender || v.tags.gender === f.gender) &&
      (!f.accent || v.tags.accent === f.accent) &&
      (!f.lang || v.tags.language.includes(f.lang)),
  );
  shown.sort((a, b) => (b.voiceId === cur.voice) - (a.voiceId === cur.voice) || a.name.localeCompare(b.name));
  const filt = (key, label, opts) =>
    select([["", label], ...opts.map((o) => [o, o[0].toUpperCase() + o.slice(1)])], f[key], (v) => ((voiceFilter = { ...f, [key]: v }), render()), label);
  return h(
    "div",
    { class: "group" },
    h(
      "div",
      { class: "row filters" },
      h("input", {
        type: "search",
        placeholder: `Search ${list.length} voices`,
        value: f.q,
        "aria-label": "Search voices",
        oninput: (e) => {
          voiceFilter = { ...voiceFilter, q: e.target.value };
          const pos = e.target.selectionStart;
          render();
          const el = document.querySelector(".filters input[type=search]");
          el?.focus();
          el?.setSelectionRange(pos, pos);
        },
      }),
      filt("gender", "Any gender", uniq((v) => [v.tags.gender])),
      filt("accent", "Any accent", uniq((v) => [v.tags.accent])),
      filt("lang", "Any language", uniq((v) => v.tags.language)),
    ),
    h(
      "div",
      { class: "voices" },
      shown.length
        ? shown.slice(0, 300).map((v) =>
            h(
              "div",
              { class: `voice ${v.voiceId === cur.voice ? "current" : ""}` },
              h("button", { class: "icon", title: `Play ${v.name}`, "aria-label": `Play ${v.name}`, onclick: () => preview({ engine: "smallest", voiceId: v.voiceId, model: cur.model }) }, "▶"),
              h("div", { class: "label", title: v.tags.language.join(", ") }, v.name, " ", h("span", { class: "tag" }, [v.tags.gender, v.tags.accent, v.tags.age, langs(v.tags.language)].filter(Boolean).join(" · "))),
              v.voiceId === cur.voice
                ? h("span", { class: "pill done" }, "In use")
                : h("button", { class: "btn", onclick: () => saveConfig({ smallest: { voice: v.voiceId } }, `Voice set to ${v.name}`) }, "Use"),
            ),
          )
        : h("div", { class: "empty" }, "No voices match."),
    ),
  );
}

const langs = (l) => (l.length > 3 ? `${l.slice(0, 3).join(", ")} +${l.length - 3}` : l.join(", "));

async function preview(args) {
  toast("Playing sample…");
  try {
    await act("preview", args, { quiet: true });
  } catch (e) {
    toast(`Couldn't play: ${e.message}`, true);
  }
}

function voice() {
  const S = D.settings;
  const order = S.ttsProviders;
  const all = [...order, ...D.engines.map((e) => e.id).filter((id) => !order.includes(id))];
  const engine = (id) => D.engines.find((e) => e.id === id) || { id, label: id };
  const move = (id, d) => {
    const next = order.slice();
    const i = next.indexOf(id);
    [next[i], next[i + d]] = [next[i + d], next[i]];
    saveConfig({ ttsProviders: next });
  };
  const toggle = (id, on) => {
    const next = on ? [...order, id] : order.filter((x) => x !== id);
    if (!next.length) return (toast("Keep at least one voice provider on", true), render());
    saveConfig({ ttsProviders: next });
  };
  if (!macVoiceList && D.platform === "darwin") {
    macVoiceList = [];
    J.dash("macVoices").then((v) => ((macVoiceList = v), section === "voice" && render())).catch(() => {});
  }
  const keyFor = (e) => (e.keyName ? D.keys.find((k) => k.name === e.keyName) : null);
  return [
    h("h2", {}, "Voice providers"),
    h("p", { class: "lede" }, "Tried top to bottom until one speaks. If a key is missing or an API is down, the next one takes over."),
    h(
      "div",
      { class: "group order-list" },
      all.map((id) => {
        const e = engine(id);
        const on = order.includes(id);
        const i = order.indexOf(id);
        const k = keyFor(e);
        return h(
          "div",
          { class: "row" },
          h("span", { class: "num" }, on ? `${i + 1}.` : ""),
          h("div", { class: "label" }, e.label, k && !k.set ? h("small", { class: "err" }, `Needs ${k.name}`) : e.id === "say" ? h("small", {}, "Built into macOS, works offline") : null),
          h(
            "div",
            { class: "ctrl" },
            h("button", { class: "icon", disabled: !on || i === 0, "aria-label": `Move ${e.label} up`, onclick: () => move(id, -1) }, "▲"),
            h("button", { class: "icon", disabled: !on || i === order.length - 1, "aria-label": `Move ${e.label} down`, onclick: () => move(id, 1) }, "▼"),
            sw(on, (v) => toggle(id, v), `Use ${e.label}`),
          ),
        );
      }),
    ),

    h("h2", {}, "Smallest.ai voice"),
    h(
      "div",
      { class: "group" },
      row(
        "Model",
        "Pro sounds better; the standard model is a little faster.",
        select(
          [
            ["lightning_v3.1_pro", "Lightning v3.1 Pro"],
            ["lightning_v3.1", "Lightning v3.1"],
          ],
          S.smallest.model,
          (v) => saveConfig({ smallest: { model: v } }),
          "Model",
        ),
      ),
      row("Voice", h("span", { class: "mono" }, S.smallest.voice), btn("▶ Play", () => preview({ engine: "smallest" }))),
      row(
        "Speed",
        null,
        h("input", { type: "range", min: 0.5, max: 2, step: 0.05, value: S.smallest.speed ?? 1, "aria-label": "Speed", oninput: (e) => (e.target.nextSibling.textContent = `${Number(e.target.value).toFixed(2)}×`), onchange: (e) => saveConfig({ smallest: { speed: Number(e.target.value) } }) }),
        h("span", { class: "muted mono", style: "width:42px" }, `${Number(S.smallest.speed ?? 1).toFixed(2)}×`),
      ),
    ),
    h("div", { style: "height:10px" }),
    voiceBrowser(),

    h("h2", {}, "Other voices"),
    h(
      "div",
      { class: "group" },
      row(
        "OpenAI voice",
        "Used when OpenAI is the provider speaking.",
        select(D.openaiVoices.map((v) => [v, v[0].toUpperCase() + v.slice(1)]), S.voice, (v) => saveConfig({ voice: v }), "OpenAI voice"),
        h("button", { class: "icon", "aria-label": "Play OpenAI voice", onclick: () => preview({ engine: "openai", openaiVoice: S.voice }) }, "▶"),
      ),
      D.platform === "darwin"
        ? row(
            "macOS voice",
            "The offline fallback.",
            select(
              (macVoiceList?.length ? macVoiceList : [{ name: S.sayVoice || "Samantha", locale: "" }]).map((v) => [v.name, v.locale ? `${v.name} (${v.locale})` : v.name]),
              S.sayVoice || "Samantha",
              (v) => saveConfig({ sayVoice: v }),
              "macOS voice",
            ),
            h("button", { class: "icon", "aria-label": "Play macOS voice", onclick: () => preview({ engine: "say", sayVoice: S.sayVoice }) }, "▶"),
          )
        : null,
    ),

    h("h2", {}, "What Earpiece says"),
    h(
      "div",
      { class: "group" },
      row("Language", "Summaries and phrases are spoken in this language.", select(D.languages, S.speakLanguage, (v) => saveConfig({ speakLanguage: v }), "Language")),
      row(
        "Summaries written by",
        S.summaryProvider === "none"
          ? "Nothing leaves your Mac for a summary. Earpiece uses a short built-in phrase instead."
          : "The last reply is sent to this API to write a one-line summary.",
        select(
          [
            ["openai", "OpenAI"],
            ["smallest", "Smallest.ai"],
            ["none", "No summaries (private)"],
          ],
          S.summaryProvider,
          (v) => saveConfig({ summaryProvider: v }),
          "Summary provider",
        ),
      ),
      row("Say the agent's name", "“Codex, pricing page. Done…” instead of just the project.", sw(S.announceAgent, (v) => saveConfig({ announceAgent: v }), "Say the agent's name")),
      row("Chime before speaking", null, sw(S.chimes, (v) => saveConfig({ chimes: v }), "Chime")),
      row(
        "Minimum turn length",
        "Seconds. Quick replies shorter than this stay silent.",
        h("input", { type: "number", min: 0, max: 3600, value: S.minTurnSeconds, "aria-label": "Minimum turn seconds", onchange: (e) => saveConfig({ minTurnSeconds: e.target.value }) }),
      ),
    ),
  ];
}

function quiet() {
  const qh = D.settings.quietHours;
  const setQ = (patch) => saveConfig({ quietHours: { ...(qh || { start: "23:00", end: "08:00", allow: ["needs_input"] }), ...patch } });
  const allow = qh && Array.isArray(qh.allow) ? qh.allow : ["needs_input"];
  const quietFor = (min) => J.setMode("quiet", min).then(() => toast(min ? `Quiet for ${min >= 60 ? `${min / 60} h` : `${min} min`}` : "Quiet until you turn it back on"));
  const offFor = (min) => J.setMode("off", min).then(() => toast(min ? `Off for ${min >= 60 ? `${min / 60} h` : `${min} min`}` : "Off until you turn it back on"));
  return [
    h("h2", {}, "Right now"),
    h(
      "div",
      { class: "group" },
      row(modeSentence().text, modeSentence().sub, modeSeg()),
      row(
        "Quiet for a while",
        "Nothing is read aloud. Every update still shows in the notch.",
        select(
          [
            ["", "Choose…"],
            ["30", "30 minutes"],
            ["60", "1 hour"],
            ["120", "2 hours"],
            ["240", "4 hours"],
            ["0", "Until I turn it back on"],
          ],
          "",
          (v) => v !== "" && quietFor(Number(v)),
          "Quiet for",
        ),
      ),
      row(
        "Off for a while",
        "Nothing is spoken.",
        select(
          [
            ["", "Choose…"],
            ["30", "30 minutes"],
            ["60", "1 hour"],
            ["120", "2 hours"],
            ["0", "Until I turn it back on"],
          ],
          "",
          (v) => v !== "" && offFor(Number(v)),
          "Off for",
        ),
      ),
    ),
    h("h2", {}, "Quiet hours"),
    h(
      "div",
      { class: "group" },
      row("Every day", qh ? (D.quietNow ? "On now." : `From ${qh.start} to ${qh.end}.`) : "Off. Earpiece speaks at any hour.", sw(Boolean(qh), (v) => (v ? setQ({}) : saveConfig({ quietHours: null })), "Quiet hours")),
      qh
        ? [
            row(
              "From",
              null,
              h("input", { type: "time", value: qh.start, "aria-label": "Quiet hours start", onchange: (e) => e.target.value && setQ({ start: e.target.value }) }),
              h("span", { class: "muted" }, "to"),
              h("input", { type: "time", value: qh.end, "aria-label": "Quiet hours end", onchange: (e) => e.target.value && setQ({ end: e.target.value }) }),
            ),
            h(
              "div",
              { class: "row stack" },
              h("div", { class: "label" }, "Still say", h("small", {}, "Turn everything off for full silence.")),
              ...["needs_input", "error", "done", "info"].map((k) =>
                h(
                  "div",
                  { class: "row", style: "padding:6px 0;min-height:0;border:0" },
                  h("div", { class: "label" }, KIND_LABEL[k]),
                  sw(allow.includes(k), (v) => setQ({ allow: v ? [...allow, k] : allow.filter((x) => x !== k) }), KIND_LABEL[k]),
                ),
              ),
            ),
          ]
        : null,
    ),
  ];
}

function keys() {
  const LABEL = { SMALLEST_API_KEY: ["Smallest.ai", "Voice and summaries. Get one at smallest.ai."], OPENAI_API_KEY: ["OpenAI", "Backup voice and summaries."] };
  const parts = [h("p", { class: "lede" }, "Keys are kept in a private file on this Mac that only you can read. The app never shows them again after you save.")];
  for (const k of D.keys) {
    const [name, sub] = LABEL[k.name] || [k.name, ""];
    const inp = h("input", { type: "password", placeholder: k.set ? "Paste a new key to replace it" : "Paste key", style: "flex:1", autocomplete: "off", spellcheck: "false", "aria-label": `${name} key` });
    const status = h("small", { class: k.set ? "ok" : "muted" }, k.set ? `Set · from ${k.source.label}` : "Not set");
    const result = h("span", { class: "muted", style: "font-size:12px" });
    parts.push(
      h("h2", {}, name),
      h(
        "div",
        { class: "group" },
        row(h("span", {}, k.name, " ", h("span", { class: "muted", style: "font-weight:400" }, "· ", sub)), status, result, k.set ? btn("Test", async () => {
          result.textContent = "Testing…";
          const r = await act("testKey", { name: k.name });
          result.textContent = r.message;
          result.className = r.ok ? "ok" : "err";
        }) : null),
        k.shadowed ? h("div", { class: "row" }, h("div", { class: "label" }, h("small", { class: "err" }, `The key saved in the app is not used: ${k.source.label} has one too, and it comes first.`))) : null,
        h(
          "div",
          { class: "row" },
          inp,
          btn("Save", async () => {
            if (!inp.value.trim()) return toast("Paste a key first", true);
            D.keys = await act("setKey", { name: k.name, value: inp.value }, { ok: `${name} key saved` });
            inp.value = "";
            render();
          }, "primary"),
          k.source?.id === "app" ? btn("Remove", async () => {
            if (!confirm(`Remove the ${name} key saved in the app?`)) return;
            D.keys = await act("clearKey", { name: k.name }, { ok: "Removed" });
            render();
          }, "danger") : null,
        ),
      ),
    );
  }
  const env = D.settings.envFile;
  parts.push(
    h("h2", {}, "Use an existing .env file"),
    h(
      "div",
      { class: "group" },
      row(
        env ? h("span", { class: "mono selectable" }, env) : "No file chosen",
        "If your keys already live in a project's .env, point Earpiece at it instead of pasting them. Environment variables win over this file, and this file wins over keys saved here.",
        btn(env ? "Change…" : "Choose…", async () => {
          D.keys = await act("chooseEnvFile");
          await reload();
          render();
        }),
        env ? btn("Stop using", async () => {
          D.keys = await act("clearEnvFile", {}, { ok: "Not using that file any more" });
          await reload();
          render();
        }) : null,
      ),
    ),
  );
  return parts;
}

let activityRows = null;
// "codex · api" -> "Codex · api"
const agentName = (who) => {
  if (!who) return who;
  const [id, ...rest] = who.split(" · ");
  const a = D.agents.find((x) => x.id === id);
  return [a?.settings?.label || a?.name || id, ...rest].join(" · ");
};
async function loadActivity() {
  try {
    activityRows = await act("activity", { limit: 300 });
  } catch {
    activityRows = [];
  }
  if (section === "activity") render();
}

function activity() {
  if (!activityRows) {
    loadActivity();
    return [h("div", { class: "group" }, h("div", { class: "empty" }, "Loading…"))];
  }
  const F = { all: () => true, spoke: (r) => r.kind === "spoke", skipped: (r) => r.kind === "skipped", problems: (r) => r.kind === "warn" || r.kind === "error" };
  const rows = activityRows.filter(F[activityFilter]);
  return [
    h(
      "div",
      { class: "seg", role: "radiogroup", "aria-label": "Filter", style: "margin:6px 0 10px" },
      [
        ["all", "All"],
        ["spoke", "Spoken"],
        ["skipped", "Kept quiet"],
        ["problems", "Problems"],
      ].map(([id, l]) => h("button", { role: "radio", "aria-checked": String(activityFilter === id), onclick: () => ((activityFilter = id), render()) }, l)),
    ),
    h(
      "div",
      { class: "group log" },
      rows.length
        ? rows.map((r) =>
            h(
              "div",
              { class: "row" },
              h("span", { class: `dot ${r.kind}` }),
              h(
                "div",
                { class: "label selectable" },
                r.kind === "spoke" ? `“${r.text}”` : r.text,
                r.count > 1 ? h("span", { class: "count" }, `×${r.count}`) : null,
                h("small", {}, [agentName(r.who), r.detail].filter(Boolean).join(" · ")),
              ),
              h("span", { class: "when" }, r.at ? dayClock(r.at) : ""),
            ),
          )
        : h("div", { class: "empty" }, "Nothing here yet."),
    ),
    h("p", { class: "note" }, "Most recent first. Repeated lines are folded together."),
  ];
}

async function setPref(key, value) {
  try {
    await act("setPref", { key, value });
  } catch {}
  await reload().catch(() => {});
  render();
}
// First run: a sign-up screen over the whole window. Optional: "Skip for now" hides it for good,
// and General → Account can sign in later.
const showWelcome = () => !D.account?.user && !D.prefs?.hideSignInNudge;
let signingIn = false;

function googleMark() {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 48 48");
  svg.setAttribute("aria-hidden", "true");
  for (const [fill, d] of [
    ["#FFC107", "M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"],
    ["#FF3D00", "M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"],
    ["#4CAF50", "M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"],
    ["#1976D2", "M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"],
  ]) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("fill", fill);
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

function welcome() {
  const err = D.account?.error;
  if (err) signingIn = false;
  const start = async () => {
    signingIn = true;
    render();
    try {
      await act("signIn");
    } catch {
      signingIn = false;
      render();
    }
  };
  return h(
    "div",
    { class: "welcome drag", role: "dialog", "aria-modal": "true", "aria-labelledby": "welcomeTitle" },
    h(
      "div",
      { class: "welcome-card" },
      h("span", { class: "wave", "aria-hidden": "true" }, h("i"), h("i"), h("i"), h("i"), h("i")),
      h("h1", { id: "welcomeTitle" }, "Welcome to Earpiece"),
      h("p", {}, "Create your free account to hear about new features first."),
      h("button", { class: "google", onclick: start }, googleMark(), signingIn ? "Open Google again" : "Continue with Google"),
      signingIn ? h("p", { class: "note" }, "Finish signing in in your browser, then come back here.") : null,
      err ? h("p", { class: "note err" }, `Sign-in didn't finish: ${err}`) : null,
      h("p", { class: "note fine" }, "Signing in shares usage stats with your account. Never your prompts or code."),
      h("button", { class: "skip", onclick: () => ((signingIn = false), setPref("hideSignInNudge", true)) }, "Skip for now"),
    ),
  );
}

function account() {
  const A = D.account || {};
  const u = A.user;
  return [
    h("h2", {}, "Account"),
    h(
      "div",
      { class: "group" },
      u
        ? [
            row(u.name || u.email, u.name ? u.email : "Signed in with Google", btn("Sign out", () => act("signOut").then(() => setPref("hideSignInNudge", true)))),
            A.plan?.plan === "pro"
              ? row(
                  "Earpiece Pro",
                  `Hosted voice and summaries on Earpiece's keys, no API keys needed. ${Number(A.plan.lines_used || 0).toLocaleString()} of ${Number(A.plan.lines_cap || 0).toLocaleString()} hosted lines used this month; after that your own keys or the system voice take over.`,
                  btn("Manage billing", () => act("manageBilling")),
                )
              : row(
                  "Free plan",
                  "Everything works on Free with your own keys or the system voice. Pro adds natural voices and one-line summaries on Earpiece's keys, so you don't need any API keys. $10 a month, or $96 a year.",
                  btn("Yearly", () => act("upgrade", { interval: "year" })),
                  btn("Upgrade to Pro", () => act("upgrade", { interval: "month" }), "primary"),
                ),
          ]
        : row(
            "Sign in with Google",
            A.error ? `Sign-in didn't finish: ${A.error}` : "Optional. Everything works without an account. Signing in links your usage stats to you, so we know who uses Earpiece and can tell you about new features.",
            btn("Sign in", () => act("signIn"), "primary"),
          ),
    ),
  ];
}

function general() {
  const P = D.prefs;
  return [
    ...account(),
    h("h2", {}, "App"),
    h(
      "div",
      { class: "group" },
      row("Open at login", "Starts in the menu bar so Earpiece is always listening.", sw(P.openAtLogin, (v) => setPref("openAtLogin", v), "Open at login")),
      row("Show in Dock", "Off keeps Earpiece only in the menu bar. The window is still one click away there.", sw(P.showInDock, (v) => setPref("showInDock", v), "Show in Dock")),
      row(
        "Show a card when Earpiece speaks",
        "The agent and what it said open out of the notch for a few seconds, then fold back into it. Click the notch to see it again. It also shows in quiet mode, when nothing is read aloud. Turning this off also removes the notch icon.",
        h("div", { class: "ctrl" }, btn("Preview", () => J.previewCard()), sw(P.showCard, (v) => setPref("showCard", v), "Show a card when Earpiece speaks")),
      ),
      row(
        "Notch",
        "The card lives in the MacBook notch and opens from it when you click. Screens without a notch get the same pill at the top centre. Change this if your notch isn't picked up.",
        select([["auto", "Detect"], ["on", "Always use the notch"], ["off", "No notch"]], P.notch || "auto", (v) => setPref("notch", v), "Notch"),
      ),
      row(
        "Notch icon",
        "Always: a small Earpiece icon rests in the notch with a count of running agents and a status dot. Click it to see every agent and jump to one. Only on updates: the notch stays empty until an agent says something.",
        select([["always", "Always"], ["updates", "Only on updates"]], P.notchIcon || "always", (v) => setPref("notchIcon", v), "Notch icon"),
      ),
      row(
        "Answer from the card",
        "Approve or deny Claude Code and Codex tool requests, and reply when they ask you something, right from the card. Needs the card on. Restart open sessions after changing it; in Codex, trust the new hooks once with /hooks. If you don't answer in about two minutes, the question goes back to the terminal.",
        sw(P.answerFromCard && P.showCard, (v) => setPref("answerFromCard", v), "Answer from the card"),
      ),
      row(
        "Reply from the notch",
        "A Reply button on every finished line, not only questions: type the next instruction and the agent carries on in its own terminal. Claude Code: for up to 30 minutes, without holding the terminal. Codex: for a minute, and only while you're away from its terminal. Restart open sessions after changing it; in Codex, trust the new hooks once with /hooks.",
        sw(P.replyFromNotch && P.showCard, (v) => setPref("replyFromNotch", v), "Reply from the notch"),
      ),
      D.account?.user
        ? row(
            "Usage stats",
            "Shared with your account while you're signed in: the app and macOS versions, which agents are connected, which features are on and how many lines were spoken today. Sign out to stop.",
          )
        : row(
            "Share usage stats",
            "A few times a day, anonymously: the app and macOS versions, your Mac's chip type, language, which agents are connected, which features are on and how many lines were spoken today.",
            sw(P.shareStats, (v) => setPref("shareStats", v), "Share usage stats"),
          ),
      row(
        "Your work stays on your Mac",
        D.account?.plan?.plan === "pro"
          ? "We never collect your prompts, code, project names, file paths or API keys, and settings and logs stay local in ~/.earpiece. With Pro's hosted voice, the end of an agent's reply (to summarise it) and the line to speak pass through Earpiece's server to its voice and AI providers. They aren't stored; only counts are kept."
          : "We never collect your prompts, code, agent messages, summaries, project names, file paths or API keys. Settings and logs stay local in ~/.earpiece. The only exception is a voice or summary provider you add your own key for, which gets just the text it needs to speak a line.",
      ),
    ),
    h("h2", {}, "Files"),
    h(
      "div",
      { class: "group" },
      row("Settings file", h("span", { class: "mono" }, `${D.home}/config.json`), btn("Open", () => act("open", { what: "config" })), btn("Show in Finder", () => act("open", { what: "config", reveal: true }))),
      row("Log", h("span", { class: "mono" }, `${D.home}/log.jsonl`), btn("Open", () => act("open", { what: "log" }))),
      row("Earpiece folder", h("span", { class: "mono" }, D.home), btn("Show in Finder", () => act("open", { what: "home" }))),
    ),
    h("h2", {}, "About"),
    updateBanner("general"),
    h(
      "div",
      { class: "group" },
      row(
        `Earpiece ${D.version}`,
        D.update?.error && !D.update.newer ? D.update.error
          : D.update?.status === "current" ? `You're up to date. Checked ${ago(D.update.checkedAt)}.`
          : D.update?.newer ? `Version ${D.update.latest} is available.`
          : "Open source, MIT licence. Checks for updates every few hours.",
        btn("Check for updates", async () => {
          const u = await act("checkUpdate");
          D.update = u;
          if (u.status === "current") toast("You're up to date");
          render();
        }),
      ),
      row("Command line", "Everything here also works from a terminal: earpiece status, earpiece quiet 1h, earpiece doctor.", null),
    ),
  ];
}

const VIEWS = { overview, agents, voice, quiet, keys, activity, general };

function headActions() {
  const a = [];
  if (section === "overview" || section === "voice")
    a.push(
      btn("Test voice", async () => {
        const r = await J.testVoice();
        if (r.skipped) toast(`Didn't speak: ${r.skipped.replace(/_/g, " ")}`, true);
        else if (r.engine === "none") toast("No voice provider worked. Check API Keys.", true);
      }),
    );
  if (section === "activity")
    a.push(
      btn("Refresh", async () => {
        await loadActivity();
      }),
    );
  return a;
}

function render() {
  if (!D) return;
  const view = $("view");
  const top = view.scrollTop;
  // Keep the voice list's own scroll position across re-renders.
  const vs = document.querySelector(".voices")?.scrollTop;
  $("title").textContent = SECTIONS[section];
  $("headActions").replaceChildren(...headActions());
  view.replaceChildren(h("div", { class: "page" }, VIEWS[section]()));
  document.querySelector(".welcome")?.remove();
  if (showWelcome()) document.body.append(welcome());
  view.scrollTop = top;
  const v = document.querySelector(".voices");
  if (v && vs) v.scrollTop = vs;
  for (const b of document.querySelectorAll("#nav button")) {
    if (b.dataset.section === section) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  chrome();
}

function go(s) {
  if (!VIEWS[s]) return;
  if (s !== section) $("view").scrollTop = 0;
  section = s;
  if (s === "activity") activityRows = null;
  render();
}

for (const b of document.querySelectorAll("#nav button")) b.addEventListener("click", () => go(b.dataset.section));
$("view").addEventListener("scroll", (e) => document.querySelector(".head").classList.toggle("scrolled", e.target.scrollTop > 2));
if (navigator.platform && !/Mac/.test(navigator.platform)) document.body.classList.add("no-vibrancy");

// Live updates. Only the overview redraws on its own; other pages would lose what you're typing.
let pending;
J.onState((s) => {
  if (!D) return;
  Object.assign(D, s);
  chrome();
  clearTimeout(pending);
  pending = setTimeout(async () => {
    // General too while an update runs, so its banner shows the progress.
    if (!["overview", "agents", "quiet"].includes(section) && !(section === "general" && D.update && (UPDATE_BUSY.has(D.update.status) || D.update.status === "failed"))) return;
    if (document.activeElement && /INPUT|SELECT/.test(document.activeElement.tagName)) return;
    try {
      await reload();
      render();
    } catch {}
  }, 250);
});
J.onNavigate((s) => go(s || "overview"));
window.addEventListener("focus", () => {
  // Coming back from the browser after signing in lands here too.
  if (section === "overview" || section === "general" || document.querySelector(".welcome")) reload().then(render).catch(() => {});
});

reload()
  .then(render)
  .catch((e) => {
    $("view").replaceChildren(h("div", { class: "page" }, h("div", { class: "group" }, h("div", { class: "empty err" }, `Couldn't load: ${e.message}`))));
  });
