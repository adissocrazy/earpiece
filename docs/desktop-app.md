# Mac app

Earpiece for Mac is a regular Mac app with a window, a Dock icon and a menu bar icon. It runs the hub, connects your agents with one click, and lets you change everything without a terminal.

The window has seven sections:

- **Overview**: whether Earpiece is listening, On / Quiet / Off, today's counts, the last thing it said, and every agent session from the last 24 hours (amber needs you, blue working, green done, red error).
- **Agents**: Claude Code, Codex and Claude Desktop, each with Connect / Disconnect, the file it edits, and per-agent mute, name, voice and minimum turn length.
- **Voice**: provider order, the Smallest.ai voice browser with search, filters and a play button, model, speed, OpenAI and macOS voices, language, and who writes summaries (including "No summaries" if nothing should leave your Mac).
- **Quiet**: quiet (no voice, updates still show in the notch) or off for a while, and daily quiet hours with what may still speak.
- **API Keys**: paste, test or remove keys, or point Earpiece at an existing `.env`. Saved keys are never shown again.
- **Activity**: a readable log with repeats folded together and filters for spoken, kept quiet and problems.
- **General**: open at login, show in Dock, the settings and log files, and update checks.

The menu bar icon stays for quick access: the popover shows sessions, the mode switch, Stop, Test and **Open app**, and the count of sessions waiting on you sits next to the icon. Closing the window keeps Earpiece running; quit from the app menu (⌘Q) or the menu bar. Turn off **Show in Dock** in General to keep it only in the menu bar. When it starts at login it stays in the menu bar until you open it.

The app and the CLI share `~/.earpiece`: config, voices, mode, quiet hours and the session list. Anything you set with `earpiece …` shows up in the app, and the reverse.

## Install

The quickest way is one line in Terminal:

```
curl -fsSL https://earpiece.dev/install.sh | bash
```

It downloads the newest release from GitHub, checks it against the release's `SHA256SUMS`, its bundle id and its signature, puts it in `/Applications` (or `~/Applications` if you can't write there; it never uses sudo) and opens it. Installed this way the app carries no quarantine flag, so macOS opens it without asking. Run it again any time to reinstall or update. The script is [`landing-page/public/install.sh`](https://earpiece.dev/install.sh) on the website.

Or download `Earpiece-<version>-universal.dmg` from the [releases page](https://github.com/adissocrazy/earpiece/releases) and drag the app to Applications. The build is ad-hoc signed, not notarized, so macOS blocks a downloaded copy the first time you open it:

1. Open Earpiece. macOS says it can't verify the developer. Click **Done**.
2. Open **System Settings → Privacy & Security**, scroll to Security, and click **Open Anyway** next to "Earpiece was blocked".
3. Open the app again and confirm.

On macOS 14 and earlier, right-click the app and choose **Open** instead. If you'd rather clear the flag from a terminal: `xattr -dr com.apple.quarantine "/Applications/Earpiece.app"`.

## Connect your agents

Open **Agents** and click **Connect** next to each agent (the popover's **Connect your agents** does all of them at once). Every connection edits one file and keeps a backup next to it.

- **Claude Code** and **Codex** get hooks that point at `~/.earpiece/bin/earpiece-hook`. If a Codex `notify` command is already configured, it is kept and Earpiece forwards every event to it. Restart open sessions afterwards.
- **Claude Desktop** has no hooks, so Earpiece adds a small MCP server named `earpiece` to `claude_desktop_config.json`. It gives Claude one tool, `earpiece_notify`. Claude calls it at the end of a reply that did real work, or when it stops to ask you something, and writes the spoken line itself, so the chat isn't sent anywhere for a summary. Quit and reopen Claude Desktop after connecting. Each call shows up in the chat as a tool call; you can set it to always allow. It works in chats and Cowork. Whether the Code tab also runs your `~/.claude` hooks depends on the Claude Desktop version; the Activity page shows it if it does.

If you set up hooks earlier with `earpiece install`, connecting from the app replaces them, so you won't hear every line twice. Running `earpiece install` later keeps hooks on the app. To point them back at a CLI checkout, run `earpiece install --node`.

Each session row also says where the agent is running, for example "Claude Code · iTerm2 · ttys004 · tmux main:2.0", and has an **Open** button that takes you there. See [terminal-origin.md](terminal-origin.md).

## Going to the agent

Click the top of the island (the logo, the agent and the project) to go to the window that agent runs in. On a question, **In terminal** sends the question back to the terminal and takes you there too. What you land on depends on the app:

| App | Lands on |
| --- | --- |
| iTerm2 | the exact tab and split |
| Terminal.app | the exact tab |
| VS Code, Cursor, Windsurf and other VS Code-based editors | the window that has the project open |
| Claude Desktop, the Codex app, Ghostty, Warp and the rest | the app comes forward |

For editors, Earpiece looks up which windows are open and picks the one whose folder holds the session, so an agent started in `app/` of a monorepo you opened at its root brings that window forward rather than opening `app/` in a new one. If no window has the folder, the editor just comes forward. If the folder was deleted, the app comes forward and the island tells you.

The first jump into iTerm2 or Terminal asks for Automation permission once (System Settings → Privacy & Security → Automation). If the tab has closed, the app comes forward instead; if Earpiece doesn't know where the session runs yet, the Overview opens. Under tmux you land on the terminal tab that is attached, not on a particular pane. Nothing is ever typed into a terminal.

## Marking sessions done

If you've answered an agent somewhere Earpiece can't see, or you just want a session out of the way, click **Mark done** on its row in Overview. In the menu bar list, hover the row and click ✓. Earpiece won't speak a "needs you" line for that session if one is still queued, and the menu bar count goes down. Hover a row in Overview and click × to forget the session. It comes back the next time that agent sends something.

## The notch island

Each time Earpiece speaks, a black island opens out of the MacBook notch for a few seconds. It shows the agent's logo, its name, the project and the line, with a pulsing ring while the line plays. Then it folds back into the notch: the agent's logo sits on the left of the notch and a waveform (while speaking) or a coloured dot sits on the right. Green is done, amber is needs you, red is an error. Click the notch to open it again. It stays open while the pointer is on it and folds back a moment after you move away. After a while (15 seconds, or 45 for "needs you" and errors) it settles back into the resting icon.

Between lines the island rests in the notch as a small icon. The Earpiece mark and the number of running agents sit on the left of the notch, and one dot sits on the right: green when something is working, amber pulsing when an agent needs you, red on an error and grey when nothing is running. It is dimmer when Earpiece is Off or Quiet. Click it for the list of agents: everything working, waiting or in error, plus anything that finished in the last 30 minutes, with the ones that need you first. Each row shows the agent, project, status, last line and how long ago. Click a row to go to that agent's window, the same way a click on a line does. The list also has On / Quiet / Off and **Open dashboard**. Click anywhere outside it, or move the pointer away, and it folds back. It sits on the screen with the notch (or the main screen), and moves to the screen you're on when a line arrives. Set **Notch icon** under General to "Only on updates" if you'd rather keep the notch empty between lines.

Screens without a notch (an external display, older MacBooks) get the same island as a flat-topped pill at the top centre. If your notch isn't picked up, set **Notch** under General to "Always use the notch" or "No notch".

The island never takes focus, it follows you across Spaces and full-screen apps, Mission Control leaves it out, and clicks go through everything except the island itself.

It also shows when Earpiece stays silent because of quiet mode, quiet hours or a muted agent, with a small "Quiet" or "Muted" tag. In Quiet nothing is spoken or chimed at all, but every line still pops out of the notch; "needs you" stays amber and errors stay red. When Earpiece is Off, no lines show (the resting icon stays, dimmed). You can turn the card off, which also removes the icon, or preview it, under General.

With **Answer from the card** on (General), the island can also carry a question. It doesn't open by itself for a question: it turns amber and pulses in the notch, with a count when more than one is waiting. Click it to see Allow / Deny for a tool request, or a reply box when the agent ended on a question. It still never takes the keyboard until you click into the reply box, and the buttons stay disabled for the first moment after it opens, so a stray click can't approve anything. See [answer-from-card.md](answer-from-card.md).

The core writes the last line to `~/.earpiece/card.json`, which the app watches. That way lines spoken by a background worker (when the app wasn't the hub) show up as well.

## API keys

An app started from Finder or at login doesn't see variables exported in `~/.zshrc`. Paste keys in **API Keys**, which saves them to `~/.earpiece/.env` (readable only by you), or write that file yourself:

```bash
SMALLEST_API_KEY=...
OPENAI_API_KEY=...
```

To keep them somewhere else, click **Choose…** under "Use an existing .env file", or run `earpiece env /path/to/.env`. Environment variables win over that file, and that file wins over keys saved in the app; the page warns you when a saved key is not the one being used. It only records the path and lists which keys it found; your hooks are not touched. With no keys, Earpiece uses the macOS voice and the first sentence of each message.

## How it works

The app listens on a Unix socket, `~/.earpiece/hub.sock` (readable only by you). Each hook runs the `earpiece-hook` shell script, which posts the event to the socket with `curl` and returns in a few milliseconds. The app summarises and speaks it. When the app isn't running, the script runs the bundled Earpiece core with the app's own runtime (`ELECTRON_RUN_AS_NODE=1`), so pings keep working. A hook never fails your agent: the script always exits 0.

`earpiece serve` runs the same hub from a terminal, and `earpiece install --hub` points hooks at the same script. That's useful on a machine without the app. Only one hub runs at a time. If `earpiece serve` is already running, the app shows a warning and hooks keep going through the running hub.

`npm run bench` in `app/` compares hook latency through the socket with a cold Node start.

## Build it yourself

```bash
cd app
npm install
npm start            # run from source
npm run dist         # universal DMG and zip in app/dist
npm run dist:arm64   # Apple silicon only, faster
```

Releases are built on the maintainer's Mac with `scripts/release-mac.sh` (it bundles Earpiece Pro, which is not in this repo), then published with `gh release create`.

## Updates

Earpiece checks GitHub for a newer release a few seconds after it starts and every six hours after that, or when you click **Check for updates** under General. When there is one, the notch says so once ("Earpiece 0.5.0 is ready. Click to update."), and a banner appears at the top of Overview and under General → About. Click the line in the notch, or **Update** in the banner, and Earpiece downloads the new zip, checks its size and SHA-256 against the release, unpacks it, checks that it is Earpiece at the expected version with an intact signature, then quits, puts the new copy where the old one was and opens it. Your settings, keys and hooks stay where they are. If anything fails, the old copy is put back and opened.

The banner offers **Download** instead (the disk image, to drag to Applications yourself) when Earpiece can't replace itself: it is running from the disk image or from a temporary copy macOS made because it was never moved to Applications, its folder isn't writable, or the release has no checksum. Drafts and pre-releases are ignored.

Because the app is not Developer ID signed, macOS may ask again for permissions you gave the old copy, such as Automation.

## Quitting

Quit (menu bar → Quit, or ⌘Q) turns Earpiece off. The line that is playing stops, the queue and its
background workers are cleared, and `~/.earpiece/app-closed.json` is written. While it exists, agent
hooks still update the session list, so Overview is right when you come back, but nothing is spoken
and nothing is sent for a summary (the log says `skipped: app_closed`). Opening the app removes it;
so does `earpiece on`. `earpiece status` shows `appClosed: true` while it's in place.
