# Configuration

`~/.earpiece/config.json` (or `$EARPIECE_HOME/config.json`). Every key is optional. `earpiece install`, `earpiece voice` and `earpiece lang` edit it for you.

| Key | Default | Meaning |
| --- | --- | --- |
| `envFile` | `null` | a `.env` file with API keys; environment variables win |
| `ttsProviders` | `["smallest","openai","say"]` | engine order |
| `smallest.voice` | `"meher"` | Smallest voice id |
| `smallest.model` | `"lightning_v3.1_pro"` | `lightning_v3.1_pro` or `lightning_v3.1` |
| `smallest.speed` | `1.0` | speaking rate |
| `smallest.sampleRate` | `24000` | Hz |
| `smallestTimeoutMs` | `8000` | |
| `speakLanguage` | `"en"` | `en`, `hinglish`, `hi`, `ta`, `mr`, `es`, … |
| `summaryProvider` | `"openai"` | `openai` or `smallest` (falls back to OpenAI) |
| `summaryModel` | `"gpt-4o-mini"` | |
| `summaryTimeoutMs` | `6000` | |
| `ttsModel` | `"gpt-4o-mini-tts"` | OpenAI TTS model |
| `voice` | `"nova"` | OpenAI voice |
| `voiceInstructions` | calm, brief | OpenAI TTS style prompt |
| `ttsTimeoutMs` | `15000` | |
| `sayVoice` | `"Samantha"` | macOS system voice |
| `minTurnSeconds` | `30` | turns and `earpiece run` commands shorter than this stay silent |
| `maxChars` | `200` | longer lines are cut to their first sentence |
| `quietHours` | `{"start":"23:00","end":"08:00","allow":["needs_input"]}` | nightly window. Only kinds in `allow` are spoken: `[]` is completely silent, `["needs_input","error"]` also lets failures through. `null` turns quiet hours off. Set it with `earpiece quiet-hours` |
| `chimes` | `true` | macOS system sound before each line |
| `replyFromNotch` | `true` | a Reply on every finished line in the notch (Claude Code: non-blocking asyncRewake Stop hook, 30 min; Codex: held 60 s, only while you're away from its terminal). Needs the Mac app and the card on. General switch. See [answer-from-card.md](answer-from-card.md#reply-from-the-notch) |
| `answerFromCard` | `false` | let the floating card approve, deny or reply to Claude Code and Codex. Installs blocking `PermissionRequest` and `Stop` hooks; needs the Mac app and the card on. Set it with `earpiece answers on\|off` or the General switch. See [answer-from-card.md](answer-from-card.md) |
| `announceAgent` | `false` | prefix lines with the agent name |
| `agents` | `{}` | per-agent overrides, below |
| `codexChain` | `null` | written by `earpiece install --chain`; your original Codex notify command. Earpiece runs it after each Codex turn with `EARPIECE_FORWARDED=1` set, so a wrapper that calls Earpiece back can't loop. |

## Per-agent overrides

Keys under `agents.<adapter id>`:

| Key | Meaning |
| --- | --- |
| `enabled` | `false` keeps tracking the agent in `earpiece agents` but never speaks for it |
| `label` | spoken and displayed name; setting it also turns on the name prefix for that agent |
| `voice`, `model` | Smallest voice and model (`earpiece voice <id> --agent <agent>` sets both) |
| `openaiVoice` | OpenAI voice for this agent |
| `sayVoice` | system voice for this agent |
| `minTurnSeconds` | per-agent threshold |

Adapter ids: `claude-code`, `codex`, `run` (for `earpiece run`), and whatever you pass to `earpiece emit --agent`.

## Files in the state directory

| Path | What it is |
| --- | --- |
| `config.json` | the settings above |
| `mode.json` | `on`, `quiet` or `off`, and when it ends |
| `sessions/` | one JSON file per agent session, shown by `earpiece agents` |
| `log.jsonl` | every spoken or skipped line, warnings and errors; secrets are redacted |
| `last-spoken.json` | the last line, for the 60-second duplicate check |
| `flushed.json` | when `earpiece stop` last ran; lines queued before then are dropped |
| `speak.lock/` | held while a line is playing; `earpiece stop` removes it |
| `tmp/` | worker jobs, audio files, and `seen-codex-*` markers that make each Codex turn speak once |

Skip reasons you may see in `log.jsonl` include:

- `short_turn`, `duplicate`, `mode_off`, `mode_quiet`, `quiet_hours` and `agent_disabled`
- `stale`: the line waited more than 2 minutes
- `flushed`: the line was cleared by `earpiece stop`
- `busy`: the line never got the speaker
- `duplicate_turn`: the same Codex turn was delivered twice
- `forwarded_echo`: a chained notify called Earpiece back
- `resolved`: a permission or idle alert you had already answered in the terminal

## Secrets

Agent messages can contain tokens, keys or connection strings. Earpiece strips anything secret-shaped before a line is spoken, logged, or sent to an LLM for a summary: provider keys (`sk-…`, `ghp_…`, `xoxb-…`, `AKIA…`, `AIza…`), JWTs, private key blocks, passwords in URLs, `NAME=value` pairs where the name contains key, secret, token or password, and any 32+ character string mixing letters and digits. The pattern list is in `src/util.mjs`; open an issue if a format slips through.
