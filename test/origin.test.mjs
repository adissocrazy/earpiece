// Where is each agent running: the header the shim sends, the process-tree walk, tmux, the
// classification of terminals, and the tracker that keeps session records current.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { tempHome } from "./helpers.mjs";

tempHome();
const O = await import("../src/hub/origin.mjs");
const { getSession, updateSession } = await import("../src/hub/sessions.mjs");
const { startHubServer } = await import("../src/hub/server.mjs");
const { writeShim } = await import("../src/shim.mjs");
const { BIN, P } = await import("../src/paths.mjs");
const fs = await import("node:fs");

const hasCurl = spawnSync("sh", ["-c", "command -v curl"]).status === 0;
const header = (o = {}) =>
  Object.entries({ ppid: 300, tp: "", bid: "", isid: "", tsid: "", tmux: "", pane: "", kitty: "", wez: "", vsc: "", gh: "", ...o })
    .map(([k, v]) => `${k}=${v}`)
    .join(";");

// ---------- the header ----------

test("parseOriginHeader keeps what is valid and drops what is not", () => {
  const r = O.parseOriginHeader(header({ ppid: 300, tp: "iTerm.app", isid: "w0t1p0:AB12-CD34", tmux: "/private/tmp/tmux-501/default,123,0", pane: "%4", gh: "/Applications/Ghostty.app/x" }));
  assert.equal(r.ppid, 300);
  assert.equal(r.term, "iTerm.app");
  assert.equal(r.iterm, "AB12-CD34");
  assert.equal(r.tmuxSocket, "/private/tmp/tmux-501/default");
  assert.equal(r.pane, "%4");
  assert.equal(r.ghostty, true);

  // anything that could reach a command line or a script later is rejected
  const bad = O.parseOriginHeader(header({ tp: "x$(reboot)", isid: 'a"; do shell script "x', tmux: "relative/path,1,0", pane: "%4 rm", kitty: "1 2", bid: "a b" }));
  assert.equal(bad.term, null);
  assert.equal(bad.iterm, null);
  assert.equal(bad.tmuxSocket, null);
  assert.equal(bad.pane, null);
  assert.equal(bad.kitty, null);
  assert.equal(bad.bundle, null);

  assert.equal(O.parseOriginHeader(""), null);
  assert.equal(O.parseOriginHeader(undefined), null);
  assert.equal(O.parseOriginHeader("ppid=0"), null);
  assert.equal(O.parseOriginHeader("ppid=1"), null);
  assert.equal(O.parseOriginHeader("x".repeat(5000)), null);
  assert.equal(O.parseOriginHeader("tp=iTerm.app"), null, "no pid");
});

test("the VS Code / Cursor app name comes from the askpass path", () => {
  assert.equal(O.parseOriginHeader(header({ vsc: "/Applications/Cursor.app/Contents/Resources/app/node" })).appHint, "Cursor");
  assert.equal(O.parseOriginHeader(header({ vsc: "/Applications/Visual Studio Code.app/Contents/x" })).appHint, "Visual Studio Code");
  assert.equal(O.parseOriginHeader(header({ vsc: "/no/app/here" })).appHint, null);
});

test("rawFromEnv reads this shell's environment", () => {
  const r = O.rawFromEnv({ TERM_PROGRAM: "Apple_Terminal", TERM_SESSION_ID: "ABC-123" }, 4242);
  assert.equal(r.ppid, 4242);
  assert.equal(r.term, "Apple_Terminal");
  assert.equal(r.termSession, "ABC-123");
  assert.equal(O.rawFromEnv({ TERM_PROGRAM: "a;ppid=9" }, 4242).ppid, 4242, "a value cannot inject another field");
});

// ---------- classifying ----------

test("classifyApp: process tree beats bundle id beats TERM_PROGRAM", () => {
  assert.equal(O.classifyApp({ appName: "iTerm2", term: "Apple_Terminal" }).id, "iterm2");
  assert.equal(O.classifyApp({ appName: "Cursor", term: "vscode" }).id, "cursor");
  assert.equal(O.classifyApp({ appName: "Visual Studio Code" }).id, "vscode");
  assert.equal(O.classifyApp({ bundle: "com.apple.Terminal", term: "iTerm.app" }).id, "terminal");
  assert.equal(O.classifyApp({ term: "ghostty" }).id, "ghostty");
  assert.equal(O.classifyApp({ term: "vscode", appHint: "Cursor" }).id, "cursor", "Cursor also says TERM_PROGRAM=vscode");
  assert.equal(O.classifyApp({ appName: "Terminal" }).id, "terminal");
  assert.equal(O.classifyApp({ appName: "Terminus" }).id, "other");
  assert.equal(O.classifyApp({ appName: "Cursor" }).editor, true);
  assert.equal(O.classifyApp({ appName: "iTerm2" }).editor, false);
  assert.equal(O.classifyApp({}), null);
});

// ---------- processes ----------

const PS_ITERM = `
  100     1 ??       /Applications/iTerm.app/Contents/MacOS/iTerm2
  200   100 ttys004  login -fp me
  201   200 ttys004  -zsh
  300   201 ttys004  claude --resume
  310   300 ttys004  sh /Users/me/.earpiece/bin/earpiece-hook claude-code
`;

test("parsePs, walkUp and appOf", () => {
  const t = O.parsePs(PS_ITERM);
  assert.equal(t.size, 5);
  assert.equal(t.get(300).tty, "/dev/ttys004");
  assert.equal(t.get(100).tty, null);
  assert.equal(t.get(300).cmd, "claude --resume");
  assert.deepEqual(O.walkUp(t, 300).map((p) => p.pid), [300, 201, 200, 100]);
  assert.deepEqual(O.walkUp(new Map([[5, { pid: 5, ppid: 6, cmd: "" }], [6, { pid: 6, ppid: 5, cmd: "" }]]), 5).map((p) => p.pid), [5, 6], "a loop ends");
  assert.deepEqual(O.walkUp(t, 999), []);
  assert.deepEqual(O.appOf("/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper (Plugin)"), { path: "/Applications/Visual Studio Code.app", name: "Visual Studio Code" });
  assert.equal(O.appOf("/usr/bin/login -fp me"), null);
});

test("agentMatcher finds the agent's own process, not a lookalike", () => {
  const m = O.agentMatcher("claude-code");
  assert.ok(m.test("claude --resume"));
  assert.ok(m.test("node /opt/homebrew/bin/claude"));
  assert.ok(!m.test("/Applications/Claude.app/Contents/MacOS/Claudette"));
  assert.ok(O.agentMatcher("codex").test("codex"));
  assert.equal(O.agentMatcher(""), null);
});

// ---------- resolving ----------

const fakeRun = (outputs) => async (cmd, args) => {
  const key = cmd === "ps" ? "ps" : args.find((a) => ["display-message", "list-clients"].includes(a));
  const v = outputs[key];
  if (v instanceof Error) throw v;
  if (v === undefined) throw new Error(`no fake for ${cmd} ${args.join(" ")}`);
  return v;
};

test("iTerm2: the tab is found through the tree, with the session guid", async () => {
  const raw = O.parseOriginHeader(header({ ppid: 300, tp: "iTerm.app", isid: "w0t1p0:AB12-CD34" }));
  const o = await O.resolveOrigin(raw, { agent: "claude-code", run: fakeRun({ ps: PS_ITERM }) });
  assert.equal(o.app.id, "iterm2");
  assert.equal(o.pid, 300);
  assert.equal(o.tty, "/dev/ttys004");
  assert.equal(o.iterm, "AB12-CD34");
  assert.equal(o.jump, "iterm2-session");
  assert.equal(o.confidence, "tab");
  assert.deepEqual(o.via, ["process"]);
  assert.equal(O.describeOrigin(o), "iTerm2 · ttys004");
  assert.equal(O.jumpPrecision(o), "tab");
});

test("iTerm2 reparented to launchd: the env still identifies it", async () => {
  const ps = "  300     1 ttys004  claude\n";
  const raw = O.parseOriginHeader(header({ ppid: 300, tp: "iTerm.app", isid: "w0t1p0:AB12-CD34" }));
  const o = await O.resolveOrigin(raw, { agent: "claude-code", run: fakeRun({ ps }) });
  assert.equal(o.app.id, "iterm2");
  assert.equal(o.tty, "/dev/ttys004");
  assert.ok(o.via.includes("env"));
  assert.equal(o.jump, "iterm2-session");
});

test("Terminal.app jumps by tty", async () => {
  const ps = "  100     1 ??       /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal\n  201   100 ttys007  -zsh\n  300   201 ttys007  codex\n";
  const o = await O.resolveOrigin(O.parseOriginHeader(header({ ppid: 300, tp: "Apple_Terminal" })), { agent: "codex", run: fakeRun({ ps }) });
  assert.equal(o.app.id, "terminal");
  assert.equal(o.jump, "terminal-tty");
  assert.equal(o.tabTty, "/dev/ttys007");
});

test("Cursor and VS Code are told apart, and jump to the window", async () => {
  const mk = (app) => `  100     1 ??       /Applications/${app}.app/Contents/MacOS/Electron\n  150   100 ??       /Applications/${app}.app/Contents/Frameworks/X Helper.app/Contents/MacOS/X Helper (Plugin)\n  201   150 ttys010  /bin/zsh -il\n  300   201 ttys010  claude\n`;
  const cur = await O.resolveOrigin(O.parseOriginHeader(header({ ppid: 300, tp: "vscode", vsc: "/Applications/Cursor.app/Contents/Resources/app/node" })), { agent: "claude-code", run: fakeRun({ ps: mk("Cursor") }) });
  assert.equal(cur.app.id, "cursor");
  assert.equal(cur.jump, "editor-window");
  const vs = await O.resolveOrigin(O.parseOriginHeader(header({ ppid: 300, tp: "vscode" })), { agent: "claude-code", run: fakeRun({ ps: mk("Visual Studio Code") }) });
  assert.equal(vs.app.id, "vscode");
  assert.equal(O.jumpPrecision(vs), "window");
});

const TMUX_PS = `
  100     1 ??       /Applications/Ghostty.app/Contents/MacOS/ghostty
  110   100 ttys001  /usr/bin/login -flp me /bin/zsh
  120   110 ttys001  tmux attach
  900     1 ??       tmux: server
  910   900 ttys012  -zsh
  300   910 ttys012  claude
`;
const TMUX_OUT = {
  ps: TMUX_PS,
  "display-message": "$3\tmain\t2\teditor\t0\t/dev/ttys012\n",
  "list-clients": "120\t/dev/ttys001\t1700000000\n",
};

test("tmux: the pane's tty, and the terminal of the attached client, not the one that started tmux", async () => {
  const raw = O.parseOriginHeader(header({ ppid: 300, tp: "iTerm.app", isid: "w0t0p0:OLD-TERMINAL", tmux: "/private/tmp/tmux-501/default,900,0", pane: "%7" }));
  const o = await O.resolveOrigin(raw, { agent: "claude-code", run: fakeRun(TMUX_OUT) });
  assert.equal(o.app.id, "ghostty", "the stale iTerm env is overruled by the client's process tree");
  assert.equal(o.tty, "/dev/ttys012");
  assert.equal(o.tabTty, "/dev/ttys001");
  assert.deepEqual({ session: o.tmux.session, window: o.tmux.window, paneIndex: o.tmux.paneIndex, pane: o.tmux.pane }, { session: "main", window: 2, paneIndex: 0, pane: "%7" });
  assert.equal(o.tmux.clientTty, "/dev/ttys001");
  assert.equal(o.jump, "app");
  assert.ok(o.via.includes("tmux"));
  assert.equal(O.describeOrigin(o), "Ghostty · ttys001 · tmux main:2.0");
});

test("tmux: with several clients the most recently active one wins", async () => {
  const ps = TMUX_PS + "  130   100 ttys002  tmux attach\n";
  const out = { ...TMUX_OUT, ps, "list-clients": "130\t/dev/ttys002\t1600000000\n120\t/dev/ttys001\t1700000000\n" };
  const o = await O.resolveOrigin(O.parseOriginHeader(header({ ppid: 300, tmux: "/private/tmp/tmux-501/default,900,0", pane: "%7" })), { agent: "claude-code", run: fakeRun(out) });
  assert.equal(o.tmux.clientTty, "/dev/ttys001");
  assert.equal(o.tmux.clients, 2);
});

test("tmux: detached, the old terminal in the env is not trusted for a tab", async () => {
  const out = { ...TMUX_OUT, "list-clients": "" };
  const raw = O.parseOriginHeader(header({ ppid: 300, tp: "iTerm.app", isid: "w0t0p0:OLD", tmux: "/private/tmp/tmux-501/default,900,0", pane: "%7" }));
  const o = await O.resolveOrigin(raw, { agent: "claude-code", run: fakeRun(out) });
  assert.equal(o.tmux.session, "main");
  assert.equal(o.tmux.clientTty, null);
  assert.notEqual(o.jump, "iterm2-session", "would open the wrong tab");
});

test("tmux missing or broken: still reports the tmux pane and the terminal from the tree", async () => {
  const o = await O.resolveOrigin(O.parseOriginHeader(header({ ppid: 300, tmux: "/private/tmp/tmux-501/default,900,0", pane: "%7" })), { agent: "claude-code", run: fakeRun({ ps: TMUX_PS, "display-message": new Error("no server") }) });
  assert.equal(o.tmux.pane, "%7");
  assert.equal(o.tmux.session, null);
  assert.equal(O.describeOrigin(o).includes("tmux"), false);
});

test("ps failing is not fatal", async () => {
  const o = await O.resolveOrigin(O.parseOriginHeader(header({ ppid: 300, tp: "ghostty" })), { agent: "claude-code", run: fakeRun({ ps: new Error("boom") }) });
  assert.equal(o.app.id, "ghostty");
  assert.equal(o.tty, null);
  assert.equal(O.describeOrigin(o), "Ghostty");
});

test("nothing known gives jump: none", async () => {
  const o = await O.resolveOrigin(O.parseOriginHeader(header({ ppid: 300 })), { agent: "claude-code", run: fakeRun({ ps: new Error("x") }) });
  assert.equal(o.app, null);
  assert.equal(o.jump, "none");
  assert.equal(O.jumpPrecision(o), "unknown");
  assert.equal(O.describeOrigin(o), "unknown terminal");
  assert.equal(O.describeOrigin(null), "");
});

// ---------- the tracker ----------

test("tracker resolves once, caches by signature, and re-resolves when the agent is gone or the place changes", async () => {
  const store = new Map([["claude-code/s1", {}], ["claude-code/s2", {}]]);
  let runs = 0;
  let alive = true;
  const tracker = O.createOriginTracker({
    run: async (cmd, args) => {
      runs++;
      return fakeRun({ ps: PS_ITERM })(cmd, args);
    },
    isAlive: () => alive,
    read: (a, s) => store.get(`${a}/${s}`),
    update: (a, s, patch) => store.set(`${a}/${s}`, { ...store.get(`${a}/${s}`), ...patch }),
  });
  const h1 = header({ ppid: 300, tp: "iTerm.app", isid: "w0t1p0:AB12-CD34" });
  const first = await tracker.note("claude-code", "s1", h1);
  assert.equal(first.app.id, "iterm2");
  assert.equal(store.get("claude-code/s1").origin.tty, "/dev/ttys004");
  assert.equal(runs, 1);

  // every hook is a new shell with a new $PPID: same signals, no new work
  assert.equal(await tracker.note("claude-code", "s1", header({ ppid: 999, tp: "iTerm.app", isid: "w0t1p0:AB12-CD34" })), null);
  assert.equal(runs, 1);

  // another session is separate
  await tracker.note("claude-code", "s2", h1);
  assert.equal(runs, 2);

  // the signals changed (the session moved to another tab)
  await tracker.note("claude-code", "s1", header({ ppid: 300, tp: "iTerm.app", isid: "w0t2p0:OTHER" }));
  assert.equal(runs, 3);
  assert.equal(store.get("claude-code/s1").origin.iterm, "OTHER");

  // the agent process died: look again
  alive = false;
  await tracker.note("claude-code", "s2", h1);
  assert.equal(runs, 4);

  // junk is ignored
  assert.equal(await tracker.note("claude-code", "s1", "nonsense"), null);
  assert.equal(await tracker.note("", "s1", h1), null);
  assert.equal(await tracker.note("claude-code", "", h1), null);
  assert.equal(runs, 4);
});

test("tracker joins concurrent lookups for the same session and never throws", async () => {
  let runs = 0;
  const tracker = O.createOriginTracker({
    run: async (cmd, args) => {
      runs++;
      await new Promise((r) => setTimeout(r, 20));
      return fakeRun({ ps: PS_ITERM })(cmd, args);
    },
    isAlive: () => true,
    read: () => ({}),
    update: () => {},
  });
  const h = header({ ppid: 300, tp: "iTerm.app" });
  const [a, b] = await Promise.all([tracker.note("claude-code", "s", h), tracker.note("claude-code", "s", h)]);
  assert.equal(runs, 1);
  assert.equal(a, b);

  const broken = O.createOriginTracker({ run: async () => { throw new Error("x"); }, isAlive: () => true, read: () => { throw new Error("read"); }, update: () => {} });
  assert.equal(await broken.note("claude-code", "s", h), null);
});

// ---------- end to end ----------

const post = (route, body, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ socketPath: P.socket, path: route, method: "POST", agent: false, headers: { "Content-Type": "application/json", ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
const waitFor = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
};

test("a hook carrying the header stores the origin on its session", async () => {
  const origins = O.createOriginTracker({ run: fakeRun({ ps: PS_ITERM }), isAlive: () => true });
  const hub = await startHubServer({ origins });
  try {
    const status = await post(
      "/hook/claude-code",
      { hook_event_name: "UserPromptSubmit", session_id: "o1", cwd: "/x/shop", prompt: "hi" },
      { "X-Earpiece-Origin": header({ ppid: 300, tp: "iTerm.app", isid: "w0t1p0:AB12-CD34" }) },
    );
    assert.ok(status < 300);
    assert.ok(await waitFor(() => getSession("claude-code", "o1")?.origin), "origin stored");
    const o = getSession("claude-code", "o1").origin;
    assert.equal(o.app.id, "iterm2");
    assert.equal(o.tty, "/dev/ttys004");

    // a hook without the header is fine, and leaves the origin alone
    assert.ok((await post("/hook/claude-code", { hook_event_name: "UserPromptSubmit", session_id: "o1", cwd: "/x/shop", prompt: "again" })) < 300);
    assert.equal(getSession("claude-code", "o1").origin.app.id, "iterm2");
  } finally {
    await hub.close();
  }
});

test("the generated shim sends the origin header on hooks, asks and replies", { skip: !hasCurl && "no curl" }, () => {
  const shim = writeShim({ fallback: ["/nonexistent/node", BIN] });
  const text = fs.readFileSync(shim, "utf8");
  assert.match(text, /^ORIGIN="ppid=\$PPID;/m);
  assert.equal((text.match(/X-Earpiece-Origin: \$ORIGIN/g) || []).length, 3, "post(), ask and reply");
  for (const v of ["TERM_PROGRAM", "ITERM_SESSION_ID", "TMUX_PANE", "TMUX", "__CFBundleIdentifier"]) assert.ok(text.includes(`$${v}`), v);
  assert.equal(spawnSync("sh", ["-n", shim]).status, 0, "valid shell");
});

test("origin survives updateSession alongside other fields", () => {
  updateSession("codex", "keep", { project: "shop", origin: { v: 1, app: { id: "ghostty" } } });
  updateSession("codex", "keep", { status: "working" });
  assert.equal(getSession("codex", "keep").origin.app.id, "ghostty");
});

test("tracker: a forgotten session is located again; an unknown session is not written", async () => {
  const store = new Map([["a/s", {}]]);
  const writes = [];
  const t = O.createOriginTracker({
    run: fakeRun({ ps: PS_ITERM }),
    isAlive: () => true,
    read: (a, s) => store.get(`${a}/${s}`),
    update: (a, s, patch, opts) => (writes.push(opts), store.set(`${a}/${s}`, { ...store.get(`${a}/${s}`), ...patch })),
  });
  const h = header({ ppid: 300, tp: "iTerm.app" });
  await t.note("a", "s", h);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], { touch: false }, "bookkeeping, not activity");
  assert.equal(await t.note("a", "s", h), null, "cached");
  store.set("a/s", {}); // forgotten and recorded again without an origin
  assert.ok(await t.note("a", "s", h), "looked up again");
  assert.equal(writes.length, 2);
  assert.ok(await t.note("a", "ghost", h) === null && !store.has("a/ghost"), "no skeleton record");
});

test("tracker: a failed lookup is retried soon and never replaces a located origin", async () => {
  const store = new Map([["a/s", {}]]);
  let ps = PS_ITERM;
  const t = O.createOriginTracker({
    run: async (cmd, args) => {
      if (cmd === "ps" && ps instanceof Error) throw ps;
      return fakeRun({ ps })(cmd, args);
    },
    isAlive: () => true,
    read: (a, s) => store.get(`${a}/${s}`),
    update: (a, s, patch) => store.set(`${a}/${s}`, { ...store.get(`${a}/${s}`), ...patch }),
  });
  const h = header({ ppid: 300, tp: "iTerm.app" });
  await t.note("a", "s", h);
  assert.equal(store.get("a/s").origin.tty, "/dev/ttys004");
  assert.equal(store.get("a/s").origin.complete, true);

  // the agent is gone / ps failed: the guess must not overwrite what we know
  ps = new Error("ps timed out");
  const o = await t.note("a", "s", header({ ppid: 300, tp: "iTerm.app", isid: "w0t9p0:CHANGED" }));
  assert.equal(o.complete, false);
  assert.equal(store.get("a/s").origin.tty, "/dev/ttys004");
  assert.ok(O.betterOrigin(null, o));
  assert.ok(!O.betterOrigin(store.get("a/s").origin, o));
});

test("a shell wrapper is not mistaken for the agent, and the npm package path matches", async () => {
  const ps = `  100     1 ??       /Applications/Ghostty.app/Contents/MacOS/ghostty
  200   100 ttys003  -zsh
  300   200 ttys003  codex
  310   300 ttys003  /bin/sh -c /Users/me/.earpiece/bin/earpiece-hook codex {"type":"agent-turn-complete"}
`;
  const o = await O.resolveOrigin(O.parseOriginHeader(header({ ppid: 310 })), { agent: "codex", run: fakeRun({ ps }) });
  assert.equal(o.pid, 300);
  assert.ok(O.agentMatcher("claude-code").test("node /opt/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume"));
  assert.ok(!O.agentMatcher("claude-code").test("/Users/me/claude-codex-notes/x"));
});

test("TMUX socket paths with commas survive", () => {
  assert.equal(O.parseOriginHeader(header({ tmux: "/tmp/a,b/sock,1234,0" })).tmuxSocket, "/tmp/a,b/sock");
  assert.equal(O.parseOriginHeader(header({ tmux: "/tmp/tmux-501/default,1234,0" })).tmuxSocket, "/tmp/tmux-501/default");
});

test("tmux with a client but no app in its tree does not borrow the env's terminal", async () => {
  const ps = TMUX_PS.replace("/Applications/Ghostty.app/Contents/MacOS/ghostty", "/sbin/launchd");
  const o = await O.resolveOrigin(O.parseOriginHeader(header({ ppid: 300, tp: "iTerm.app", isid: "w0t0p0:OLD", tmux: "/private/tmp/tmux-501/default,900,0", pane: "%7" })), { agent: "claude-code", run: fakeRun({ ...TMUX_OUT, ps }) });
  assert.equal(o.app, null);
  assert.equal(o.jump, "none");
});

test("updateSession can leave `updated` alone", async () => {
  const { updateSession: upd, getSession: get } = await import("../src/hub/sessions.mjs");
  const a = upd("codex", "touch", { project: "x" });
  await new Promise((r) => setTimeout(r, 5));
  upd("codex", "touch", { origin: { v: 1 } }, { touch: false });
  assert.equal(get("codex", "touch").updated, a.updated);
  upd("codex", "touch", { status: "working" });
  assert.ok(get("codex", "touch").updated > a.updated);
});

test("the shim drops a header with control characters or an absurd length, and still parses as shell", { skip: !hasCurl && "no curl" }, () => {
  const shim = writeShim({ fallback: ["/nonexistent/node", BIN] });
  const text = fs.readFileSync(shim, "utf8");
  const probe = (env) => {
    const script = text.split("post()")[0] + '\nprintf %s "$ORIGIN"\n';
    const f = path.join(os.tmpdir(), `shim-probe-${process.pid}.sh`);
    fs.writeFileSync(f, script);
    return spawnSync("sh", [f], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" }).stdout;
  };
  assert.match(probe({ TERM_PROGRAM: "iTerm.app" }), /^ppid=\d+;tp=iTerm\.app;/);
  assert.match(probe({ TERM_PROGRAM: "bad\nvalue" }), /^ppid=\d+$/);
  assert.match(probe({ TERM_PROGRAM: "x".repeat(3000) }), /^ppid=\d+$/);
  assert.match(probe({ TERM_PROGRAM: "$(touch /tmp/pwned);`id`\"'" }), /tp=\$\(touch/, "sent as inert text");
});
