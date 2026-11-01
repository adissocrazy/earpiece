# Remote agents

Cloud agents (Grok Bot, and later Dots, OpenClaw, Hermes) show up in the notch the same way a local agent does. The Mac only makes outbound HTTPS calls. `hub.sock` stays on the machine, and nothing about local sessions is uploaded.

Remote agents are an Earpiece Pro feature. The relay checks the plan; the open-source app can show the Settings screen, but a Free account gets no pairing and the CLI exits 3.

## What leaves your Mac

Only what you explicitly send for a remote agent:

- Device registration: a name you can edit, the platform, and the app version.
- Acks and the stream cursor.
- Pairing approvals (the scopes you ticked, the display name).
- Your answers: the option key and label, or text you typed.

Not sent: local sessions, spoken lines, project names, paths, or code. The relay holds remote events and your replies for at most 24 hours.

## Turn it on

1. Sign in and upgrade under **Settings → Remote agents** (or `earpiece remote` — device commands exit with code 3 until the account is Pro).
2. **Pair an agent**, choose Grok Bot, and give Avery the code: "Pair with Earpiece, code K7QM-4XPD."
3. **Allow** (Deny is the default). The first successful pairing turns `remote.enabled` on.
4. **Send test**. A done line from that agent should show the cloud badge.

`config.remote`:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | when false, and no pairing is in progress, the Mac makes zero relay calls |
| `summarize` | `"when_no_line"` | `"never"` speaks a fixed phrase instead of summarising text that arrived without a `line` |
| `relayUrl` | `null` | override the relay. `EARPIECE_RELAY_URL` wins (tests and staging) |

Until `api.earpiece.dev` exists, the client calls `https://xqlcwdmgikqbicwvgfbj.supabase.co/functions/v1/relay/v1`.

## Agent connector

`connectors/earpiece-remote.mjs` is a zero-dependency Node program. Avery pairs with:

```bash
EARPIECE_RELAY_URL=… node connectors/earpiece-remote.mjs pair --code K7QM-4XPD --kind grokbot --name Avery
```

The token is written to `$EARPIECE_REMOTE_STATE` (mode 0600) and is not printed. Then:

```bash
node connectors/earpiece-remote.mjs emit --session callprep --status done --title "Call prep" --line "Tomorrow's three calls are prepped."
node connectors/earpiece-remote.mjs replies --wait 25
```

A library import (`EarpieceRemote`) redacts secrets before sending, retries 429 and 5xx with the same idempotency key, and keeps a local outbox for 24 hours. A reply authorizes only that `question_id`. The agent still confirms anything irreversible.

`earpiece remote emit` and `earpiece remote replies` are the same calls for scripts. They need an agent token (`EARPIECE_AGENT_TOKEN` or `--token`), not a Pro session.

## Testing

```bash
npm test
npm run check
```

Unit tests inject `fetch` and use `tempHome()`. They cover the frame schema, the sanitizer (including `test/fixtures/remote-injection.txt`), the SSE client, the bridge (quiet hours, backlog, asks), the CLI exit codes, and the connector against a local HTTP server.

Relay checks need the Supabase CLI: apply `supabase/migrations/20261019000000_remote_agents.sql`, serve `supabase/functions/relay` with `verify_jwt = false`, then pair a fake agent and long-poll `GET /v1/device/events`. A Free account receives `402 pro_required` on writes. Another user's ids return `404`.

Manual pass, one Mac plus the CLI as a second device:

1. Pair Avery. Deny once (no token), then Allow.
2. Emit `done`. The notch shows the cloud badge and speaks "Avery, Call prep. …". During quiet hours the card still shows, tagged Quiet hours, and nothing is spoken.
3. Emit a 3-option `needs_you`. Press `1` and wait out the 2 second undo. `earpiece remote replies --wait 25` prints the option key. Press Esc during the 2 seconds and no reply is stored.
4. Revoke. The agent's next call is `401`.
5. A Free account sees the upgrade prompt, `earpiece remote status` exits 3, and a local `earpiece emit` still works.
