// Earpiece for Mac: runs the hub, with a main window (dashboard and settings) and a menu
// bar popover for quick control. Hooks send events to ~/.earpiece/hub.sock through the earpiece-hook shim; this process
// summarises and speaks them. The Node core in ../../src (Resources/core when packaged) does
// the work, so the app and the `earpiece` CLI always behave the same.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, screen, session, shell, systemPreferences, Tray } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDashboard, tidyPath } from "./dashboard.mjs";
import { createUpdater } from "./updater.mjs";
import { createAuth } from "./auth.mjs";
import { createTelemetry, features, KEY, SUPABASE } from "./telemetry.mjs";
import { createCardPointer } from "./card-pointer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(here, "..");
const CORE = app.isPackaged ? path.join(process.resourcesPath, "core") : path.resolve(APP_ROOT, "..");
const asset = (f) => path.join(APP_ROOT, "build", f);
const core = (rel) => import(pathToFileURL(path.join(CORE, rel)).href);

const DAY = 24 * 3600_000;
let tray, popover, win, hub, dash, updater, telemetry, asks = null, hubError = null, authError = null;
let quitting = false;
let lib = {};
const SECTIONS = ["overview", "agents", "voice", "quiet", "keys", "activity", "general"];

// App preferences that aren't Earpiece settings (those live in ~/.earpiece/config.json).
const prefs = {
  file: () => path.join(app.getPath("userData"), "prefs.json"),
  get() {
    try {
      return JSON.parse(fs.readFileSync(this.file(), "utf8"));
    } catch {
      return {};
    }
  },
  set(key, value) {
    if (key === "openAtLogin") {
      app.setLoginItemSettings({ openAtLogin: Boolean(value) });
      return { openAtLogin: app.getLoginItemSettings().openAtLogin };
    }
    if (key === "answerFromCard") {
      // Lives in the shared config (the CLI reads it too). Turning it on or off rewrites the
      // blocking hooks of the agents that are already connected.
      lib.updateConfig({ answerFromCard: Boolean(value) });
      if (!value) asks?.closeAll();
      for (const id of ["claude-code", "codex"]) if (lib.getAdapter(id)?.isInstalled?.()) connectAgents(id);
      return { answerFromCard: Boolean(value) };
    }
    if (key === "replyFromNotch") {
      // Same shape as answerFromCard: shared config, and the connected agents' hooks are rewritten.
      lib.updateConfig({ replyFromNotch: Boolean(value) });
      if (!value) for (const a of asks?.list() || []) if (a.soft) asks.cancel(a.id, "off");
      for (const id of ["claude-code", "codex"]) if (lib.getAdapter(id)?.isInstalled?.()) connectAgents(id);
      return { replyFromNotch: Boolean(value) };
    }
    if (key === "notch") {
      // "auto" detects the notch; "on"/"off" override it (e.g. a notch that isn't detected).
      if (!["auto", "on", "off"].includes(value)) throw new Error("notch must be auto, on or off");
      const next = { ...this.get(), notch: value };
      fs.mkdirSync(path.dirname(this.file()), { recursive: true });
      fs.writeFileSync(this.file(), JSON.stringify(next, null, 2));
      if (cardWin?.isVisible()) placeCard(currentDisplay());
      return next;
    }
    if (key === "notchIcon") {
      // "always": the island rests in the notch between lines; "updates": it only shows for a line.
      if (!["always", "updates"].includes(value)) throw new Error("notchIcon must be always or updates");
      const next = { ...this.get(), notchIcon: value };
      fs.mkdirSync(path.dirname(this.file()), { recursive: true });
      fs.writeFileSync(this.file(), JSON.stringify(next, null, 2));
      applyRest();
      return next;
    }
    if (key === "session") {
      // Already encrypted by the caller (see auth below); null signs out.
      const { session: _, ...next } = this.get();
      if (value) next.session = String(value);
      fs.mkdirSync(path.dirname(this.file()), { recursive: true });
      fs.writeFileSync(this.file(), JSON.stringify(next, null, 2));
      return next;
    }
    if (key === "installId") {
      const next = { ...this.get(), installId: String(value) };
      fs.mkdirSync(path.dirname(this.file()), { recursive: true });
      fs.writeFileSync(this.file(), JSON.stringify(next, null, 2));
      return next;
    }
    if (!["showInDock", "showCard", "shareStats", "hideSignInNudge", "replyHooksAdded"].includes(key)) throw new Error("unknown preference");
    const next = { ...this.get(), [key]: Boolean(value) };
    fs.mkdirSync(path.dirname(this.file()), { recursive: true });
    fs.writeFileSync(this.file(), JSON.stringify(next, null, 2));
    if (key === "showInDock") applyDock(next.showInDock);
    if (key === "showCard") {
      asks?.setUi(next.showCard);
      if (!next.showCard) (asks?.closeAll(), cardWin?.hide());
      applyRest();
    }
    return next;
  },
};

// Optional Google sign-in. The session is encrypted with safeStorage (the macOS Keychain) before it
// is written to prefs.json.
const auth = createAuth({
  load() {
    const s = prefs.get().session;
    if (!s || !safeStorage.isEncryptionAvailable()) return null;
    try {
      return JSON.parse(safeStorage.decryptString(Buffer.from(s, "base64")));
    } catch {
      return null;
    }
  },
  save: (session) => prefs.set("session", session && safeStorage.encryptString(JSON.stringify(session)).toString("base64")),
  openExternal: (url) => shell.openExternal(url),
});
let plan = null; // { plan, lines_used, lines_cap, period_end } from my_plan(), null when signed out
const account = () => ({ user: auth.user(), error: authError, plan: auth.user() ? plan : null });

// The core (hub worker, hook fallbacks) speaks in other processes, so Pro's hosted voice reads the
// signed-in token and plan from ~/.earpiece/account.json (0600). Refreshed every 10 minutes; the
// token itself is refreshed 15 minutes before it expires, so the file never holds a dead one.
async function syncAccount() {
  if (!lib.P) return;
  const token = await auth.accessToken().catch(() => null);
  if (!token) {
    plan = null;
    fs.rmSync(lib.P.account, { force: true });
    return;
  }
  try {
    const res = await fetch(`${SUPABASE}/rest/v1/rpc/my_plan`, {
      method: "POST",
      headers: { apikey: KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) plan = await res.json();
  } catch {} // offline: keep the last known plan
  const known = plan?.plan || lib.readJson(lib.P.account, {})?.plan || "free";
  lib.writeJson(lib.P.account, { access_token: token, expires_at: auth.expiresAt(), plan: known });
}

// Pro checkout and the billing portal open in the browser (Dodo Payments, via the `billing` Edge
// Function). After a checkout, re-read the plan every 15 s for 10 minutes so Pro shows up as soon as
// the payment webhook has run, without a restart.
let billingPoll = null;
async function openBilling(body) {
  const token = await auth.accessToken();
  if (!token) throw new Error("Sign in first.");
  const res = await fetch(`${SUPABASE}/functions/v1/billing`, {
    method: "POST",
    headers: { apikey: KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.url) throw new Error(j.error || `Billing is unavailable right now (HTTP ${res.status}).`);
  await shell.openExternal(j.url);
  if (body.action === "checkout") {
    clearInterval(billingPoll);
    const until = Date.now() + 10 * 60_000;
    billingPoll = setInterval(async () => {
      await syncAccount();
      refresh();
      if (plan?.plan === "pro" || Date.now() > until) clearInterval(billingPoll);
    }, 15_000);
  }
}

// The browser hands the sign-in back as earpiece://auth?code=….
async function onAuthLink(url) {
  authError = null;
  try {
    if (await auth.handleCallback(url)) (await syncAccount(), telemetry?.ping());
  } catch (e) {
    authError = e.message;
    lib.log?.({ warn: `sign-in: ${e.message}` });
  }
  if (app.isReady() && lib.log) (showMain("general"), refresh());
}

function applyDock(show) {
  if (!app.dock) return;
  if (show) app.dock.show().then(() => win?.isVisible() && win.focus());
  else app.dock.hide();
}

// One app instance only. A second launch brings the first one forward.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => showMain());
  // Packaged only: in dev, macOS would register the bare Electron.app, which can't handle the link.
  if (app.isPackaged) app.setAsDefaultProtocolClient("earpiece");
  app.on("open-url", (e, url) => (e.preventDefault(), onAuthLink(url)));
  app.whenReady().then(start).catch((e) => {
    dialog.showErrorBox("Earpiece could not start", String(e?.stack || e));
    app.quit();
  });
}

// The app was called Jarvis Voice before the rename; bring its preferences across once.
function migratePrefs() {
  try {
    const old = path.join(app.getPath("appData"), "Jarvis Voice", "prefs.json");
    if (!fs.existsSync(prefs.file()) && fs.existsSync(old)) {
      fs.mkdirSync(path.dirname(prefs.file()), { recursive: true });
      fs.copyFileSync(old, prefs.file());
    }
  } catch {}
}

async function start() {
  migratePrefs();
  if (prefs.get().showInDock === false) app.dock?.hide();
  const [paths, server, sessions, policy, config, adapters, control, shim, util, cards, askLib, originLib, jumpLib, notchLib] = await Promise.all([
    core("src/paths.mjs"),
    core("src/hub/server.mjs"),
    core("src/hub/sessions.mjs"),
    core("src/policy.mjs"),
    core("src/config.mjs"),
    core("src/adapters/index.mjs"),
    core("src/control.mjs"),
    core("src/shim.mjs"),
    core("src/util.mjs"),
    core("src/card.mjs"),
    core("src/hub/asks.mjs"),
    core("src/hub/origin.mjs"),
    core("src/hub/jump.mjs"),
    core("src/notch.mjs"),
  ]);
  lib = { ...paths, ...server, ...sessions, ...policy, ...config, ...adapters, ...control, ...shim, ...util, ...cards, ...askLib, ...originLib, ...jumpLib, ...notchLib };
  lib.ensureDirs();

  // Re-written on every launch, so hooks keep working if the app is moved.
  const shimOpts = { fallback: [process.execPath, path.join(CORE, "bin", "earpiece.mjs")], env: { ELECTRON_RUN_AS_NODE: "1" } };
  lib.shimFile = lib.writeShim(shimOpts);
  // Hooks installed before the rename call bin/jarvis-hook. Keep it current until they're reinstalled.
  const legacyShim = path.join(path.dirname(lib.shimFile), "jarvis-hook");
  if (fs.existsSync(legacyShim)) lib.writeShim(shimOpts, legacyShim);

  try {
    asks = lib.createAsks({ onChange: onAsksChange, away: awayFromSession });
    asks.setUi(prefs.get().showCard !== false);
    hub = await lib.startHubServer({ version: app.getVersion(), onEvent: scheduleRefresh, asks });
  } catch (e) {
    hubError = e.code === "EADDRINUSE" ? "Another Earpiece hub is running (earpiece serve?). Hooks still speak through it." : e.message;
    lib.log({ error: `app hub: ${e.message}` });
  }

  tray = new Tray(trayIcon(false));
  tray.setToolTip("Earpiece");
  tray.on("click", () => togglePopover());
  tray.on("right-click", () => tray.popUpContextMenu(buildMenu()));

  updater = createUpdater({
    version: app.getVersion(),
    exePath: app.getPath("exe"),
    isPackaged: app.isPackaged,
    tmpDir: app.getPath("temp"),
    pid: process.pid,
    log: lib.log,
    openExternal: (url) => shell.openExternal(url),
    quit: () => app.quit(),
    onChange: scheduleRefresh,
  });
  dash = createDashboard({ app, dialog, shell, lib, core, state, hookStatus, connect: connectAgents, disconnect: disconnectAgents, refresh, prefs, updater, auth, account, syncAccount, openBilling });
  Menu.setApplicationMenu(appMenu());
  noteDisplays();
  for (const ev of ["display-added", "display-removed", "display-metrics-changed"]) screen.on(ev, onDisplaysChanged);
  watchState();
  refresh();
  applyRest(); // the resting icon in the notch, unless you turned it off
  updater.start(); // a few seconds after launch, then every 6 hours
  // Anonymous usage stats from the released app only, so dev runs don't count as installs.
  if (app.isPackaged) {
    telemetry = createTelemetry({
      getPrefs: () => prefs.get(),
      saveInstallId: (id) => prefs.set("installId", id),
      accessToken: () => auth.accessToken(),
      info: () => ({
        version: app.getVersion(),
        osVersion: process.getSystemVersion(),
        arch: process.arch,
        locale: app.getLocale(),
        agents: hookStatus().filter((h) => h.target).map((h) => h.id),
        features: { ...features({ config: lib.config(), prefs: prefs.get(), keys: dash.keyStatus(), stats: dash.stats() }), plan: plan?.plan || "free" },
      }),
    });
    telemetry.start();
  }
  // Reply from the notch is on by default. Agents connected before it existed don't have its Stop
  // hook yet, so rewrite their hooks once (only those already connected; a preference marks it done).
  if (lib.config().replyFromNotch && !prefs.get().replyHooksAdded) {
    for (const id of ["claude-code", "codex"]) if (lib.getAdapter(id)?.isInstalled?.()) connectAgents(id);
    prefs.set("replyHooksAdded", true);
  }
  syncAccount().then(refresh);
  setInterval(() => syncAccount().then(refresh), 10 * 60_000).unref?.();
  // Started at login: stay in the menu bar. Opened by you: show the window.
  const login = app.getLoginItemSettings();
  if (!(login.wasOpenedAtLogin || login.wasOpenedAsHidden)) showMain();
}

// ---------- state ----------

function hookStatus() {
  return lib
    .listAdapters()
    .filter((a) => a.install && a.configFile)
    .map((a) => {
      let text = "";
      try {
        text = fs.readFileSync(a.configFile(), "utf8");
      } catch {}
      const target = /(?:earpiece|jarvis)-hook/.test(text) ? "app" : a.isInstalled?.() ? "cli" : null;
      const present = fs.existsSync(path.dirname(a.configFile()));
      return { id: a.id, name: a.name, target, present };
    });
}

function modeInfo() {
  const m = lib.readJson(lib.P.mode, { mode: "on" });
  const mode = lib.currentMode();
  return { mode, until: mode !== "on" ? m.until || null : null };
}

function state() {
  const cfg = lib.config();
  const rows = lib.listSessions({ sinceMs: DAY }).map((s) => {
    const a = lib.getAdapter(s.agent);
    const agent = lib.agentConfig(cfg, s.agent).label || a.name;
    const project = s.project || lib.projectName(s.cwd);
    return {
      agent,
      agentId: s.agent,
      session: s.session,
      project,
      status: s.status || "idle",
      updated: s.updated || 0,
      where: s.origin ? lib.describeOrigin(s.origin) : "",
      // The row already shows the agent and project, so drop them from the spoken line.
      // Once you mark it done, the old question is stale; say so instead.
      lastLine: s.status === "done" && s.markedByUser >= (s.updated || 0) - 5 ? "Marked done by you" : lib.stripLeadIn(s.lastLine || "", { agentName: agent, project }),
    };
  });
  const order = { waiting: 0, error: 1, working: 2, done: 3, idle: 4 };
  rows.sort((a, b) => order[a.status] - order[b.status] || b.updated - a.updated);
  return {
    version: app.getVersion(),
    sessions: rows,
    ...modeInfo(),
    quietHours: cfg.quietHours || null,
    quietNow: lib.inQuietHours(cfg.quietHours),
    hub: hub ? { ok: true } : { ok: false, error: hubError },
    hooks: hookStatus(),
    speaking: lib.isSpeaking(), // audio is playing, not merely "waiting on the TTS API"
    openAtLogin: app.getLoginItemSettings().openAtLogin,
    update: updater?.state() || null,
  };
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 120);
}

function refresh() {
  if (!tray) return;
  const s = state();
  const waiting = s.sessions.filter((r) => r.status === "waiting").length;
  tray.setTitle(waiting ? String(waiting) : "", { fontType: "monospacedDigit" });
  tray.setToolTip(waiting ? `Earpiece: ${waiting} waiting on you` : `Earpiece (${s.mode})`);
  setSpeaking(s.speaking);
  popover?.webContents.send("state", s);
  win?.webContents.send("state", s);
  sendAgents(s);
}

let speakingShown = false;
function setSpeaking(on) {
  if (on === speakingShown) return;
  speakingShown = on;
  tray.setImage(trayIcon(on));
}

function trayIcon(speaking) {
  const img = nativeImage.createFromPath(asset(speaking ? "traySpeakingTemplate.png" : "trayTemplate.png"));
  img.setTemplateImage(true);
  return img;
}

function watchState() {
  for (const dir of [lib.P.sessions, lib.HOME]) {
    try {
      fs.watch(dir, { persistent: false }, scheduleRefresh);
    } catch {}
  }
  // The lock dir appears while a line plays; polling it is cheaper than watching every event.
  try {
    cardMtime = fs.statSync(lib.P.card).mtimeMs; // don't replay the last card from before launch
  } catch {}
  setInterval(() => {
    setSpeaking(lib.isSpeaking());
    checkCard();
  }, 250).unref();
  setInterval(refresh, 30_000).unref(); // ages in the popover, mode timers running out
}

// ---------- notch island ----------
// A black island that lives in the MacBook notch (or hangs from the top edge as a "virtual
// notch" on screens without one). Between lines it rests there as a small icon: the Earpiece
// mark, how many agents are running and one status dot; click it for the list of agents. A line
// peeks it open for a few seconds, then it folds back to rest. It never takes focus, follows you
// across Spaces and full-screen apps, stays out of Mission Control, and lets clicks through
// everywhere except the island itself. The core writes card.json (see src/card.mjs); we poll its
// mtime. The shape and animation live in renderer/card.*.

const CARD_W = 480; // the open island is 460 wide, plus its curved shoulders
// One fixed height, tall enough for the open card or the agents list plus its shadow. Resizing a
// transparent window while the island animates makes it stutter, so the window never resizes;
// clicks go through the empty part.
const CARD_H = 560;
// Electron can't read the notch's real width (NSScreen.auxiliaryTopLeftArea), so this is a
// slightly generous estimate: the wings' logo and dot must sit outside the cut-out.
const NOTCH_W = 204;
const notchDisplays = new Map(); // display id -> menu bar height, for built-in screens with a notch
let cardWin = null;
let cardReady = false;
let cardPending = null;
let cardMtime = 0;
let cardHover = false;
const cardPointer = createCardPointer({
  getWindow: () => cardWin,
  getCursor: () => screen.getCursorScreenPoint(),
  onChange(on) {
    cardHover = on;
    if (cardWin && !cardWin.isDestroyed()) cardWin.webContents.send("card-pointer", on);
  },
});

// The island rests in the notch unless the card is off or you only want it for updates.
const restIcon = () => prefs.get().showCard !== false && prefs.get().notchIcon !== "updates";

function createCardWin() {
  cardWin = new BrowserWindow({
    // macOS "panel" (a non-activating NSPanel style mask): floats over full-screen apps and joins
    // every Space without turning Earpiece into a Dock-less agent app, and clicking it doesn't pull
    // focus away from the app you're in.
    type: process.platform === "darwin" ? "panel" : undefined,
    width: CARD_W,
    height: CARD_H,
    show: false,
    frame: false,
    // The island draws concave shoulders. Native corner rounding clips them at
    // full width, leaving gaps where the expanded panel meets the screen edge.
    roundedCorners: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    // Mission Control and App Exposé leave it out instead of laying it out like a window.
    hiddenInMissionControl: true,
    // Frameless windows may sit in the menu bar strip; this stops macOS pushing it below.
    enableLargerThanScreen: true,
    webPreferences: webPreferences(),
  });
  // "status" is above the menu bar, so the island can sit over it, in the notch.
  cardWin.setAlwaysOnTop(true, "status");
  cardWin.setHiddenInMissionControl?.(true);
  // The panel type above is what lets it show over full-screen apps; this keeps it on every Space.
  // skipTransformProcessType keeps the Dock icon (otherwise macOS briefly turns us into an agent app).
  cardWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  cardWin.setIgnoreMouseEvents(true, { forward: true });
  cardWin.loadFile(path.join(APP_ROOT, "renderer", "card.html"));
  lockDown(cardWin);
  cardWin.webContents.once("did-finish-load", () => {
    cardReady = true;
    cardPointer.start();
    sendAgents();
    if (cardPending) sendCard(cardPending);
    else if (restIcon()) showRest();
    cardPending = null;
  });
  cardWin.on("closed", () => (cardPointer.stop(), (cardWin = null), (cardReady = false)));
}

// A notch shows up as a taller menu bar (about 37 pt against 24) on the built-in screen. The
// menu bar is gone in a full-screen app, so remember what we saw per display.
function noteDisplays() {
  for (const d of screen.getAllDisplays()) {
    const menuH = d.workArea.y - d.bounds.y;
    if (d.internal && menuH >= 30) notchDisplays.set(d.id, menuH);
  }
}

function notchFor(d) {
  const mode = prefs.get().notch || "auto";
  const menuH = d.workArea.y - d.bounds.y;
  const seen = notchDisplays.get(d.id) || (d.internal && menuH >= 30 ? menuH : 0);
  if (seen) notchDisplays.set(d.id, seen);
  const notch = mode === "on" ? true : mode === "off" ? false : Boolean(seen);
  return { notch, notchW: NOTCH_W, notchH: notch ? Math.max(seen || menuH, 32) : 0 };
}

// Where the island rests: the screen with the notch, else the built-in one, else the main one.
function homeDisplay() {
  const all = screen.getAllDisplays();
  return all.find((d) => notchDisplays.has(d.id)) || all.find((d) => d.internal) || screen.getPrimaryDisplay();
}

const cursorDisplay = () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
const currentDisplay = () => (cardWin ? screen.getDisplayMatching(cardWin.getBounds()) : homeDisplay());

let warnedClamp = false;
let placedOn = null;
function placeCard(d = cursorDisplay()) {
  const geom = notchFor(d);
  cardWin.setBounds({ x: Math.round(d.bounds.x + (d.bounds.width - CARD_W) / 2), y: d.bounds.y, width: CARD_W, height: cardH });
  const got = cardWin.getBounds();
  if (got.y !== d.bounds.y && !warnedClamp) {
    warnedClamp = true;
    lib.log({ error: `app card: macOS moved the island to y=${got.y} (wanted ${d.bounds.y})` });
  }
  // Once per screen, so a notch that isn't picked up can be told apart from a window that never showed.
  const key = `${d.id}:${geom.notch}`;
  if (placedOn !== key) {
    placedOn = key;
    lib.log({ app: "card placed", display: d.id, internal: Boolean(d.internal), notch: geom.notch, menuH: d.workArea.y - d.bounds.y, x: got.x, y: got.y });
  }
  cardWin.webContents.send("card-geom", geom);
}

function showRest() {
  if (!cardWin || !cardReady) return;
  if (!cardWin.isVisible()) {
    placeCard(homeDisplay());
    cardWin.setIgnoreMouseEvents(true, { forward: true });
    cardWin.showInactive();
  }
  cardWin.webContents.send("card-rest", true);
}

// Turn the resting icon on or off after a preference change (and once at launch).
function applyRest() {
  if (restIcon()) {
    if (!cardWin) createCardWin();
    else (sendAgents(), showRest());
  } else if (cardWin) {
    cardWin.webContents.send("card-rest", false);
  }
}

// The resting icon and its list show the same sessions as the popover.
function sendAgents(s) {
  if (!cardWin || !cardReady) return;
  const st = s || state();
  cardWin.webContents.send("card-agents", { ...lib.notchAgents(st.sessions), mode: st.mode, rest: restIcon(), now: Date.now() });
}

function onDisplaysChanged() {
  noteDisplays();
  if (!cardWin?.isVisible()) return;
  const all = screen.getAllDisplays();
  const d = all.find((x) => x.id === currentDisplay().id) || homeDisplay();
  placeCard(d);
}

function sendCard(c) {
  if (!cardWin.isVisible()) {
    placeCard();
    cardWin.setIgnoreMouseEvents(true, { forward: true });
    if (hiddenForFocus) (hiddenForFocus = false, app.show?.());
    cardWin.showInactive();
  } else if (!cardHover) {
    // Resting on another screen: bring the line to the one you're working on.
    const d = cursorDisplay();
    if (d.id !== currentDisplay().id) placeCard(d);
  }
  cardWin.webContents.send("card", c);
}

function deliverCard(payload) {
  if (!cardWin) createCardWin();
  if (!cardReady) cardPending = payload;
  else sendCard(payload);
}

// The soft reply (Reply from the notch) waiting on this line's session, as the card needs it.
function replyFor(agent, session) {
  const r = (asks?.list() || []).find((a) => a.soft && a.agent === agent && a.session === session);
  return r ? { id: r.id, expiresAt: r.expiresAt, canDictate: canDictate() } : null;
}

// ---------- voice replies ----------
// The mic in the card's reply box records a short clip; it becomes text in the box, and you send it.
// Pro: Earpiece's hosted speech-to-text. Free: your own OpenAI key. Neither: no mic.
const canDictate = () => plan?.plan === "pro" || Boolean(lib.apiKey?.(lib.config(), "OPENAI_API_KEY"));

async function transcribe(bytes, mime) {
  const type = /^audio\/[\w.+-]+/.exec(String(mime || ""))?.[0] || "audio/webm";
  const audio = Buffer.from(bytes || []);
  if (audio.length < 500) throw new Error("Didn't catch that. Hold the mic a little longer.");
  if (audio.length > 2_000_000) throw new Error("That clip is too long.");
  if (plan?.plan === "pro") {
    const token = await auth.accessToken();
    const res = await fetch(`${SUPABASE}/functions/v1/stt`, {
      method: "POST",
      headers: { apikey: KEY, Authorization: `Bearer ${token}`, "Content-Type": type },
      body: audio,
      signal: AbortSignal.timeout(30_000),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok) return String(j.text || "");
    if (!lib.apiKey(lib.config(), "OPENAI_API_KEY")) throw new Error(j.error || "Voice replies are unavailable right now.");
  }
  const key = lib.apiKey(lib.config(), "OPENAI_API_KEY");
  if (!key) throw new Error("Voice replies need Earpiece Pro or an OpenAI key.");
  const form = new FormData();
  form.append("file", new Blob([audio], { type }), `reply.${type.includes("wav") ? "wav" : type.includes("mp4") ? "m4a" : "webm"}`);
  form.append("model", "gpt-4o-mini-transcribe");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Couldn't transcribe that (HTTP ${res.status}).`);
  return String((await res.json()).text || "");
}

let lastLine = null; // { c, at }: the last done line shown, so a soft reply opened just after it can join it
function presentCard(c) {
  if (!c?.line || prefs.get().showCard === false) return;
  // A question is on screen: keep it there. The line is still spoken, just not shown over it.
  // Soft replies don't count: they ride on the lines instead.
  if (asks?.list().some((a) => !a.soft)) return;
  const a = c.agent ? lib.getAdapter(c.agent) : null;
  const agentName = c.agent ? lib.agentConfig(lib.config(), c.agent).label || a?.name || c.agent : "Earpiece";
  lastLine = { c, at: Date.now() };
  deliverCard({ ...lib.cardPayload(c, { agentName, project: c.project }), reply: c.session ? replyFor(c.agent, c.session) : null });
}

// For a soft reply that holds the agent (Codex): only while you're away from its terminal. Unknown
// terminal → don't hold, a stuck terminal is worse than a missing Reply button.
async function awayFromSession(ask) {
  const bundle = lib.getSession(ask.agent, ask.session)?.origin?.app?.bundle;
  if (!bundle) return false;
  const front = await frontApp().catch(() => null);
  return !front || front.bundleId !== bundle;
}

// ---------- answering from the card ----------
// A blocking hook (see src/hub/asks.mjs) is waiting for you. The oldest question is on the card;
// the rest queue behind it ("+N more"). The island turns amber in the notch and only opens when
// you click it. Nothing is approved unless you click a button.

const cardH = CARD_H;
let hiddenForFocus = false;
let lastAnswer = null; // what the card just sent, so onAsksChange can show a one-line confirmation

function agentLabel(id) {
  const a = id ? lib.getAdapter(id) : null;
  return id ? lib.agentConfig(lib.config(), id).label || a?.name || id : "Earpiece";
}

const ARM_MS = 700; // the renderer disables the buttons for this long; the app enforces it too
// The question you can actually see: set when the island is opened on it ("expanded"), cleared
// when it folds back. Answers are only taken for this one, ARM_MS after it opened.
let shown = { id: null, at: 0 };

function askPayload(list) {
  const a = list[0];
  if (shown.id !== a.id) shown = { id: null, at: 0 };
  return {
    id: a.id,
    line: a.line,
    kind: "needs_input",
    state: "ask",
    agentId: a.agent,
    agentName: agentLabel(a.agent),
    session: a.session || null,
    project: a.project || null,
    more: list.length - 1,
    at: a.at,
    ask: { id: a.id, kind: a.kind, tool: a.tool || null, detail: a.detail || "", why: a.why || "", canAlways: Boolean(a.canAlways), alwaysRule: a.alwaysRule || "", partial: Boolean(a.partial), expiresAt: a.expiresAt, canDictate: canDictate() },
  };
}

function confirmText(ask, answer) {
  if (ask.kind !== "permission") return "Reply sent";
  const what = ask.tool || "request";
  if (answer.behavior === "deny") return `Denied ${what}`;
  return answer.behavior === "always" ? `Always allowed ${what}` : `Allowed ${what}`;
}

function onAsksChange(list, change) {
  if (prefs.get().showCard === false) return;
  const hard = list.filter((a) => !a.soft);
  if (hard.length) return deliverCard(askPayload(hard));
  if (change.ask.soft) {
    if (change.type === "answered" && lastAnswer) {
      releaseCardFocus();
      const { ask, answer } = lastAnswer;
      return deliverCard({ id: `ok-${ask.id}`, line: confirmText(ask, answer), kind: "done", state: "spoken", agentId: ask.agent, agentName: agentLabel(ask.agent), project: ask.project || null, brief: true });
    }
    // Opened: add the Reply button to that session's line if it's still the one on the card (the
    // reply usually arrives first, but the summary can win the race). Closed: take the button away.
    if (change.type === "open") {
      const l = lastLine;
      if (l && Date.now() - l.at < 60_000 && l.c.agent === change.ask.agent && l.c.session === change.ask.session) presentCard(l.c);
    } else if (cardWin?.isVisible()) cardWin.webContents.send("card", { state: "reply-gone", replyId: change.ask.id });
    return;
  }
  // The last question just closed.
  releaseCardFocus();
  if (change.type === "answered" && lastAnswer) {
    const { ask, answer } = lastAnswer;
    return deliverCard({ id: `ok-${ask.id}`, line: confirmText(ask, answer), kind: "done", state: "spoken", agentId: ask.agent, agentName: agentLabel(ask.agent), project: ask.project || null, brief: true });
  }
  cardPending = null;
  if (cardWin?.isVisible()) cardWin.webContents.send("card", { state: "clear" });
}

// The reply box needs the keyboard, so the card becomes focusable only while you type in it.
// Before the box takes the keyboard, note which app had it (your terminal, usually) so it can
// be handed straight back. lsappinfo needs no permission; ids go in as argv, never into a script.
let focusReturn = null;
const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { timeout: 800 }, (err, out) => res(err ? "" : String(out))));
async function frontApp() {
  if (process.platform !== "darwin") return null;
  const asn = (await run("/usr/bin/lsappinfo", ["front"])).trim();
  if (!/^ASN:0x[0-9a-f]+-0x[0-9a-f]+:?$/i.test(asn)) return null;
  const front = lib.parseFrontApp(await run("/usr/bin/lsappinfo", ["info", asn]));
  return front && front.pid !== process.pid ? front : null;
}

async function grabCardFocus() {
  if (!cardWin) return;
  if (!cardWin.isFocusable()) focusReturn = await frontApp().catch(() => null);
  if (!cardWin) return;
  cardWin.setFocusable(true);
  cardWin.focus();
}

function releaseCardFocus() {
  if (!cardWin || cardWin.isFocusable() === false) return;
  cardWin.setFocusable(false);
  const back = focusReturn;
  focusReturn = null;
  if (process.platform !== "darwin" || win?.isVisible() || popover?.isVisible()) return;
  // Re-activate the app you were in; the island stays where it is.
  if (back) return void execFile("/usr/bin/open", ["-b", back.bundleId], () => {});
  // Don't know who had it: hide the app instead, unless a question is still waiting (hiding the
  // app would hide its card too). The resting icon comes back with the next line.
  if (!asks?.size()) {
    hiddenForFocus = true;
    app.hide();
  }
}

function checkCard() {
  let st;
  try {
    st = fs.statSync(lib.P.card);
  } catch {
    return;
  }
  if (st.mtimeMs === cardMtime) return;
  cardMtime = st.mtimeMs;
  const c = lib.readJson(lib.P.card, null);
  if (c && Date.now() - (c.at || 0) < 30_000) presentCard(c);
}

// ---------- actions ----------

function setMode(mode, minutes = 0) {
  lib.setMode(mode, minutes);
  if (mode === "off") lib.stopSpeaking();
  refresh();
}

function connectAgents(only) {
  const lines = [];
  for (const a of lib.listAdapters()) {
    if (!a.install || (only && a.id !== only)) continue;
    try {
      // chain: keep any existing Codex notify command and forward to it.
      lines.push(...a.install({ cmd: [lib.shimFile], chain: true, ask: lib.config().answerFromCard === true, reply: lib.config().replyFromNotch === true }));
    } catch (e) {
      lines.push(`✗ ${a.name}: ${e.message}`);
    }
  }
  refresh();
  const restart = only === "claude-desktop" ? "" : "\n\nRestart any open Claude Code or Codex sessions so they pick up the hooks.";
  return tidy(lines) + restart;
}

function disconnectAgents(only) {
  const lines = [];
  for (const a of lib.listAdapters()) {
    if (!a.install || (only && a.id !== only)) continue;
    try {
      lines.push(...a.install({ cmd: [lib.shimFile], uninstall: true }));
    } catch (e) {
      lines.push(`✗ ${a.name}: ${e.message}`);
    }
  }
  refresh();
  return tidy(lines) || "Nothing to remove.";
}

// Installer lines carry full paths and backup names; the popover only needs the gist.
function tidy(lines) {
  return lines
    .map((l) => tidyPath(l).replace(/\s+\(backup: [^)]*\)/, ""))
    .join("\n");
}

async function testVoice() {
  const { speak } = await core("src/voice/speak.mjs");
  const { phrase } = await core("src/i18n.mjs");
  const ph = phrase(lib.config(), "test");
  return speak(ph.text, "done", { src: "app-test", force: true, lang: ph.lang });
}

function buildMenu() {
  const { mode } = modeInfo();
  return Menu.buildFromTemplate([
    { label: "Open Earpiece", click: () => showMain() },
    { type: "separator" },
    { label: "On", type: "radio", checked: mode === "on", click: () => setMode("on") },
    { label: "Quiet for 1 hour", sublabel: "shows updates, no voice", type: "radio", checked: mode === "quiet", click: () => setMode("quiet", 60) },
    { label: "Off", type: "radio", checked: mode === "off", click: () => setMode("off") },
    { type: "separator" },
    { label: "Stop talking now", click: () => (lib.stopSpeaking(), refresh()) },
    { label: "Test voice", click: () => testVoice() },
    { type: "separator" },
    { label: "Agents…", click: () => showMain("agents") },
    { label: "Settings…", click: () => showMain("voice") },
    { label: "Activity", click: () => showMain("activity") },
    { type: "separator" },
    ...(updater?.state().newer ? [{ label: `Update to ${updater.state().latest}…`, click: () => showMain("overview") }] : []),
    { label: `Earpiece ${app.getVersion()}`, enabled: false },
    { label: "Quit Earpiece", accelerator: "Cmd+Q", click: () => app.quit() },
  ]);
}

// ---------- popover ----------

function createPopover() {
  popover = new BrowserWindow({
    width: 360,
    height: 480,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    vibrancy: "popover",
    visualEffectState: "active",
    webPreferences: webPreferences(),
  });
  popover.loadFile(path.join(APP_ROOT, "renderer", "popover.html"));
  // Hide on click-away like any menu bar popover. The main window is always one click away.
  popover.on("blur", () => {
    if (!popover.webContents.isDevToolsOpened()) popover.hide();
  });
  lockDown(popover);
}

function showPopover() {
  if (!tray) return;
  if (!popover) createPopover();
  const b = tray.getBounds();
  const { workArea } = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
  const [w] = popover.getSize();
  const x = Math.round(Math.min(Math.max(b.x + b.width / 2 - w / 2, workArea.x + 8), workArea.x + workArea.width - w - 8));
  const y = Math.round(b.y + b.height + 4 > workArea.y ? b.y + b.height + 4 : workArea.y + 4);
  popover.setPosition(x, y, false);
  popover.show();
  popover.focus();
  popover.webContents.send("state", state());
}

function togglePopover() {
  if (popover?.isVisible()) popover.hide();
  else showPopover();
}

// ---------- main window ----------

const webPreferences = () => ({
  preload: path.join(APP_ROOT, "preload", "preload.cjs"),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
});

function lockDown(w) {
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.webContents.on("will-navigate", (e) => e.preventDefault());
}

function createMain() {
  win = new BrowserWindow({
    width: 1000,
    height: 680,
    minWidth: 820,
    minHeight: 540,
    show: false,
    title: "Earpiece",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 20 },
    vibrancy: "sidebar",
    visualEffectState: "followWindow",
    backgroundColor: process.platform === "darwin" ? "#00000000" : "#f5f5f7",
    webPreferences: webPreferences(),
  });
  win.loadFile(path.join(APP_ROOT, "renderer", "app.html"));
  lockDown(win);
  // Closing the window keeps Earpiece running in the menu bar; ⌘Q quits.
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
  win.once("ready-to-show", () => win.show());
}

function showMain(section) {
  if (!win) createMain();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
  }
  win.focus();
  if (process.platform === "darwin") app.focus({ steal: true });
  popover?.hide();
  if (section && SECTIONS.includes(section)) {
    const go = () => win.webContents.send("navigate", section);
    if (win.webContents.isLoading()) win.webContents.once("did-finish-load", go);
    else go();
  }
}

function appMenu() {
  const go = (section, key) => ({ label: section[0].toUpperCase() + section.slice(1), accelerator: `Cmd+${key}`, click: () => showMain(section) });
  return Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { label: "Check for Updates…", click: () => showMain("general") },
        { type: "separator" },
        { label: "Settings…", accelerator: "Cmd+,", click: () => showMain("voice") },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { label: `Quit ${app.name}`, accelerator: "Cmd+Q", click: () => app.quit() },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        ...SECTIONS.map((s, i) => go(s, i + 1)),
        { type: "separator" },
        ...(app.isPackaged ? [] : [{ role: "reload" }, { role: "toggleDevTools" }]),
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Voice",
      submenu: [
        { label: "Stop Talking", accelerator: "Cmd+.", click: () => (lib.stopSpeaking(), refresh()) },
        { label: "Test Voice", accelerator: "Cmd+T", click: () => testVoice() },
        { type: "separator" },
        { label: "On", click: () => setMode("on") },
        { label: "Quiet for 1 Hour", click: () => setMode("quiet", 60) },
        { label: "Off", click: () => setMode("off") },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [{ label: "Earpiece on GitHub", click: () => shell.openExternal("https://github.com/adissocrazy/earpiece") }],
    },
  ]);
}

// ---------- jumping to the agent ----------
// A click on the island (or Open on an Overview row) brings forward the window the agent runs
// in: the exact iTerm2 or Terminal tab, the editor window with its folder, or just the app. See
// src/hub/jump.mjs. With nowhere to go, the dashboard opens instead.

async function jumpToSession(agent, session, { fallback = true } = {}) {
  const a = agent ? String(agent) : null;
  const s = a && session ? lib.getSession(a, String(session)) : null;
  let r;
  try {
    r = await lib.jumpTo({ agent: a, origin: s?.origin || null, cwd: s?.cwd || null });
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  lib.log({ app: "jump", agent: a, how: r.how || "none", precision: r.precision || "none", ...(r.why ? { why: r.why } : {}), ...(r.note ? { note: r.note } : {}) });
  if (!r.ok) {
    if (r.error) lib.log({ error: `app jump: ${r.error}` });
    if (fallback) showMain("overview");
  } else if (r.note === "folder-missing" && prefs.get().showCard !== false && !asks?.size()) {
    // Say why you landed on the app and not the project window. Shown, never spoken.
    const agentName = a ? lib.agentConfig(lib.config(), a).label || lib.getAdapter(a)?.name || a : "Earpiece";
    const line = "That session's folder is gone, so only the app came forward.";
    deliverCard({ ...lib.cardPayload({ id: `jump-${Date.now()}`, line, kind: "info", agent: a, project: s?.project, session: session ? String(session) : null, state: "spoken" }, { agentName, project: s?.project }), brief: true });
  }
  return r;
}

// ---------- IPC ----------
// The renderers get these and nothing else (see preload.cjs). Arguments are checked here.

ipcMain.handle("state", () => state());
// Mark a session done (or idle), or forget it. Only sessions that exist can be touched.
ipcMain.handle("session", (_e, action, agent, session) => {
  const a = String(agent || "");
  const id = String(session || "");
  if (!lib.getSession(a, id)) return { ok: false, error: "That session is gone." };
  try {
    if (action === "jump") return jumpToSession(a, id, { fallback: false }).then((r) => (r.ok ? { ok: true, precision: r.precision } : { ok: false, error: r.error || "Nowhere to go for this session yet." }));
    if (action === "done") lib.setSessionStatus(a, id, "done");
    else if (action === "forget") lib.forgetSession(a, id);
    else return { ok: false, error: "unknown action" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
  refresh();
  return { ok: true };
});
ipcMain.handle("card", (e, action, value) => {
  if (!cardWin || e.sender !== cardWin.webContents) return;
  if (action === "hidden") {
    if (asks?.size()) return; // a stale "hidden" from a card that was replaced by a question
    releaseCardFocus();
    if (restIcon()) return showRest(); // stale: the island rests instead of hiding
    cardWin.hide();
  }
  else if (action === "rest") {
    // Back to the resting icon: return to its home screen if a line pulled it elsewhere.
    releaseCardFocus();
    const d = homeDisplay();
    if (!cardHover && cardWin.isVisible() && d.id !== currentDisplay().id) placeCard(d);
  }
  // DOM enter/leave only requests a check; animation and click-through can emit
  // spurious leave events while the native cursor is still over the island.
  else if (action === "hover") cardPointer.check();
  else if (action === "rect") {
    const v = value && typeof value === "object" ? value : {};
    cardPointer.setRect({ w: Math.min(Math.max(Number(v.w) || 0, 0), CARD_W), h: Math.min(Math.max(Number(v.h) || 0, 0), CARD_H) });
  }
  else if (action === "stop") (lib.stopSpeaking(), refresh());
  else if (action === "open") showMain("overview");
  else if (action === "jump") {
    const v = value && typeof value === "object" ? value : {};
    jumpToSession(v.agent, v.session);
  }
  else if (action === "focus") (value ? grabCardFocus() : releaseCardFocus());
  else if (action === "size") {} // the window has a fixed height now (see CARD_H)
  else if (action === "expanded") {
    const id = value == null ? null : String(value);
    shown = id && asks?.get(id) ? { id, at: Date.now() } : { id: null, at: 0 };
  } else if (action === "defer") {
    // "Answer in the terminal instead": hand the question back and take you to that terminal.
    const ask = asks?.get(String(value));
    asks?.cancel(String(value), "deferred");
    if (ask) jumpToSession(ask.agent, ask.session, { fallback: false });
  }
});
// The card's answer to a question. Only the card window may send it, and the shape is checked
// again in asks.answer() (unknown id, "always" when it isn't offered, empty reply).
// Only the card may use the microphone, and only for the reply box. Everything else is denied
// (Electron would otherwise grant any permission a page asks for).
function guardPermissions() {
  const allow = (wc, permission, details) => permission === "media" && wc === cardWin?.webContents && !(details?.mediaTypes || []).includes("video");
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => cb(allow(wc, permission, details)));
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin, details) => allow(wc, permission, { mediaTypes: details?.mediaType ? [details.mediaType] : [] }));
}
app.whenReady().then(guardPermissions);

ipcMain.handle("dictate", async (e, action, bytes, mime) => {
  if (!cardWin || e.sender !== cardWin.webContents) return { ok: false, error: "not available" };
  if (action === "start") {
    if (!canDictate()) return { ok: false, error: "Voice replies need Earpiece Pro or an OpenAI key." };
    const granted = process.platform !== "darwin" || systemPreferences.getMediaAccessStatus("microphone") === "granted" || (await systemPreferences.askForMediaAccess("microphone"));
    return granted ? { ok: true } : { ok: false, error: "Allow the microphone for Earpiece in System Settings → Privacy & Security → Microphone." };
  }
  if (action === "transcribe") {
    try {
      return { ok: true, text: (await transcribe(bytes, mime)).trim() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  return { ok: false, error: "unknown action" };
});

ipcMain.handle("ask-answer", (e, id, answer) => {
  if (!cardWin || e.sender !== cardWin.webContents || !asks) return { ok: false, error: "not available" };
  const ask = asks.get(String(id));
  if (!ask) return { ok: false, error: "That question is gone." };
  // Only the question on screen, and only once it has been there a moment, can be answered.
  if (shown.id !== ask.id || Date.now() - shown.at < ARM_MS) return { ok: false, error: "Wait a moment, then try again." };
  const given = answer && typeof answer === "object" ? answer : {};
  // asks.answer() calls onAsksChange before it returns; that is where the confirmation is shown.
  lastAnswer = { ask, answer: { behavior: String(given.behavior || "") } };
  try {
    asks.answer(ask.id, given);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    lastAnswer = null;
  }
});
ipcMain.handle("card-preview", () =>
  presentCard({ id: `preview-${Date.now()}`, line: "Codex, shop. Fixed the checkout bug and all tests pass.", kind: "done", state: "spoken", agent: "codex", project: "shop" }),
);
ipcMain.handle("set-mode", (_e, mode, minutes) => {
  if (!["on", "quiet", "off"].includes(mode)) return;
  setMode(mode, Math.min(Math.max(Number(minutes) || 0, 0), 24 * 60));
});
ipcMain.handle("stop", () => (lib.stopSpeaking(), refresh()));
ipcMain.handle("connect", () => connectAgents());
ipcMain.handle("test-voice", () => testVoice().then((r) => ({ engine: r?.engine || "none", skipped: r?.skipped || null })));
ipcMain.handle("open", (_e, what) => {
  if (what === "log") return shell.openPath(lib.P.log);
  if (what === "config") return shell.openPath(lib.P.config);
});
ipcMain.handle("menu", () => tray.popUpContextMenu(buildMenu()));
ipcMain.handle("hide", () => popover?.hide());
ipcMain.handle("show-main", (_e, section) => showMain(section));
ipcMain.handle("dash", async (e, name, args) => {
  try {
    return { ok: true, value: await dash.action(BrowserWindow.fromWebContents(e.sender), String(name), args && typeof args === "object" ? args : {}) };
  } catch (err) {
    if (!err.user) lib.log({ error: `app ${name}: ${err.message}` });
    return { ok: false, error: lib.redact(tidyPath(err.message)) };
  }
});

app.on("activate", () => showMain()); // dock icon clicked
app.on("before-quit", async (e) => {
  quitting = true;
  if (!hub) return;
  e.preventDefault();
  const h = hub;
  hub = null;
  await h.close().catch(() => {});
  app.quit();
});
app.on("window-all-closed", () => {}); // keeps running in the menu bar
