// The hook shim: a tiny shell script agents call instead of Node. It sends the event to the
// hub socket with curl (about 10 ms), and only if nothing is listening does it start the
// core itself. It always exits 0 so it can never block or fail an agent, except `reply`, which exits 2
// on purpose: that is how an asyncRewake hook wakes Claude Code with your reply.
import fs from "node:fs";
import path from "node:path";
import { ASK_CURL_TIMEOUT_SEC, REPLY_CURL_TIMEOUT_SEC } from "./hub/asks.mjs";
import { BIN, P } from "./paths.mjs";

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * @param {object} o
 * @param {string[]} [o.fallback] argv that runs the core CLI, e.g. [node, bin/earpiece.mjs]
 * @param {Record<string,string>} [o.env] extra env for the fallback (ELECTRON_RUN_AS_NODE=1)
 */
export function shimScript({ fallback = [process.execPath, BIN], env = {}, socket = P.socket } = {}) {
  const envs = Object.entries(env).map(([k, v]) => `${k}=${sq(v)} `).join("");
  const argv = fallback.map(sq).join(" ");
  const run = `${envs}${argv}`;
  return `#!/bin/sh
# Earpiece hook shim. Written by Earpiece; \`earpiece uninstall\` removes the hooks that call it.
SOCK=${sq(socket)}
EXE=${sq(fallback[0])}
# Where this agent runs, for the hub to resolve (terminal app, tab, tmux pane). Plain expansion: no forks.
ORIGIN="ppid=$PPID;tp=$TERM_PROGRAM;bid=$__CFBundleIdentifier;isid=$ITERM_SESSION_ID;tsid=$TERM_SESSION_ID;tmux=$TMUX;pane=$TMUX_PANE;kitty=$KITTY_WINDOW_ID;wez=$WEZTERM_PANE;vsc=$VSCODE_GIT_ASKPASS_NODE;gh=$GHOSTTY_RESOURCES_DIR"
# A control character or a huge value would make the hub reject the header (curl -f then fails). Send the bare pid instead.
case $ORIGIN in *[[:cntrl:]]*) ORIGIN="ppid=$PPID";; esac
[ "\${#ORIGIN}" -gt 1500 ] && ORIGIN="ppid=$PPID"
post() { [ -S "$SOCK" ] && command -v curl >/dev/null 2>&1 && curl -fsS -m 2 --unix-socket "$SOCK" -H 'Content-Type: application/json' -H "X-Earpiece-Origin: $ORIGIN" --data-binary @- "http://earpiece$1" >/dev/null 2>&1; }
fallback() { [ -x "$EXE" ] || exit 0; ${run} "$@" >/dev/null 2>&1; exit 0; }
case "$1" in
  hook)
    agent="\${2:-claude-code}"
    payload=$(cat)
    printf '%s' "$payload" | post "/hook/$agent" && exit 0
    printf '%s' "$payload" | fallback hook "$agent"
    ;;
  ask)
    # A blocking hook: the hub holds this request until you answer on the card (or it times out),
    # and whatever it returns is the hook's output. No hub, no answer: print nothing and exit 0,
    # so the agent falls back to its own prompt.
    [ -S "$SOCK" ] && command -v curl >/dev/null 2>&1 || exit 0
    curl -fsS -m ${ASK_CURL_TIMEOUT_SEC} --unix-socket "$SOCK" -H 'Content-Type: application/json' -H "X-Earpiece-Origin: $ORIGIN" --data-binary @- "http://earpiece/ask/\${2:-claude-code}" 2>/dev/null
    exit 0
    ;;
  reply)
    # Claude Code's asyncRewake Stop hook (Reply from the notch): runs in the background after the
    # turn has ended. A reply from the card comes back as text; printing it to stderr and exiting 2
    # wakes the session with it. No reply (timeout, you typed in the terminal): exit 0, nothing happens.
    [ -S "$SOCK" ] && command -v curl >/dev/null 2>&1 || exit 0
    out=$(curl -fsS -m ${REPLY_CURL_TIMEOUT_SEC} --unix-socket "$SOCK" -H 'Content-Type: application/json' -H "X-Earpiece-Origin: $ORIGIN" --data-binary @- "http://earpiece/reply/\${2:-claude-code}" 2>/dev/null) || exit 0
    [ -n "$out" ] || exit 0
    printf '%s\\n' "$out" >&2
    exit 2
    ;;
  codex)
    [ "$EARPIECE_FORWARDED" = 1 ] || [ "$JARVIS_FORWARDED" = 1 ] && exit 0
    for last; do :; done
    printf '%s' "$last" | post /codex && exit 0
    fallback "$@"
    ;;
  mcp)
    # Claude Desktop starts this as a long-running MCP server on stdin/stdout.
    [ -x "$EXE" ] || exit 1
    ${envs}exec ${argv} mcp
    ;;
  *)
    fallback "$@"
    ;;
esac
exit 0
`;
}

export function writeShim(opts = {}, file = P.shim) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, shimScript(opts), { mode: 0o700 });
  fs.renameSync(tmp, file);
  return file;
}
