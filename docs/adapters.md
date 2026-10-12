# Adapters

An adapter connects one agent to the hub. It translates whatever the agent sends from its hooks into hub events, and it can optionally install itself into the agent's config.

## The event shape

```js
{
  agent: "my-agent",       // adapter id (required)
  session: "abc123",       // conversation or thread id; defaults to project, then cwd
  type: "turn_end",        // turn_start | turn_end | needs_input | idle | error | info | activity
  cwd: "/path/to/repo",    // used to name the project out loud
  project: "checkout",     // explicit project name, overrides cwd
  text: "…",               // the agent's final message, to be summarised
  line: "…",               // exact words to speak, skips summarising
  message: "…",            // reason for needs_input or error
  tool: "Bash",            // tool name for a permission prompt, or the tool that just ran (activity)
  durationMs: 42000,       // turn length, if the agent knows it
}
```

Send `activity` (with `tool`) whenever your agent finishes a tool call if it can ask for approval. Earpiece then drops a pending `needs_input` for that tool instead of announcing a prompt you already answered. `activity` is never spoken.

If your agent sends `turn_start`, Earpiece measures turn length itself and skips short turns. If it can't, send `durationMs` with `turn_end`, or every turn will be announced.

## No code: `earpiece emit`

The quickest integration is a hook that shells out:

```bash
earpiece emit --agent my-agent --type turn_start --session "$SESSION_ID" --cwd "$PWD"
earpiece emit --agent my-agent --type turn_end   --session "$SESSION_ID" --cwd "$PWD" "$LAST_MESSAGE"
```

or pipe a JSON event on stdin: `echo "$EVENT_JSON" | earpiece emit`. Unknown agent ids work without registration; their display name is the id in title case.

When `emit` isn't attached to a terminal (the hook case), it hands the event to the background worker and returns immediately, so it won't hold up your agent. Add `--wait` to block until the line has been spoken, or `--background` to force the hand-off from a terminal.

## Writing an adapter

Create `src/adapters/<id>.mjs`:

```js
export default {
  id: "my-agent",
  name: "My Agent",

  // Required. Runs inside the agent's hook process: keep it synchronous and fast.
  toEvents(payload) {
    if (payload.event === "done")
      return [{ agent: "my-agent", session: payload.id, cwd: payload.cwd, type: "turn_end", text: payload.output }];
    return [];
  },

  // Optional. Runs in the background worker; do slow work (file reads) here.
  async enrich(event) {
    return event;
  },

  // Optional. Used by `earpiece install` / `earpiece uninstall`. Back up before editing,
  // never clobber the user's own settings, return one message per change.
  install({ node, bin, uninstall, chain }) {
    return [];
  },

  // Optional. Shown in `earpiece status`.
  isInstalled() {
    return false;
  },

  // Optional. Pass the raw payload on to a command the user already had (see the Codex adapter).
  // Start it with EARPIECE_FORWARDED=1 in its environment, and make your entry point exit when
  // that variable is set, so a command that calls Earpiece back can't start a loop.
  forward(raw) {},

  // Optional. For agents whose hooks can wait on a decision (see answer-from-card.md). Return a
  // question for the card, or null. kind "permission" shows Allow / Deny; "reply" shows a reply box.
  // Helpers for the Claude Code / Codex payload shapes are in `ask-util.mjs`.
  toAsk(payload) {
    return null; // { kind: "permission", agent, session, cwd, project, tool, detail, line, canAlways }
  },

  // Optional. The JSON the hook prints for the answer ({ behavior, text? }), or null to print nothing.
  askOutput(payload, ask, answer) {
    return null;
  },
};
```

The hook that waits runs `earpiece ask <id>`; the hub holds the connection open until the card answers, and the answer is the hook's stdout. Only install it when `config().answerFromCard` is on (`install({ ask })`).

If the agent can deliver the same event twice, drop duplicates before they reach the hub. The Codex adapter's `firstSeen()` does this with an exclusive-create marker file per turn id.

Register it in `src/adapters/index.mjs`, add a CLI entry if the agent can't pipe to `earpiece hook <id>`, and add tests in `test/adapters.test.mjs` with a real payload captured from the agent (scrub anything personal).

Hook commands must survive quoting, spaces in paths, and a missing Node on PATH, which is why the installers write the absolute Node path and quote everything with `install-util.mjs`.
