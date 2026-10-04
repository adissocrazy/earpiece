// Where is each agent running? Which terminal app, which tab (tty), which tmux pane.
//
// The hook shim sends what its environment says (TERM_PROGRAM, ITERM_SESSION_ID, TMUX_PANE, …)
// and its parent pid. The hub, which is long-lived, does the slow part once per session: walk the
// process tree with `ps`, and under tmux ask tmux which terminal the pane is attached to. The
// answer is stored on the session record as `origin`, so `earpiece where`, the app and (later) the
// card's "open terminal" all read the same thing.
//
// Signals, most trustworthy first:
//   1. the process tree: the agent's controlling tty, and the GUI app it descends from
//   2. tmux: the pane's tty and the attached client's tty/app (the env of a tmux pane describes the
//      terminal that STARTED the tmux server, which is often not the one you are looking at)
//   3. the environment: TERM_PROGRAM, __CFBundleIdentifier, ITERM_SESSION_ID …
// Everything that reaches a command line or a script later is validated here, once.
import { execFile } from "node:child_process";
import { now } from "../util.mjs";
import { getSession, updateSession } from "./sessions.mjs";
import { EDITORS } from "./editors.mjs";

export const HEADER = "x-earpiece-origin";
const TTL_MS = 10 * 60_000;

// ---------- the terminals we know ----------

/** `names` are matched against the .app name found in the process tree. */
export const TERMINALS = [
  { id: "iterm2", name: "iTerm2", bundle: "com.googlecode.iterm2", term: ["iTerm.app"], names: [/^iterm/i] },
  { id: "terminal", name: "Terminal", bundle: "com.apple.Terminal", term: ["Apple_Terminal"], names: [/^terminal$/i] },
  { id: "ghostty", name: "Ghostty", bundle: "com.mitchellh.ghostty", term: ["ghostty"], names: [/^ghostty/i] },
  { id: "warp", name: "Warp", bundle: "dev.warp.Warp-Stable", term: ["WarpTerminal"], names: [/^warp/i] },
  { id: "kitty", name: "kitty", bundle: "net.kovidgoyal.kitty", term: ["kitty"], names: [/^kitty$/i] },
  { id: "wezterm", name: "WezTerm", bundle: "com.github.wez.wezterm", term: ["WezTerm"], names: [/^wezterm/i] },
  { id: "alacritty", name: "Alacritty", bundle: "org.alacritty", term: ["alacritty"], names: [/^alacritty/i] },
  // Cursor, VS Code and the other editors come from EDITORS (editors.mjs).
  ...EDITORS.map((e) => ({ id: e.id, name: e.name, bundle: e.bundle, term: e.term || [], names: e.names, editor: true })),
  { id: "codex-app", name: "Codex app", bundle: null, term: [], names: [/^codex/i] },
  { id: "claude-app", name: "Claude app", bundle: null, term: [], names: [/^claude/i] },
];

/** Best match from (in this order) the app found in the process tree, the bundle id, TERM_PROGRAM. */
export function classifyApp({ appName = null, bundle = null, term = null, appHint = null } = {}) {
  const byName = (n) => n && TERMINALS.find((t) => t.names.some((re) => re.test(n)));
  const hit =
    byName(appName) ||
    (bundle && TERMINALS.find((t) => t.bundle && t.bundle.toLowerCase() === bundle.toLowerCase())) ||
    (bundle && /^com\.microsoft\.VSCode/i.test(bundle) && TERMINALS.find((t) => t.id === "vscode")) ||
    byName(appHint) ||
    (term && TERMINALS.find((t) => t.term.includes(term)));
  if (hit) return { id: hit.id, name: hit.name, bundle: hit.bundle, editor: Boolean(hit.editor) };
  const label = appName || appHint || null;
  return label || bundle || term ? { id: "other", name: label || term || bundle, bundle: bundle || null, editor: false } : null;
}

// ---------- the header the shim sends ----------

const RE = {
  word: /^[A-Za-z0-9._-]{1,60}$/,
  bundle: /^[A-Za-z0-9._-]{1,120}$/,
  session: /^[A-Za-z0-9:_-]{1,80}$/,
  socket: /^\/[A-Za-z0-9._\/@ ,-]{1,200}$/,
  pane: /^%\d{1,7}$/,
  digits: /^\d{1,9}$/,
  run: /^run-[a-z0-9-]{1,40}$/,
};

/** "ppid=12;tp=iTerm.app;…" → validated signals. Anything that doesn't look right is dropped. */
export function parseOriginHeader(header) {
  if (typeof header !== "string" || !header || header.length > 2000) return null;
  const kv = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) kv[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  const ok = (v, re) => (typeof v === "string" && re.test(v) ? v : null);
  const ppid = /^\d{1,8}$/.test(kv.ppid || "") ? Number(kv.ppid) : null;
  if (!ppid || ppid < 2) return null;
  // ITERM_SESSION_ID is "w0t1p0:GUID"; the GUID is what iTerm's own scripting calls the session id.
  const isid = ok(kv.isid, RE.session);
  // TMUX is "socket,server-pid,session-index"; a socket path may itself contain commas.
  const socket = /^(.*),\d+,\d+$/.exec(kv.tmux || "")?.[1] ?? (kv.tmux || "").split(",")[0];
  const vscApp = /([^/]+)\.app\//.exec(kv.vsc || "")?.[1] || null;
  return {
    ppid,
    term: ok(kv.tp, RE.word),
    bundle: ok(kv.bid, RE.bundle),
    iterm: isid && isid.includes(":") ? isid.split(":").pop() : isid,
    termSession: ok(kv.tsid, RE.session),
    tmuxSocket: ok(socket, RE.socket),
    pane: ok(kv.pane, RE.pane),
    kitty: ok(kv.kitty, RE.digits),
    wezterm: ok(kv.wez, RE.digits),
    appHint: vscApp && RE.word.test(vscApp.replace(/ /g, "-")) ? vscApp : null,
    ghostty: Boolean(kv.gh),
    // Set when Earpiece itself started the agent in a terminal of its own.
    run: ok(kv.run, RE.run),
  };
}

/** The same signals for the shell you are in right now (`earpiece where --here`). */
export function rawFromEnv(env = process.env, ppid = process.ppid) {
  const g = (k) => String(env[k] ?? "").replace(/[;\n\r]/g, " ");
  return parseOriginHeader(
    `ppid=${ppid};tp=${g("TERM_PROGRAM")};bid=${g("__CFBundleIdentifier")};isid=${g("ITERM_SESSION_ID")};tsid=${g("TERM_SESSION_ID")};` +
      `tmux=${g("TMUX")};pane=${g("TMUX_PANE")};kitty=${g("KITTY_WINDOW_ID")};wez=${g("WEZTERM_PANE")};vsc=${g("VSCODE_GIT_ASKPASS_NODE")};gh=${g("GHOSTTY_RESOURCES_DIR")};run=${g("EARPIECE_RUN_ID")}`,
  );
}

// ---------- processes ----------

const normTty = (t) => {
  const s = String(t || "").trim();
  if (!s || s === "?" || s === "??" || s === "-") return null;
  const full = s.startsWith("/dev/") ? s : `/dev/${s}`;
  return /^\/dev\/[A-Za-z0-9\/]{1,30}$/.test(full) ? full : null;
};

/** Output of `ps -axo pid=,ppid=,tty=,command=` → Map(pid → { pid, ppid, tty, cmd }). */
export function parsePs(text) {
  const table = new Map();
  for (const line of String(text || "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), tty: normTty(m[3]), cmd: m[4] || "" });
  }
  return table;
}

/** [start, parent, grandparent, …] until init, a loop, or 40 steps. */
export function walkUp(table, start) {
  const out = [];
  const seen = new Set();
  for (let pid = start; pid > 1 && !seen.has(pid) && out.length < 40; ) {
    const p = table.get(pid);
    if (!p) break;
    seen.add(pid);
    out.push(p);
    pid = p.ppid;
  }
  return out;
}

/** "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/…" → the outer app. */
// Keep the .app path so a click can bring forward apps we have no bundle id for (ChatGPT, …).
const withPath = (app, gui) => (app ? { ...app, path: gui.path } : app);

export function appOf(cmd) {
  const m = /^(.*?\/([^\/]+)\.app)\/Contents\//.exec(cmd || "");
  return m ? { path: m[1], name: m[2] } : null;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Does this command line look like the agent itself (claude, codex, aider …)? */
export function agentMatcher(agent) {
  const id = String(agent || "");
  const word = id.split(/[-_ ]/)[0];
  if (!word) return null;
  // "claude" as a command or argument; for ids like claude-code also the npm package path (…/claude-code/cli.js)
  const full = id !== word && /^[A-Za-z0-9-]+$/.test(id) ? `|${esc(id)}(\\s|\\/|$)` : "";
  return new RegExp(`(^|[\\/\\s])(${esc(word)}(\\s|$)${full})`, "i");
}

// ---------- running commands ----------

const TMUX_PATHS = ["tmux", "/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/opt/local/bin/tmux", "/usr/bin/tmux"];

function exec(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 2500, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** Default runner. A Finder-launched app has a bare PATH, so tmux is looked for in the usual places. */
export async function run(cmd, args) {
  if (cmd !== "tmux") return exec(cmd, args);
  let last;
  for (const p of TMUX_PATHS) {
    try {
      return await exec(p, args);
    } catch (e) {
      last = e;
      if (e.code !== "ENOENT") throw e; // tmux is there but said no (no server, no such pane)
    }
  }
  throw last;
}

const tmuxArgs = (socket, ...rest) => ["-S", socket, ...rest];

// ---------- resolving ----------

/**
 * Work out where an agent runs.
 * @param {ReturnType<typeof parseOriginHeader>} raw
 * @param {{ agent?: string, run?: typeof run }} o
 */
export async function resolveOrigin(raw, { agent = "", run: runCmd = run } = {}) {
  const via = [];
  let table = new Map();
  let complete = true; // false when a lookup failed, so the answer is a guess that should be retried soon
  try {
    table = parsePs(await runCmd("ps", ["-axww", "-o", "pid=,ppid=,tty=,command="]));
  } catch {}
  const chain = walkUp(table, raw.ppid);
  if (chain.length) via.push("process");
  else complete = false;

  const match = agentMatcher(agent);
  // The nearest match may be a shell wrapper (`sh -c … codex …`); prefer a real process.
  const isShell = (cmd) => /^-?(?:\S*\/)?(?:sh|bash|zsh|dash|fish)(\s|$)/.test(cmd);
  const matches = match ? chain.filter((p) => match.test(p.cmd)) : [];
  const agentProc = matches.find((p) => !isShell(p.cmd)) || matches[0] || null;
  let tty = agentProc?.tty || chain.find((p) => p.tty)?.tty || null;
  const gui = chain.map((p) => appOf(p.cmd)).find(Boolean) || null;

  let app = gui ? withPath(classifyApp({ appName: gui.name, bundle: raw.bundle, term: raw.term, appHint: raw.appHint }), gui) : null;
  let tabTty = tty;
  let tmux = null;

  let detached = false;
  if (raw.tmuxSocket && raw.pane) {
    // Under tmux the agent's tty is the pane's, which no terminal app owns. The tab to open is the
    // one with a client attached, so until a client is found there is no tab.
    tabTty = null;
    try {
      const fmt = "#{session_id}\t#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_tty}";
      const [sessionId, session, window, windowName, paneIndex, paneTty] = (await runCmd("tmux", tmuxArgs(raw.tmuxSocket, "display-message", "-p", "-t", raw.pane, fmt))).trim().split("\t");
      tmux = { socket: raw.tmuxSocket, pane: raw.pane, session, sessionId, window: Number(window), windowName, paneIndex: Number(paneIndex), clientTty: null };
      via.push("tmux");
      tty = normTty(paneTty) || tty;
      // The terminal you are looking at is the one with a tmux client attached to this session.
      const clients = (await runCmd("tmux", tmuxArgs(raw.tmuxSocket, "list-clients", "-t", sessionId, "-F", "#{client_pid}\t#{client_tty}\t#{client_activity}"))).trim().split("\n").filter(Boolean).map((l) => {
        const [pid, ctty, activity] = l.split("\t");
        return { pid: Number(pid), tty: normTty(ctty), activity: Number(activity) || 0 };
      });
      clients.sort((a, b) => b.activity - a.activity);
      const client = clients[0];
      if (client) {
        tmux.clientTty = client.tty;
        tmux.clients = clients.length;
        tabTty = client.tty;
        const clientApp = walkUp(table, client.pid).map((p) => appOf(p.cmd)).find(Boolean);
        app = clientApp ? withPath(classifyApp({ appName: clientApp.name }), clientApp) : null;
      } else (app = null, detached = true); // detached tmux: the env describes the terminal that started it, long gone
    } catch {
      complete = false;
      tmux = tmux || { socket: raw.tmuxSocket, pane: raw.pane, session: null, window: null, paneIndex: null, clientTty: null };
    }
  }

  if (!app && !detached && !tmux) {
    app = classifyApp({ bundle: raw.bundle, term: raw.term, appHint: raw.appHint });
    if (app) via.push("env");
    else if (raw.ghostty) (app = classifyApp({ term: "ghostty" }), via.push("env"));
    else if (raw.kitty) (app = classifyApp({ term: "kitty" }), via.push("env"));
    else if (raw.wezterm) (app = classifyApp({ term: "WezTerm" }), via.push("env"));
  }

  // Started by Earpiece: its terminal lives in the app, whatever the process tree says.
  if (raw.run) app = { id: "earpiece", name: "Earpiece", bundle: null, editor: false };

  const jump = jumpMethod({ app, tabTty, iterm: raw.iterm, tmux });
  return {
    v: 1,
    at: now(),
    pid: agentProc?.pid || null,
    tty,
    tabTty,
    app,
    iterm: raw.iterm || null,
    termSession: raw.termSession || null,
    run: raw.run || null,
    tmux,
    jump: jump.method,
    confidence: jump.confidence,
    complete,
    via,
    raw: { ...raw, ppid: agentProc?.pid || raw.ppid }, // so `where --refresh` can re-resolve later
  };
}

/** How a click could get you there, and how sure we are it lands on the right tab. */
export function jumpMethod({ app, tabTty, iterm, tmux }) {
  if (!app) return { method: "none", confidence: "none" };
  if (app.id === "earpiece") return { method: "earpiece-run", confidence: "tab" };
  if (app.id === "iterm2" && (tabTty || (!tmux && iterm))) return { method: "iterm2-session", confidence: "tab" };
  if (app.id === "terminal" && tabTty) return { method: "terminal-tty", confidence: "tab" };
  if (app.editor) return { method: "editor-window", confidence: "window" };
  return { method: "app", confidence: "app" };
}

const WHAT = { "earpiece-run": "tab", "iterm2-session": "tab", "terminal-tty": "tab", "editor-window": "window", app: "app only", none: "unknown" };

/** "iTerm2 · ttys004 · tmux main:2.0" */
export function describeOrigin(o) {
  if (!o) return "";
  const parts = [o.app?.name || "unknown terminal"];
  if (o.tabTty && o.tabTty !== o.tty) parts.push(o.tabTty.replace("/dev/", ""));
  else if (o.tty) parts.push(o.tty.replace("/dev/", ""));
  if (o.tmux?.session) parts.push(`tmux ${o.tmux.session}:${o.tmux.window ?? "?"}.${o.tmux.paneIndex ?? "?"}`);
  return parts.join(" · ");
}

/** "tab", "window", "app only" or "unknown": how precisely a click would land. */
export const jumpPrecision = (o) => WHAT[o?.jump] || "unknown";

// ---------- keeping the session records current ----------

const pidAlive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

const sameOrigin = (a, b) => JSON.stringify({ ...a, at: 0, raw: 0 }) === JSON.stringify({ ...b, at: 0, raw: 0 });
const signature = (raw) => JSON.stringify({ ...raw, ppid: 0 });
const RETRY_MS = 15_000; // after a failed lookup

/** Should `next` replace `cur`? Never trade a located origin for a guess made while a lookup failed. */
export function betterOrigin(cur, next) {
  if (!cur) return true;
  if (next.complete !== false) return !sameOrigin(cur, next);
  return cur.complete === false && !sameOrigin(cur, next);
}

/**
 * Called from the hub for every hook. Cheap when nothing changed: a hook spawns a new shell each
 * time, so the parent pid differs on every call, but the signals and the agent process do not.
 * Writes only to a session the hub already knows, and never counts as activity on it.
 */
export function createOriginTracker({ run: runCmd = run, isAlive = pidAlive, read = getSession, update = updateSession } = {}) {
  const seen = new Map(); // "agent\0session" → { sig, pid, at, ttl }
  const inflight = new Map();

  async function note(agent, session, header) {
    const raw = parseOriginHeader(header);
    if (!raw || !agent || !session) return null;
    const key = `${agent}\0${session}`;
    const sig = signature(raw);
    const prev = seen.get(key);
    // skip only while the stored record still has its origin (a forgotten session is looked up again)
    if (prev && prev.sig === sig && now() - prev.at < prev.ttl && isAlive(prev.pid) && read(agent, session)?.origin) return null;
    if (inflight.has(key)) return inflight.get(key);
    const job = (async () => {
      try {
        const origin = await resolveOrigin(raw, { agent, run: runCmd });
        const rec = read(agent, session);
        if (!rec) return null; // the hub hasn't recorded this session (yet): try again on the next hook
        if (seen.size > 500) for (const [k, v] of seen) if (now() - v.at > v.ttl) seen.delete(k);
        seen.set(key, { sig, pid: origin.pid || raw.ppid, at: now(), ttl: origin.complete === false ? RETRY_MS : TTL_MS });
        if (betterOrigin(rec.origin, origin)) update(agent, session, { origin }, { touch: false });
        return origin;
      } catch {
        return null;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, job);
    return job;
  }

  return { note, forget: (agent, session) => seen.delete(`${agent}\0${session}`) };
}
