# Changelog

## Unreleased

- Fix: the notch card now shows over full-screen apps (Cursor, VS Code, a full-screen terminal). It is a macOS panel window, so it joins every Space without hiding the Dock icon, and clicking it no longer pulls focus from the app you are in.

## 0.4.2 (2026-10-04)

- **Reply from the notch** (General, on by default; existing connected agents get the new hook once on the first launch). A Reply pill on every finished line in the notch: type the next instruction and the agent carries on in its own terminal. Claude Code uses a non-blocking asyncRewake Stop hook (up to 30 minutes, the terminal is never held); Codex holds its Stop hook for 60 seconds, only while you are away from its terminal. See [docs/answer-from-card.md](docs/answer-from-card.md#reply-from-the-notch).
- **Voice replies.** A mic in the notch's reply box: tap, speak, tap again. Your words land in the box and you press Send. Works with Earpiece Pro (hosted speech-to-text) or your own OpenAI key. macOS asks for microphone access the first time.
- Fix: the uninstaller now recognises every hook Earpiece writes, including the new reply hook, and hooks installed from the CLI (`earpiece install`) support replies too.

## 0.4.1 (2026-10-03)

- **Earpiece Pro is available.** $10 a month or $96 a year, through Dodo Payments. Free users see an Upgrade to Pro banner at the top of Overview; signed-out users get Sign in to upgrade.
- **Earpiece Pro hosted voice.** Signed-in Pro users get natural AI voices and one-line summaries on Earpiece's keys, with no API keys of their own. The Mac app keeps a short-lived token in `~/.earpiece/account.json`; the new `earpiece` engine and hosted summary are tried first and fall back to your own keys or the system voice on any error, over the 3,000-line monthly cap, or when you're not Pro. General → Account shows the plan and this month's usage. Server code (Supabase Edge Functions and migrations) is in `supabase/`. See [SECURITY.md](SECURITY.md#earpiece-pro-hosted-voice).
- **Upgrade to Pro from the app.** General → Account → Upgrade to Pro ($10/month) or Yearly ($96/year) opens a Dodo Payments checkout in your browser; Pro switches on by itself once payment goes through. Manage billing opens Dodo's portal to change card or cancel; Pro stays until the paid period ends.

## 0.4.0 (2026-10-03)

- **Optional sign-in with Google.** A sign-up screen on first launch (Continue with Google, or Skip for now), and General → **Account** later. The session is stored encrypted with the macOS Keychain. While you are signed in, usage stats are always shared with your account; sign out to stop. General also states what is never collected: prompts, code, agent messages, summaries, project names, paths and keys.
- **Usage stats in the Mac app.** A few times a day the app sends a random install id, the app and macOS versions, the CPU architecture, the locale, which agents are connected, which features are on and how many lines were spoken today, so we can count installs and see which features are used. Anonymous while signed out, and off with General → **Share usage stats**; `EARPIECE_TELEMETRY=0` turns it off either way, and the CLI sends nothing. See [SECURITY.md](SECURITY.md#usage-stats).
- **A resting icon in the notch, with all your agents one click away.** Between lines the island no longer disappears. It rests in the notch with the Earpiece mark, a count of running agents and one status dot (green working, amber needs you, red error, grey idle; dimmer when Earpiece is Off or Quiet). Click it for the list of agents: working, waiting and errored sessions plus anything that finished in the last 30 minutes, the ones that need you first, each with project, status, last line and age. Click a row to jump to that agent. The list has On / Quiet / Off and Open dashboard. Lines still peek out of the notch as before, then fold back to the icon. New General → **Notch icon** ("Always" or "Only on updates"). The app logs which screen the island was placed on and whether a notch was detected.
- Smoother island. It grows out of the notch on a gentle spring and folds back without the bounce that made the wings dip into the notch. The window no longer resizes mid-animation (it keeps one fixed size and stays click-through), and the shadow is lighter so it isn't repainted heavily on every frame.
- The open card and the agents list close when you click outside them or move away (about a quarter of a second for the list, under half a second for the card). The app also watches the pointer itself, because a quick move into another app could skip the page's own leave event and leave the island open, catching clicks.
- Fix: after you typed a reply on the card, Earpiece hid itself to give the keyboard back, which hid the island too. It now re-activates the app you were in (read with `lsappinfo`, no permission needed) and only falls back to hiding when it can't tell.
- Fix: clicking a session that runs in a subfolder of a project open in Cursor or VS Code (a monorepo opened at its root, then `cd app && claude`) opened a second editor window on the subfolder. Earpiece now reads which windows the editor has open (its `storage.json` and `Backups/workspaces.json`, including multi-root `.code-workspace` files) and brings forward the window whose root holds the session's folder, the deepest one if several do. If no window has it, a repo root is opened as before; a plain subfolder only brings the editor forward and is never opened as a new window. Editors live in one table (`src/hub/editors.mjs`) with one reader per editor family, so Windsurf, VS Code Insiders, VSCodium, Trae, Kiro, Void and Positron work the same way and adding another is one row. Remote (SSH, container) windows are skipped.
- If the session's folder has been deleted, the click brings the app forward and the island says so. `earpiece jump --dry-run` now shows the editor windows it found and why it picked one; `earpiece doctor` lists them too and checks `config.json` for paths that no longer exist (like an old `--previous-notify` target). The app logs each jump with how far it got.
- **Quiet is now fully silent.** Quiet mode used to still speak "needs you" and errors. It now reads nothing aloud and plays no chime, while every update still shows in the notch; "needs you" stays amber and errors red so they stand out. Quiet hours are unchanged and still let the kinds you allow through.
- Fix: the collapsed wings' layer caught clicks meant for the open card on screens without a notch (the Stop and Dismiss buttons sit under it).

- **One-click updates in the Mac app.** When a newer release is out, a banner at the top of Overview and under General → About offers **Update**. Earpiece downloads the zip, checks its size and SHA-256, checks the bundle id, version and signature, then replaces itself and reopens; if the swap fails the old copy is put back. When it can't replace itself (running from the disk image or a translocated copy, a read-only folder, or a release without a checksum) the button is **Download** and opens the disk image. The menu bar menu gets "Update to …" too. See [docs/desktop-app.md](docs/desktop-app.md#updates).
- **Click the card to go to the agent.** The top of the island now takes you to the agent's window: the exact iTerm2 tab and split, the exact Terminal.app tab, the VS Code / Cursor / Windsurf window with the project open, or the app itself for Claude Desktop, the Codex app and other terminals. Ids are passed to `osascript` as arguments. The first jump asks for Automation permission once. **In terminal** on a question also takes you there, and each Overview row has an **Open** button. New `earpiece jump [n] [--agent X] [--dry-run]`.
- Fix: Codex's thread-title turn (`{"title":"…"}`) was spoken as if it were an update. It is now ignored.
- Release workflow: releases are published directly (no more drafts) with a `SHA256SUMS` file, which one-click updates use when GitHub doesn't report a digest.

- **The card now lives in the notch.** A new line opens a black island out of the MacBook notch for a few seconds, then it folds back into the notch: the agent's logo on the left of the notch, a waveform or a status dot (green done, amber needs you, red error) on the right. Click the notch to open it again; it folds back a moment after the pointer leaves. Screens without a notch get the same island as a flat-topped pill at the top centre, and General → **Notch** overrides detection (Electron can't see the notch, so it is inferred from the taller menu bar on the built-in screen). Questions from **Answer from the card** no longer open by themselves: the island turns amber and pulses, with a count when several are waiting, and opens when you click it. The 0.7 s arming now starts when it opens, and the app only accepts an answer for the question that is open.
- Fix: the card showed up in Mission Control and App Exposé as if it were a window. It is now left out (`hiddenInMissionControl`).
- Fix: a question card's `ask` state also matched the question panel's CSS class, so the whole card picked up the panel's margin and flex layout.

## 0.3.0 (2026-10-01)

- **Where is each agent running?** Earpiece now works out which terminal app, tab and tmux pane every agent session lives in. New `earpiece where` (`--here` for the shell you're in, `--json`, `--refresh`, `--all`) and a terminal/tty/tmux label on each session row in the Mac app. The shim sends the agent's parent pid and a few terminal variables (no extra processes); the hub walks the process tree and asks tmux which terminal is really attached, once per session, in the background. iTerm2, Terminal.app, VS Code, Cursor, Windsurf, Ghostty, Warp, kitty, WezTerm and Alacritty are recognised. Nothing leaves your Mac. This is step one of clicking the card to jump to the right window; the click isn't wired up yet. See [docs/terminal-origin.md](docs/terminal-origin.md). Existing sessions show "not seen yet" until the agent's next hook.
- **Answer from the card** (off by default; General → "Answer from the card", or `earpiece answers on`). When Claude Code or Codex asks to run a tool, the card shows the command with Allow / Deny (and Always allow on Claude Code, when Claude offers a rule for it), and when a turn ends on a question the card has a reply box whose text goes back to the agent as your next instruction. Buttons wake up after a moment so a stray click can't approve anything, nothing is approved by keyboard, and the card only takes the keyboard while you click into the reply box. Unanswered questions go back to the terminal after about two minutes, or at once with "In terminal", and disappear if you answer in the terminal, send a new prompt, or the hook is killed. Only works with the Mac app running and the card on. Commands too long to read in full show their start and end and can only be denied. It adds blocking `PermissionRequest` and `Stop` hooks (`earpiece ask <agent>`; Codex hooks go in `~/.codex/hooks.json` and must be trusted once with `/hooks`); turning it off removes them. See [docs/answer-from-card.md](docs/answer-from-card.md). Claude Desktop stays notify-only.

- Fix: the floating card and the "speaking" indicator (menu bar icon, wave, Stop button) now follow the audio, not the TTS request. The card used to appear as "speaking" the moment a line reached the speaker and stay that way through a slow or hung voice API (up to 8 s for Smallest, then 15 s for OpenAI). It now appears when audio is about to play; nothing shows while the API is still working. If every voice fails, the line shows as a text card with a "No voice" chip instead of a false "spoken" one, is logged as `voice_failed`, and is not remembered as said, so a retry is not dropped as a duplicate. Stop pressed while the API is still working now prevents the line from playing at all. A "speaking" card left behind by a crashed process stops counting after 60 s. The chime now plays while the request is in flight instead of before it.
- Engines: `ctx.ready()` is new. `playBuffer` calls it for you; an engine that plays audio some other way (like `say`) should `await ctx.ready?.()` right before it starts.

- **Jarvis Voice is now Earpiece** ([earpiece.dev](https://earpiece.dev)). The command is `earpiece`, the home folder is `~/.earpiece`, variables are `EARPIECE_*`, the Claude Desktop tool is `earpiece_notify` and the Mac app is Earpiece.app. Upgrading needs nothing: the first run moves `~/.jarvis-voice` and leaves a link behind, `jarvis` and `JARVIS_*` keep working, and the app brings its settings across. `earpiece install` swaps old hooks, the Codex notify block and the `jarvis-voice` Claude Desktop entry for the new ones without doubling them.
- **Mac app** (`app/`, released as `app-v*`): a Dock and menu bar app that runs the hub. Its window has Overview, Agents, Voice (with a voice browser and previews), Quiet, API Keys, Activity and General; the menu bar popover keeps sessions, On / Quiet / Off, Stop and Test one click away. It is ad-hoc signed; see [docs/desktop-app.md](docs/desktop-app.md).
- **Claude Desktop**: `jarvis mcp` is a stdio MCP server with one tool, `jarvis_notify`, that Claude calls when it finishes real work or needs you. `jarvis install --only claude-desktop` (or Connect in the app) adds it to `claude_desktop_config.json`.
- **Floating card**: the Mac app shows a small card under the menu bar with the agent's logo, name, project and what it said. It also shows, without sound, in quiet mode and quiet hours and for muted agents. You can turn it off or preview it under General. The core writes `~/.jarvis-voice/card.json` for it.
- Agent logos (Claude, OpenAI) in the Agents page, Overview and popover. The marks come from Simple Icons (CC0) and are trademarks of their owners.
- `jarvis_notify` hardening: the server now cleans every summary for speech (it strips markdown and code, reduces URLs to their domain and paths to the file name, drops IDs and secrets, and cuts to 25 words), rejects empty summaries the same way the schema does, ignores repeats within a minute, and throttles more than 5 calls a minute. The tool result now says what happened (queued, or why it wasn't spoken) instead of "ok".
- **Mark done from the app**: sessions that need you, are working or hit an error have a Mark done button in Overview and a ✓ in the menu bar list. Marking one done also drops any queued "needs you" line for it. × forgets a session until the agent speaks again. Session lines no longer repeat the agent and project shown next to them.
- `summaryProvider: "none"` never sends a reply anywhere for a summary.
- Fix: playback no longer blocks the hub while a line is spoken, and Stop mid-line no longer falls through to the next voice provider.
- Hub socket: `jarvis serve` listens on `~/.jarvis-voice/hub.sock` (mode 0600). `jarvis install --hub` points hooks at `~/.jarvis-voice/bin/jarvis-hook`, a small script that posts to the socket with curl (about 5 ms, compared with about 55 ms for a Node start) and falls back to running Jarvis directly when no hub is up. It always exits 0.
- `jarvis install` keeps hooks on that script when they already use it, so re-running it no longer disconnects the app. `--node` switches back.
- `jarvis env <path>` sets where API keys are read from without touching hooks.

## 0.2.2 (2026-09-30)

- Permission and idle alerts you already answered in the terminal are dropped instead of spoken late. Claude Code now also sends `PostToolUse`, which becomes a silent `activity` event; the alert is skipped as `resolved` once the tool it asked about runs, you send a new prompt, or the turn ends. Re-run `jarvis install` to add the hook.
- Secrets are redacted before a line is spoken, logged or sent for a summary: GitHub, Slack, AWS, Google and `sk-` style keys, JWTs, private keys, passwords in URLs, `*_KEY=`/`token:`/`password=` values and long opaque tokens.
- Quiet hours are configurable. `quietHours.allow` lists what may speak at night (`[]` for total silence), and `jarvis quiet-hours 22:00-08:00 [--silent | --allow needs_input,error] | off` sets it. `jarvis status` shows the current window.

## 0.2.1 (2026-09-30)

- Fix: a chained Codex notify wrapper that calls Jarvis back (for example one with `--previous-notify`) no longer causes an endless loop of the same line. Forwarded calls carry `JARVIS_FORWARDED=1`, and each Codex turn is handled once.
- Lines that waited more than 2 minutes for the speaker are dropped instead of read out late. `jarvis off` now also silences lines that were already queued.
- New `jarvis stop` (alias `flush`): stop talking now and drop everything queued.
- A full queue logs `skipped: busy` instead of a lock-timeout error.

## 0.2.0 (2026-09-30)

- Multi-agent hub: adapters turn each agent's hooks into one event format, and a session registry tracks every agent session.
- `jarvis agents` shows what each agent is doing and which ones are waiting on you.
- `jarvis emit` lets any tool send events without writing an adapter.
- Per-agent settings: voice, label, turn threshold, mute.
- Smallest.ai Lightning voices as the default engine, with OpenAI and system voice fallbacks.
- Spoken languages, including Hinglish and Hindi, with a script check on summaries.
- Linux playback and offline voice support.
- Pluggable voice engines and adapters, documented in `docs/`.
- `jarvis install --chain` keeps an existing Codex `notify` command.

## 0.1.0

- Spoken pings for Claude Code and Codex CLI with OpenAI summaries and macOS `say` fallback.
