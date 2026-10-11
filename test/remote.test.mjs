import assert from "node:assert/strict";
import test from "node:test";
import { routeMatches, deliverRoutes } from "../src/outputs/router.mjs";

test("remote route filters by agent and event type", () => {
  const route = { agents: ["hermes", "openclaw"], types: ["turn_end", "error"] };
  assert.equal(routeMatches(route, { agent: "hermes", type: "turn_end" }), true);
  assert.equal(routeMatches(route, { agent: "codex", type: "turn_end" }), false);
  assert.equal(routeMatches(route, { agent: "hermes", type: "turn_start" }), false);
});

test("routes use Hermes targets and webhooks without coupling credentials to Earpiece", async () => {
  const calls = [];
  const results = await deliverRoutes(
    { event: { agent: "openclaw", type: "error", session: "s1" }, text: "Build failed.", project: "api" },
    { remote: { routes: [{ name: "ops", agents: ["openclaw"], types: ["error"], targets: ["hermes:whatsapp:+1555", "webhook:https://example.test/events"] }] } },
    {
      hermesSend: async (target, text) => { calls.push(["hermes", target, text]); return { ok: true }; },
      webhookSend: async (url, payload) => { calls.push(["webhook", url, payload.text]); return { ok: true }; },
    },
  );
  assert.deepEqual(calls, [
    ["hermes", "whatsapp:+1555", "Build failed."],
    ["webhook", "https://example.test/events", "Build failed."],
  ]);
  assert.deepEqual(results.map((r) => r.ok), [true, true]);
});

test("disabled and non-matching routes do not deliver", async () => {
  let called = false;
  const results = await deliverRoutes(
    { event: { agent: "hermes", type: "turn_start" }, text: "Started." },
    { remote: { routes: [{ name: "off", enabled: false, targets: ["hermes:whatsapp:+1"] }, { name: "errors", types: ["error"], targets: ["hermes:whatsapp:+1"] }] } },
    { hermesSend: async () => { called = true; return { ok: true }; } },
  );
  assert.equal(called, false);
  assert.deepEqual(results, []);
});
