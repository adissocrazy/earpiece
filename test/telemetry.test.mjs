// Usage stats: what is sent, that it is linked to an account only when signed in, and that opting out sends nothing.
import assert from "node:assert/strict";
import test from "node:test";
import { createTelemetry, enabled, ENDPOINT, features, KEY } from "../app/main/telemetry.mjs";

const INFO = { version: "0.4.0", osVersion: "15.1.0", arch: "arm64", locale: "en-US", agents: ["claude-code", "codex"], features: { spoken_today: 3 } };

function setup(prefs = {}, { ok = true, fail = false, token = null } = {}) {
  const calls = [];
  const saved = [];
  const t = createTelemetry({
    getPrefs: () => prefs,
    saveInstallId: (id) => (saved.push(id), (prefs.installId = id)),
    info: () => INFO,
    accessToken: async () => token,
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      if (fail) throw new Error("offline");
      return { ok };
    },
  });
  return { t, calls, saved };
}

test("sends only the documented fields, to ping() with the publishable key", async () => {
  const { t, calls } = setup({ installId: "11111111-1111-4111-8111-111111111111" });
  assert.equal(await t.ping(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].opts.headers.apikey, KEY);
  assert.match(KEY, /^sb_publishable_/); // never a secret / service_role key
  assert.equal(calls[0].opts.headers.Authorization, undefined); // anonymous when signed out
  assert.deepEqual(JSON.parse(calls[0].opts.body).p, {
    install_id: "11111111-1111-4111-8111-111111111111",
    app_version: "0.4.0",
    macos_version: "15.1.0",
    arch: "arm64",
    locale: "en-US",
    agents: ["claude-code", "codex"],
    features: { spoken_today: 3 },
  });
});

test("signed in: the ping carries the user's token, so the server links it to the account", async () => {
  const { t, calls } = setup({ installId: "11111111-1111-4111-8111-111111111111" }, { token: "user-jwt" });
  await t.ping();
  assert.equal(calls[0].opts.headers.Authorization, "Bearer user-jwt");
});

test("features are booleans, numbers and short ids only: no free text, no key values", () => {
  const f = features({
    config: { answerFromCard: true, quietHours: { start: "23:00" }, speakLanguage: "hinglish", ttsProviders: ["smallest"], agents: { codex: { voice: "v1" }, aider: { enabled: false } } },
    prefs: { notchIcon: "updates" },
    keys: [{ name: "SMALLEST_API_KEY", set: true, source: { label: "/Users/me/.env" } }, { name: "OPENAI_API_KEY", set: false }],
    stats: { spoken: 7, skipped: 2, lastSpoke: { text: "checkout service. Refactored the cart.", engine: "smallest" } },
  });
  assert.deepEqual(f, {
    answer_from_card: true,
    show_card: true,
    notch_icon: "updates",
    quiet_hours_on: true,
    announce_agent: false,
    language: "hinglish",
    tts_first: "smallest",
    has_smallest_key: true,
    has_openai_key: false,
    per_agent_voices: 1,
    spoken_today: 7,
    skipped_today: 2,
    last_engine: "smallest",
    remote_enabled: false,
    remote_agents: 0,
    remote_has_grokbot: false,
    remote_has_dots: false,
    remote_has_openclaw: false,
    remote_has_hermes: false,
    remote_has_custom: false,
    remote_events_today: 0,
    remote_questions_today: 0,
    remote_answers_today: 0,
    remote_transport: "off",
    remote_reconnects_today: 0,
  });
  assert.equal(features({ config: { speakLanguage: "a sentence with spaces" } }).language, "en");
  assert.equal(features({}).spoken_today, 0);
});

test("makes a random install id once and reuses it", async () => {
  const { t, calls, saved } = setup({});
  await t.ping();
  await t.ping();
  assert.equal(saved.length, 1);
  assert.match(saved[0], /^[0-9a-f-]{36}$/);
  const ids = calls.map((c) => JSON.parse(c.opts.body).p.install_id);
  assert.deepEqual(ids, [saved[0], saved[0]]);
});

test("opted out: nothing is sent and no id is made", async () => {
  const { t, calls, saved } = setup({ shareStats: false });
  assert.equal(await t.ping(), false);
  assert.equal(calls.length, 0);
  assert.equal(saved.length, 0);
  assert.equal(enabled(undefined, { EARPIECE_TELEMETRY: "0" }), false);
  assert.equal(enabled(undefined, {}), true);
});

test("signed in: stats are sent even with the switch off; EARPIECE_TELEMETRY=0 still wins", async () => {
  const { t, calls } = setup({ shareStats: false, installId: "11111111-1111-4111-8111-111111111111" }, { token: "user-jwt" });
  assert.equal(await t.ping(), true);
  assert.equal(calls[0].opts.headers.Authorization, "Bearer user-jwt");
  assert.equal(enabled(false, {}, true), true);
  assert.equal(enabled(false, { EARPIECE_TELEMETRY: "0" }, true), false);
});

test("network failures and same-day repeats (409) are swallowed", async () => {
  assert.equal(await setup({}, { fail: true }).t.ping(), false);
  assert.equal(await setup({}, { ok: false }).t.ping(), false);
});
