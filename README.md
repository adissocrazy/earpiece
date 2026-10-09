# earpiece

A voice hub for terminal coding agents. Start a task in Claude Code, another in Codex, walk away, and Earpiece tells you out loud when one of them finishes or needs you:

> "checkout service. Refactored the cart drawer, all tests pass."
>
> "billing needs your permission to use Bash."

It sits between your agents and your speakers. Each agent's hooks send events to one hub. The hub tracks every session, writes a one-sentence summary of what the agent did, and speaks it through the first voice engine that works. Short turns stay silent, duplicate lines are dropped, alerts you already answered are skipped, secrets are never read out, and quiet hours let only the "I need you" pings through (or nothing at all).

Zero dependencies. Node 20 or newer. MIT licensed.

## Why

Running several agents at once turns you into a tab-watcher. You check a terminal, it's still thinking; you go back to something else, and meanwhile another agent has been blocked on a permission prompt for ten minutes. Earpiece removes the checking. You hear about the ones that matter and ignore the rest.

## Install

**On a Mac without the terminal:** download the Mac app from [Releases](https://github.com/adissocrazy/earpiece/releases), open **Agents** and click **Connect**. See [docs/desktop-app.md](docs/desktop-app.md) for the one-time "Open Anyway" step.

**From source:**

```bash
git clone https://github.com/adissocrazy/earpiece.git
cd earpiece
node bin/earpiece.mjs install   # hooks for Claude Code and Codex, backs up every file it edits
npm link                        # optional: puts `earpiece` on your PATH
earpiece test                   # you should hear Earpiece
```

Restart any running Claude Code or Codex sessions so they pick up the hooks.

Voice and summaries get better with API keys, but both are optional. Put them in your environment or in a `.env` file (see `.env.example`), then point Earpiece at it with `earpiece install --env /path/to/.env`:

| Key | Used for | Without it |
| --- | --- | --- |
| `SMALLEST_API_KEY` | [Smallest.ai](https://smallest.ai) Lightning voices, including Indian languages | falls through to OpenAI or the system voice |
| `OPENAI_API_KEY` | one-sentence summaries (gpt-4o-mini) and OpenAI TTS | first sentence of the agent's message, system voice |

Keys are read at call time and never written to logs. With an OpenAI key, the tail of each agent's final message (up to 6,000 characters) is sent to OpenAI to write the summary; leave the key unset if your code can't leave your machine. [SECURITY.md](SECURITY.md) has the details.

## Agents

| Agent | How it connects | Events |
| --- | --- | --- |
| Claude Code | `UserPromptSubmit`, `Stop`, `Notification` and `PostToolUse` hooks in `~/.claude/settings.json` | turn start/end, permission prompts, idle, and tool activity so answered prompts stay quiet |
| Codex CLI | top-level `notify` in `~/.codex/config.toml` | turn end |
| Claude Desktop (chats, Cowork) | a local MCP server (`earpiece mcp`) in `claude_desktop_config.json`; Claude calls its `earpiece_notify` tool and writes the line itself | done, needs you, error |
| Anything else | `earpiece emit` or `earpiece run` | whatever you send |

If Codex already has a `notify` command, the installer leaves it alone and tells you. `earpiece install --chain` keeps your command and adds Earpiece in front of it; `earpiece uninstall` puts yours back. The chain is safe with wrappers that call their own "previous notify" command, even when that command is Earpiece: each Codex turn is spoken once.

Any tool that can run a shell command can talk to the hub:

```bash
earpiece emit --agent aider --type turn_start --project docs-site
earpiece emit --agent aider --type turn_end   --project docs-site "Rewrote the navigation and fixed three broken links."
earpiece emit --agent my-bot --type needs_input --message "wants you to review the migration"
echo '{"agent":"ci","type":"error","project":"api","line":"API build failed on main."}' | earpiece emit
earpiece run -- npm test             # speaks when a long command finishes or fails
```

Claude Desktop has no hooks, so it relies on Claude choosing to call the tool at the end of real work. It usually does; quick chat replies stay silent on purpose. Quit and reopen Claude Desktop after connecting.

**Answer from the card (Mac app, off by default).** Turn it on under General, or run `earpiece answers on`, and the notch can approve or deny a Claude Code / Codex tool request, or carry your reply to a question, without switching to the terminal. Click the notch (or press ⌥⌘I) for the panel: **Needs you** lists every waiting question and recently finished work, **Agents** lists what is running. Every answer is held 2 seconds so Esc can undo it, and unanswered questions fall back to the terminal after about two minutes. See [docs/answer-from-card.md](docs/answer-from-card.md).

To add first-class support for another agent, write an adapter. It is one small file; see [docs/adapters.md](docs/adapters.md).

## See every agent at once

```text
$ earpiece agents
STATUS    AGENT         PROJECT               AGE   LAST
● working Claude Code   checkout service      12s
◆ waiting Codex         billing               3m    billing. Should I also migrate the invoices table?
◆ waiting Claude Code   api                   8m    api needs your permission to use Bash.
✓ done    Aider         docs-site             21m   docs-site. Rewrote the navigation and fixed three broken links.

1 working, 2 waiting on you, 4 total
```

`earpiece agents --all` includes sessions older than 24 hours; `--json` is for scripts and status bars.

## Commands

```text
earpiece install [--only claude-code,codex,claude-desktop] [--chain] [--env path/.env] [--hub | --node]
earpiece env /path/to/.env   # where API keys are read from
earpiece uninstall
earpiece test [--provider smallest|openai|say] [--agent id]
earpiece agents [--all] [--json]
earpiece emit --agent <id> --type <turn_start|turn_end|needs_input|idle|error|info|activity> [text…]
earpiece run -- <command …>
earpiece say "text" [--kind done|needs_input|error|info] [--provider id] [--lang code]
earpiece voices [--gender female] [--accent indian] [--lang hi] [--std]
earpiece voice <id> [--agent id]
earpiece lang <en|hinglish|hi|ta|mr|es|…>
earpiece quiet [minutes]     # no voice, updates still show on screen; default 60 min
earpiece off [minutes]       # silence, default until `earpiece on`
earpiece on
earpiece stop                # stop talking now and drop every queued line
earpiece quiet-hours 22:00-08:00 --silent            # nothing at night
earpiece quiet-hours 22:00-08:00 --allow needs_input  # only "needs you" at night (default)
earpiece quiet-hours off
earpiece serve               # run the hub in the foreground (the Mac app does this for you)
earpiece mcp                 # MCP server for Claude Desktop (added by `install --only claude-desktop`)
earpiece where [--here] [--json]   # which terminal, tab and tmux pane each agent runs in
earpiece status
```

`earpiece where` shows which terminal each of those agents is running in; see [docs/terminal-origin.md](docs/terminal-origin.md).

## Skills & MCP across tools

Claude Code, Codex and Claude Desktop each keep their own MCP servers and skills. `earpiece sync` (or the **Skills & MCP** tab in the Mac app) lists every server and skill against every tool and copies them across:

```
earpiece sync                         # what each tool is missing (--full for everything)
earpiece sync mcp exa                 # add the exa server to every tool that lacks it
earpiece sync skill review --to codex # copy a skill (Codex reads ~/.agents/skills)
earpiece sync skill --outdated        # update copies that fell behind an edited one
earpiece sync remove mcp exa --from codex          # or --everywhere; --dry-run to preview
```

- MCP servers are converted between each tool's format: Codex TOML, Claude Code JSON, and Claude Desktop JSON. Desktop runs remote servers through `mcp-remote`. A server a tool already has is never replaced.
- Anything that can't be copied faithfully is skipped, with the reason shown. Examples: a working folder (`cwd`), or a shell variable that Claude Desktop can't read.
- Skills are copied, not linked. Earpiece fingerprints every copy and marks the ones that fell behind; updating moves the old copy to `~/.earpiece/backups/skills/`.
- Removing an MCP server deletes its entry, backing the file up first. Removing a skill moves its folder to the backups. A symlinked skill is only unlinked, and a folder that another tool links to is kept.
- Claude Code plugins bundle skills and MCP servers. Both show up, tagged with the plugin name, and both can be copied to Codex or Claude Desktop with the plugin's folder paths filled in. Earpiece never edits or removes a plugin's own files: update or uninstall the plugin for that. The plugin's commands, agents and hooks are not copied.
- Account-synced skills and symlinked skills are only ever copied out. Earpiece never edits them in place.
- Every config file is backed up before it changes. `--dry-run` shows what would be written.

## Skill packs

A pack is a named set of skills that installs into every agent at once. Skills can be ones you have installed, folders on disk, or skills in a GitHub repo. Use `earpiece pack` or the **Packs** view in **Skills & MCP**:

```
earpiece pack create team review ~/work/lint github:acme/skills/skills/deploy
earpiece pack install team                   # into Claude Code and Codex (--to, --dry-run)
earpiece pack export team ~/code/team-skills # a folder you can push to GitHub
earpiece pack install github:acme/team-skills  # shows what's inside; add --yes to install
earpiece pack                                # list; also show, preview, delete
```

- A pack from a repo is shown first: every skill, its files, and any scripts. Nothing is copied until you pass `--yes` or click Install. Skills can run code, so read them.
- Installing goes through the same copy as `earpiece sync`: copies that are already up to date are left alone, and edited ones are backed up first.
- An installed pack is saved with its source and commit. Installing it again by name fetches the latest version.
- An export is `earpiece-pack.json` plus `skills/<name>/SKILL.md`, the layout `npx skills` reads. Files that look like secrets (`.env`, `.pem`, `.key`, `id_*`) are left out.
- Private repos work with your usual git login (SSH key or credential helper). Earpiece never asks for a password.

See [docs/skill-packs.md](docs/skill-packs.md) for the manifest format.

## A different voice per agent

When two agents share your speakers, it helps to hear which one is talking.

```bash
earpiece voices --gender female         # browse the Smallest catalog
earpiece voice <voice-id> --agent codex  # Codex gets its own voice
```

Or in `~/.earpiece/config.json`:

```json
{
  "announceAgent": true,
  "agents": {
    "claude-code": { "label": "Claude" },
    "codex": { "voice": "<voice-id>", "minTurnSeconds": 0 },
    "aider": { "enabled": false }
  }
}
```

With `announceAgent` on, lines start with the agent name: "Codex, billing. Migrated the invoices table."

## Languages

`earpiece lang hinglish` makes summaries sound the way many Indian developers talk: Hindi in Devanagari with technical words left in English. `earpiece lang hi`, `ta`, `mr`, `es`, `fr` and about 30 others work too. Earpiece checks that the summary came back in the right script and asks for a rewrite once if it didn't. `earpiece voices --lang hi` lists voices trained on a language.

## Configuration

Everything lives in `~/.earpiece/` (override with `EARPIECE_HOME`): `config.json`, a session registry, and `log.jsonl`. The full list of settings is in [docs/configuration.md](docs/configuration.md); a starting point is in [examples/config.example.json](examples/config.example.json).

## How it works

```text
Claude Code hook ─┐
Codex notify ─────┼─► adapter ─► hub ─► session registry ─► earpiece agents
earpiece emit/run ──┘                └─► worker ─► summary ─► voice engine chain ─► speaker
```

Hooks return within milliseconds. Transcript reads, LLM calls and audio all happen in a detached worker, so Earpiece never slows an agent down. Only one line plays at a time across all agents. [docs/architecture.md](docs/architecture.md) has the details, and [docs/engines.md](docs/engines.md) covers adding a voice engine.

## Usage stats

The Mac app sends usage stats a few times a day so we can tell how many people use Earpiece and which features they use: a random install id (made on first launch), the app version, the macOS version, the CPU architecture, your locale, which agents are connected (for example `claude-code`, `codex`), and feature settings and counts: whether Answer from the card, the card, quiet hours and the agent-name prefix are on, the notch icon mode, the spoken language, the first voice engine and the last one used, whether a Smallest or OpenAI key is set (yes or no, never the key), how many agents have their own voice, and how many lines were spoken and skipped today. The stats are anonymous unless you sign in with Google (optional, under General → Account); then they are linked to your account's email and name. It never sends code, prompts, summaries, project names, file paths or API keys, and the stats table has no IP address column (Supabase, which hosts it, keeps request logs with IPs for a short time). While signed out, turn it off under General → **Share usage stats**. While signed in, stats are always shared with your account; sign out to stop. Launching the app with `EARPIECE_TELEMETRY=0` turns it off either way. The `earpiece` CLI and dev builds (`npm start`) send nothing. The code is [`app/main/telemetry.mjs`](app/main/telemetry.mjs) and [`app/main/auth.mjs`](app/main/auth.mjs). The sign-in session is encrypted with the macOS Keychain (Electron `safeStorage`) before it is saved. Details in [SECURITY.md](SECURITY.md#usage-stats).

## Platform support

macOS works out of the box (`afplay`, `say`). On Linux, install one of `paplay`, `aplay`, `ffplay` or `mpg123` for playback and `espeak-ng` or `spd-say` for the offline voice. Windows is untested; WSL with PulseAudio should work.

## Known limits

- Codex's `notify` only fires at the end of a turn and sends no start time, so every Codex turn is announced. Set `agents.codex.minTurnSeconds` or use `earpiece quiet` if that's too chatty. Codex approval prompts don't trigger a ping yet, but with "Answer from the card" on they show up on the card.
- The installer records the path of the Node binary it ran with. If you switch Node versions with nvm, run `earpiece install` again.
- Smallest's Electron LLM (`"summaryProvider": "smallest"`) isn't available on every plan. When it returns 403, Earpiece uses OpenAI for the summary.
- Smallest allows one TTS request at a time per account. Earpiece already serialises its own speech, but another app using the same key can cause a fallback to the next engine.

## Troubleshooting

- **It keeps repeating a line, or is reading out old ones.** Run `earpiece stop` to go silent and clear the queue, then `earpiece on`. `earpiece status` shows the last few log entries and why lines were skipped. If you're on a version before this fix and use `--chain`, update and re-run `earpiece install --chain`.
- **Nothing is spoken.** Run `earpiece status` and check `mode`, `quietHoursNow` and the keys. Then run `earpiece test --provider say` to rule out the network.
- **A line arrives late or not at all while several agents are busy.** Lines are dropped once they've waited 2 minutes, so you never hear stale news. The log shows `skipped: stale` or `skipped: busy`.

## Coming from Jarvis Voice

Earpiece used to be called Jarvis Voice. Nothing breaks when you update: the first run moves `~/.jarvis-voice` to `~/.earpiece` and leaves a link at the old path, the `jarvis` command and `JARVIS_*` variables still work, and the old Mac app's settings carry over. Run `earpiece install` once to point your hooks and the Claude Desktop entry at the new names. It replaces the old entries instead of adding a second set, so you won't hear every line twice.

## Contributing

Adapters for more agents (Aider, Cursor CLI, Gemini CLI, OpenCode, Goose), more voice engines and more languages are all welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Run the tests with `npm test`.

## License

[MIT](LICENSE)
