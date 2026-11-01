# Architecture

```text
src/
  cli/main.mjs            command dispatch; every entry file calls run()
  remote/                 cloud agents (Pro): protocol, sanitize, outbound client, bridge
  cli/remote.mjs          `earpiece remote` (pair, list, emit, replies)
  adapters/               one file per agent: native payload → hub events
    index.mjs             registry; unknown ids get a pass-through adapter
    claude-code.mjs       ~/.claude/settings.json hooks
    codex.mjs             ~/.codex/config.toml notify (+ chaining)
    install-util.mjs      backups and quoting for config edits
  hub/
    events.mjs            the event shape and normalizeEvent()
    hub.mjs               ingest() in the hook process, processEvent() in the worker
    sessions.mjs          session registry (~/.earpiece/sessions/*.json)
  summary/summarize.mjs   agent message → one spoken sentence (LLM, script check, fallback)
  voice/
    speak.mjs             policy, queue checks, lock, dedupe, chime, engine chain
    play.mjs              audio players (afplay, paplay, aplay, ffplay, mpg123)
    engines/              smallest, openai, say (+ registry)
  config.mjs              defaults, config.json, per-agent overrides, API key lookup
  i18n.mjs                languages, script checks, fixed phrases
  policy.mjs              on / quiet / off modes and quiet hours
  lock.mjs                cross-process lock so lines never overlap
  paths.mjs, util.mjs     paths.mjs also moves ~/.jarvis-voice to ~/.earpiece once
  env-compat.mjs          JARVIS_* variables fill in their EARPIECE_* names
bin/earpiece.mjs          the `earpiece` command
bin/jarvis.mjs            the old `jarvis` command, same CLI
jarvis.mjs, install.mjs   legacy entry points kept for hooks installed by 0.1
```

## Flow of one event

1. An agent fires its hook. Claude Code pipes JSON to `earpiece hook claude-code`; Codex runs `earpiece codex '<json>'`.
2. The adapter's `toEvents()` turns that payload into zero or more hub events. This runs in the agent's hook process, so it must be synchronous and cheap.
3. `ingest()` normalizes each event. `turn_start` just marks the session as working and records the start time, then the hook exits. `activity` (a tool finished running) only records the time and tool name. It is never spoken. Anything else is written to `~/.earpiece/tmp/` and handed to a detached `earpiece _worker` process.
4. The worker runs `processEvent()`. A `needs_input` or `idle` event is dropped as `resolved` if the session has moved on since it was raised: a new prompt, the end of the turn, or the tool it asked about running. Otherwise it calls the adapter's optional `enrich()` (Claude Code reads the transcript here), applies per-agent settings, decides what to say, and updates the session registry.
5. `speak()` checks the mode and quiet hours, then waits for the global lock, so only one line plays at a time across every agent.
6. Once it holds the lock, it checks again before speaking. The line is dropped if the user ran `earpiece off` or `earpiece stop` while it waited, if a "needs you" alert was answered in the meantime, if it has been queued for more than 2 minutes, or if the same words were spoken in the last 60 seconds. Otherwise it plays a chime and tries each engine in `ttsProviders` until one succeeds.
7. A line that can't get the lock within 60 seconds is dropped and logged as `skipped: busy`.

## Codex notify chaining

Codex has a single `notify` slot. When something else already uses it, `earpiece install --chain` puts Earpiece in that slot and saves the old command as `codexChain`. After handling an event, Earpiece runs the saved command with the same payload.

Some notify wrappers call their own "previous notify" command, and after chaining that command can be Earpiece. Without a guard this becomes a loop: Codex runs Earpiece, Earpiece runs the wrapper, the wrapper runs Earpiece, and so on, speaking the same line again and again. Two guards prevent it:

- Earpiece starts the chained command with `EARPIECE_FORWARDED=1`. A `earpiece codex` call that sees this variable exits without speaking or forwarding.
- Each Codex turn, identified by thread id and turn id (or by the raw payload when there are no ids), is handled once. The marker is a file in `tmp/` created with an exclusive-create flag, so two processes racing on the same turn can't both win. Markers expire after 10 minutes.

A chain whose command is Earpiece itself is never forwarded to.

## Answered alerts

Claude Code asks for permission, and Earpiece says "api needs your permission to use Bash". If you're at the keyboard you approve it right away, and hearing the alert a few seconds later is just noise. So the Claude Code adapter also listens to `PostToolUse` and turns it into an `activity` event with the tool name.

An alert counts as answered once the session's latest activity is newer than the alert and is for the same tool (or has no tool, like a new prompt or a turn end). Activity from a different tool doesn't count, because parallel tool calls can finish while another one is still waiting for you. The check runs when the worker starts and again inside the speaker lock, so an alert queued behind another line is dropped too.

`PostToolUse` fires after every tool call, and the hook costs one short Node start (about 50 ms). Codex has no approval hook, so this only applies to agents that send `activity`.

## What gets said

| Event | Spoken | Session status |
| --- | --- | --- |
| `turn_end` shorter than `minTurnSeconds` | nothing | done |
| `turn_end` | "<project>. <summary>" | done, or waiting if the message ends with a question |
| `needs_input` | permission / attention phrase, or `line` | waiting |
| `idle` | "<project> is waiting for you", unless the turn end was already announced | waiting |
| `error` | `line`, a summary of `text`, or "hit an error" | error |
| `info` | `line` or `text` as given | unchanged |
| `activity` | nothing | working, if it was waiting |

Quiet hours let the kinds in `quietHours.allow` through (`needs_input` by default, nothing with `earpiece quiet-hours --silent`). `earpiece quiet` speaks nothing (no chimes either); every line still goes to the card with a "Quiet" tag. `earpiece off` silences everything. The registry is updated either way, so `earpiece agents` stays accurate.

## Environment variables

| Variable | Effect |
| --- | --- |
| `EARPIECE_HOME` | state directory (default `~/.earpiece`) |
| `EARPIECE_DRY_RUN=1` | no network, no audio; prints what would be said |
| `EARPIECE_ECHO=1` | print each spoken line |
| `EARPIECE_FOREGROUND=1` | process events inline instead of in a worker (tests, debugging) |
| `EARPIECE_FORWARDED=1` | set by Earpiece on a chained Codex notify; a `earpiece codex` call that sees it does nothing |

## Stopping and clearing the queue

`earpiece stop` (alias `earpiece flush`) stops talking straight away:

1. It writes `flushed.json`. Any line queued before that moment drops itself when it reaches the lock.
2. It deletes pending job files.
3. It kills waiting `earpiece _worker` processes and any audio player using Earpiece's temp files.
4. It removes the lock.

`earpiece off` also silences lines that are already waiting, because the mode is checked again once the lock is held.
