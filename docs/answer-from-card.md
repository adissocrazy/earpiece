# Answer from the card

Approve or deny a tool request, or reply to a question, from the floating card instead of switching to the terminal. Claude Code and Codex are supported. It is off by default. Questions don't open on their own: the card's island turns amber and pulses in the notch until you click it.

## Turn it on

Mac app: General → **Answer from the card**. CLI: `earpiece answers on` (needs the Mac app running, with the card enabled). Then:

1. Restart any open Claude Code / Codex sessions, so they read the new hooks.
2. Codex only: run `/hooks` once and trust the Earpiece hooks. Codex ignores hooks you haven't trusted.

`earpiece answers off` (or the switch) removes the hooks again. `earpiece uninstall` removes them too.

## What you see

- **Tool request** (`PermissionRequest`): the card shows the tool, the exact command or file, and a countdown. **Allow** and **Deny** always; **Always allow** on Claude Code when Claude Code offers a permission rule for the request (it is the same rule the terminal's "don't ask again" option would add). Codex only accepts allow or deny, so there is no Always there.
- **Question** (`Stop`): only when the agent's last message ends with a question mark. The card shows the question and a reply box. **Enter** sends, **Shift+Enter** adds a line, **Esc** leaves the box. Your text continues the turn as the next instruction (`The user replied from the Earpiece card: …`). Claude Code allows up to 8 of these continuations in a row.
- **In terminal** (or the × button) hands the question back right away. The terminal prompt is used exactly as if Earpiece weren't there.
- If several agents are waiting, the oldest is shown with "+N more".

## Safety

- Nothing is approved by keyboard, and the buttons are disabled for the first 0.7 s a question is on screen.
- The card never takes the keyboard by itself. Clicking into the reply box makes it focusable; when you finish, the app hides itself to return the keyboard to the terminal.
- Only the card window can send an answer, and the app checks it again: it must be the question the island is open on, opened at least 0.7 s ago, and the answer must fit (Always only when offered, no empty reply).
- A command too long for the card is shown with its start and its end and a "more characters not shown" marker, and can only be denied or left to the terminal. Invisible and direction-changing characters are stripped, and Always allow names the rule it will add.
- At most 20 questions are open at once; more go straight to the terminal.
- The hub socket is `0600`, with no network port. Commands are redacted (API keys, tokens) before they are shown.
- If Earpiece isn't running, is off, or the card is disabled, the hook prints nothing and the agent asks in the terminal.

## Limits

- The blocking hook holds the agent until you answer or about two minutes pass (hub timeout 115 s; hook timeout 125 s).
- A question disappears from the card when the agent moves on: you answered in the terminal (the tool ran), you sent a new prompt, or the hook process was killed.
- Claude Desktop (MCP) stays notify-only; it has no hook to wait on.
- Other agents: there is no adapter with a blocking hook yet. An adapter can add `toAsk(payload)` and `askOutput(payload, ask, answer)` (see `src/adapters/claude-code.mjs`) and run `earpiece ask <id>` from its hook.

## How it works

`earpiece ask <agent>` (or `earpiece-hook ask <agent>`) reads the hook payload and POSTs it to the hub's `/ask/<agent>`, keeping the connection open. The hub turns it into a question (`src/hub/asks.mjs`), the app shows it, and your answer comes back as the HTTP body, which is exactly the JSON the hook prints to stdout. An empty body (204) prints nothing.

## Reply from the notch

A second switch, General → **Reply from the notch** (on by default; `"replyFromNotch": false` in config turns it off), puts a small
**Reply** pill on every finished line in the notch, not only on questions. Click it, type the next
instruction, press Enter: the agent carries on in its own terminal. Nothing is typed into the terminal.

- **Claude Code**: an `asyncRewake` Stop hook (`earpiece-hook reply claude-code`, timeout 30 min). The turn
  ends normally, so the terminal is never held. Your reply comes back to the hook, which prints it to
  stderr and exits 2; Claude Code wakes the session with it. It replaces the blocking Stop hook from
  Answer from the card (questions get a Reply too); permission requests stay blocking.
- **Codex**: Codex can't wake an idle session, so its Stop hook is held instead, for 60 seconds, and only
  while you're away from that agent's terminal (the app compares the front app with the terminal the
  session runs in; unknown terminal → not held). At the keyboard, Codex is never held.
- A pending reply goes away when you type in the terminal, a newer turn on that session finishes, the
  window ends, or the app quits. One per session. A reply is only a new message: it can't approve anything.
- Restart open sessions after switching it; in Codex, trust the new hooks once with `/hooks`.
