# Features: Free and Pro

What Earpiece does today, split by plan. Free is the open-source app and CLI: everything in this repo, with your own API keys or the system voice. Pro costs $10 a month or $96 a year. It adds hosted voice and AI on Earpiece's keys, plus features that only ship in the release build of the Mac app.

## At a glance

| Feature | Free | Pro |
| --- | --- | --- |
| Spoken updates when an agent finishes, needs you or fails | ✓ | ✓ |
| Claude Code, Codex CLI, Claude Desktop, any tool via `emit` / `run` | ✓ | ✓ |
| Notch island, panel (Needs you / Agents), menu bar, dashboard | ✓ | ✓ |
| Answer from the card (Allow / Deny / reply) | ✓ | ✓ |
| Reply from the notch (typed) | ✓ | ✓ |
| Jump to the agent's terminal, tab, pane or editor window | ✓ | ✓ |
| Skills & MCP sync, skill packs | ✓ | ✓ |
| Quiet, Off, quiet hours, per-agent voices, languages | ✓ | ✓ |
| Voices: Smallest.ai / OpenAI with your own key, macOS `say` | ✓ | ✓ |
| One-line summaries | your OpenAI key, or the first sentence | hosted, no key needed |
| Natural AI voices with no API key | | ✓ hosted |
| "Needs you / done / progress" turn classifier (Jev) | your `TYPESAFE_API_KEY` | hosted, no key needed |
| Voice replies (mic in the reply box) | your OpenAI key | hosted speech-to-text |
| **Earpiece terminals**: start and steer Claude Code / Codex from the notch | | ✓ |
| **Talk**: hold right ⌥ and tell an agent what to do | | ✓ |
| Hosted usage cap | none | 3,000 lines a month, then your own keys |

## Free (open source, MIT)

### Agents and events
- **Claude Code** hooks: `UserPromptSubmit`, `Stop`, `Notification`, `PostToolUse`, giving turn start and end, permission prompts, idle alerts, and tool activity (so prompts you already answered stay quiet).
- **Codex CLI** `notify` (turn end). `--chain` keeps an existing notify command, and loops are guarded with `EARPIECE_FORWARDED`.
- **Claude Desktop** (chats, Cowork) through a local MCP server (`earpiece mcp`) with an `earpiece_notify` tool. Summaries are cleaned for speech, repeats are dropped, and calls are throttled.
- **Anything else**: `earpiece emit` (types `turn_start`, `turn_end`, `needs_input`, `idle`, `error`, `info`, `activity`) and `earpiece run -- <cmd>`, which speaks when a long command finishes or fails.
- **Pluggable adapters** ([adapters.md](adapters.md)).
- **Fast hooks**: a hub socket at `~/.earpiece/hub.sock` with a curl shim (about 5 ms). Hooks always exit 0 and never slow an agent down.

### Speaking
- **Voice engine chain**: Smallest.ai Lightning, then OpenAI TTS, then macOS `say` (or `espeak-ng` / `spd-say` on Linux). The first engine that works speaks. Engines are pluggable ([engines.md](engines.md)).
- **Summaries**: with an OpenAI key, gpt-4o-mini writes a one-line summary from the last 6,000 characters of the agent's reply. Without a key, the first sentence is used. `summaryProvider: "none"` sends nothing off your Mac.
- **Turn classifier**: with your own `TYPESAFE_API_KEY`, Jev decides whether a finished turn asks you something, is done, or is a progress note. Progress notes show on the card without being spoken. Without a key, a turn that ends in `?` counts as needing you.
- **Noise control**: short turns stay silent (`minTurnSeconds`), duplicates are dropped, answered alerts are skipped, lines that waited more than 2 minutes are dropped, and only one line plays at a time across all agents.
- **Secret redaction** before anything is spoken, logged or summarised: API keys, JWTs, private keys, passwords in URLs, and long tokens.
- **Languages**: Hinglish, Hindi, Tamil, Marathi, Spanish, French and about 30 more, with a script check and one rewrite if the summary comes back in the wrong script.
- **Per-agent settings**: voice, label, turn threshold, mute. `announceAgent` prefixes each line with the agent's name.
- **Modes**: On, Quiet (nothing spoken, everything still shown), Off, Stop (silence now and clear the queue), quiet hours (`--silent` or `--allow needs_input`). Quitting the app turns speech off.

### Mac app
- **Notch island**: a resting icon with the agent count and a status dot. Lines peek out of the notch and fold back. On screens without a notch it becomes a pill. It shows over full-screen apps.
- **Notch panel** (click or ⌥⌘I): **Needs you** lists every question, permission request and finished work from the last day, with keyboard control (1–9, J/K, R reply, O open, E clear) and a 2-second undo. **Agents** lists the running sessions.
- **Answer from the card** (off by default): Allow, Deny or Always allow for Claude Code and Codex tool requests, and replies to questions. The buttons wait a moment before they work so a stray click can't approve anything. Unanswered questions fall back to the terminal after about 2 minutes ([answer-from-card.md](answer-from-card.md)).
- **Reply from the notch** (on by default): a Reply pill on finished lines. Claude Code uses a non-blocking asyncRewake Stop hook; Codex holds its Stop hook for 60 seconds, only while you are away from its terminal.
- **Voice replies** with your own OpenAI key (gpt-4o-mini-transcribe).
- **Jump to agent**: the exact iTerm2 tab and split, Terminal.app tab, tmux pane, or the VS Code, Cursor, Windsurf, VSCodium, Trae, Kiro, Void or Positron window whose root holds the session's folder. Also available as `earpiece jump` ([terminal-origin.md](terminal-origin.md)).
- **Dashboard pages**: Overview (sessions, Mark done, Forget, Open), Agents (Connect / Disconnect), Voice (voice browser with previews, speed, chime), Quiet, API Keys (or an existing `.env`), Activity (log with repeated lines folded together), Skills & MCP, and General.
- **General**: account, notch icon (Always / Only on updates), notch detection override, show card, open at login, show in Dock, say the agent's name, language, usage stats toggle, and updates.
- **Menu bar popover**: sessions, On / Quiet / Off, Stop, Test.
- **Updates**: `curl -fsSL https://earpiece.dev/install.sh | bash`, or one-click Update. Downloads are checked (SHA-256, bundle id, signature), and the old copy is restored if the swap fails. New versions are announced in the notch.
- **Optional Google sign-in**. The session is encrypted with the macOS Keychain. Usage stats are anonymous unless you sign in ([SECURITY.md](../SECURITY.md#usage-stats)).

### Skills & MCP
- **`earpiece sync`** and the **Skills & MCP** tab: compares MCP servers and skills across Claude Code, Codex and Claude Desktop, copies them across with format conversion (TOML, JSON, `mcp-remote`), flags outdated copies, removes with a backup first, and supports `--dry-run`. Plugin skills and servers can be copied out but are never edited in place.
- **Skill packs** (`earpiece pack`): create, install into every agent, export to a folder or GitHub, and install from `github:org/repo` with a preview of the files and scripts first ([skill-packs.md](skill-packs.md)).

### CLI
`install`, `uninstall`, `env`, `test`, `agents`, `where`, `jump`, `emit`, `run`, `say`, `voices`, `voice`, `lang`, `quiet`, `off`, `on`, `stop`, `quiet-hours`, `answers`, `sync`, `pack`, `serve`, `mcp`, `status`, `doctor`. Configuration is covered in [configuration.md](configuration.md).

## Pro ($10 a month or $96 a year)

Buy from General → Account → Upgrade (Dodo Payments checkout). Pro switches on by itself once the payment goes through. Manage billing opens the portal. A cancelled plan keeps Pro until the end of the paid period.

### Hosted voice and AI (works in the CLI too once the app is signed in)
- **Natural AI voices with no API key**. The hosted `earpiece` engine is tried first.
- **Hosted one-line summaries** in your chosen language.
- **Hosted turn classifier** (Jev): needs you, done, or progress.
- **Hosted speech-to-text** for voice replies in the notch.
- **Cap**: 3,000 hosted lines a month, shown under General → Account. When the cap is reached, the service is down, or you sign out, everything falls back quietly to your own keys or the system voice.

### Earpiece terminals (Mac app release build)
- **+ New agent** from the notch's agents list or the **Terminals** dashboard page: pick Claude Code or Codex, a folder, a permission mode and an optional first prompt (typed or spoken).
- **Permission modes**: Claude Code (Ask me, Accept edits, Plan only, Skip all prompts) and Codex (Ask me, Read-only, Full access). The modes that skip prompts are hidden until you turn on "Allow modes that skip permission prompts". Each agent can have its own default mode and default folder.
- **Ask me** sends permission prompts to the notch even when Answer from the card is off.
- **Steer from the notch**: Reply (typed or spoken), Stop, End, Remove, and open the live terminal in its own window or in the dashboard.
- **Agents keep running after the app restarts**. The run helper keeps their terminals, and quitting Earpiece asks before stopping them.

### Talk (Mac app release build)
- **Hold the right Option key, or press ⌥⌘T**, and say what to do: "earpiece, run the tests", "tell codex yes", "the second one".
- **Routing**: works out which agent you mean, whether you are giving it work or asking what it is doing (asking gets a spoken answer), and for new work, which app and folder. The options are an Earpiece terminal (Claude Code or Codex), the Codex app, Claude Code in the Claude desktop app, or a Claude chat.
- **Answers** open questions and permission prompts by voice (yes, no, an option number or its label).
- **A receipt before anything is sent**: it shows where your words are going and waits 2 seconds, and Esc takes it back.
- **Never types into your own terminals**: an agent in your own terminal is resumed by its session id in an Earpiece terminal. The desktop apps are opened through their documented links with your words filled in, and you press Enter there.
- **Settings**: where unclear requests go (a default app and folder, or ask you to name the project).

## Where each part lives
- Free: everything in this repo (`src/`, `bin/`, `app/`).
- Pro hosted services: `supabase/functions/` (`tts`, `summarize`, `classify`, `stt`, `route`, `billing`, `dodo-webhook`). The plan and usage tables are in `supabase/migrations/`.
- Earpiece terminals and Talk ship only in the release build of the Mac app. A build from source is the Free app, and a signed-in Pro account there still gets the hosted voice and AI features.
