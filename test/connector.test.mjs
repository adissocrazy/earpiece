import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SECRET_PATTERNS } from "../src/util.mjs";
import { EarpieceRemote, SECRET_PATTERNS as COPY, prepareEvent, redact } from "../connectors/earpiece-remote.mjs";

test("SECRET_PATTERNS match src/util.mjs", () => {
  const sig = (list) => list.map(([re, sub]) => [re.source, re.flags, sub]);
  assert.deepEqual(sig(COPY), sig(SECRET_PATTERNS));
  assert.equal(redact("epa_live_abcdefghijklmnopqrstuvwxyz").includes("epa_live_abc"), false);
});

test("prepareEvent redacts, truncates and defaults the idempotency key", () => {
  const { body, key } = prepareEvent({
    session_id: "s",
    status: "done",
    line: "key epa_live_abcdefghijklmnopqrstuvwxyz",
    text: "x".repeat(2005),
    title: "t",
  });
  assert.equal(body.line.includes("epa_live_abc"), false);
  assert.ok([...body.text].length <= 2000);
  assert.equal(key.length, 32);
  const again = prepareEvent({ session_id: "s", status: "done", line: body.line, text: body.text, title: "t" });
  assert.equal(again.key, key);
});

function serve(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("pair, emit, outbox retry and replies against a mock relay", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earpiece-connector-"));
  const stateFile = path.join(dir, "state.json");
  let token = null;
  const events = [];
  let failOnce = true;
  const server = await serve(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const send = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.url === "/v1/pairing/claim") return send(202, { claim_id: "clm_1", claim_secret: "cls_secret", status: "pending", expires_at: new Date(Date.now() + 60_000).toISOString() });
    if (req.url.startsWith("/v1/pairing/claims/")) return send(200, { status: "approved", agent_id: "agt_1", token: "epa_live_secretvalue123", scopes: ["events:write"], relay_url: `http://127.0.0.1:${server.address().port}/v1` });
    if (req.url === "/v1/agents/events") {
      if (failOnce) {
        failOnce = false;
        return send(502, { error: { code: "unavailable", message: "down" } });
      }
      events.push({ key: req.headers["idempotency-key"], body });
      return send(202, { event_id: "evt_1", duplicate: false });
    }
    if (req.url.startsWith("/v1/agents/replies")) {
      return send(200, { replies: [{ reply_id: "rpl_1", type: "answer", agent_question_id: "approve-posts-w43", choice: { key: "approve_all", index: 1 } }], next_cursor: "c_000000000001", has_more: false });
    }
    if (req.url === "/v1/agents/replies/ack") return send(204, {});
    if (req.url === "/v1/agents/me") return send(200, { agent_id: "agt_1", name: "Avery", owner_plan_ok: true });
    send(404, { error: { code: "not_found", message: req.url } });
  });
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  process.env.EARPIECE_RELAY_URL = base;
  try {
    const ep = await EarpieceRemote.pair({ code: "K7QM-4XPD", kind: "grokbot", name: "Avery", stateFile, relayUrl: base });
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(saved.token, "epa_live_secretvalue123");
    assert.equal((fs.statSync(stateFile).mode & 0o777).toString(8), "600");
    const emitted = await ep.emit({ session_id: "posts", status: "needs_you", line: "Need approval", question: { id: "approve-posts-w43", prompt: "Publish?", options: [{ key: "approve_all", label: "Approve all" }] } });
    assert.equal(emitted.event_id, "evt_1");
    assert.equal(events.length, 1);
    assert.equal(events[0].body.line.includes("Need approval"), true);
    const replies = await ep.replies({ wait: 0 });
    assert.equal(replies[0].choice.key, "approve_all");
    const again = await ep.waitFor("approve-posts-w43", { timeoutMs: 1000 });
    assert.equal(again.reply_id, "rpl_1");
    const me = await ep.whoami();
    assert.equal(me.owner_plan_ok, true);
    token = saved.token;
  } finally {
    delete process.env.EARPIECE_RELAY_URL;
    await new Promise((r) => server.close(r));
  }
  assert.match(token, /^epa_live_/);
});

test("a 402 is reported once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earpiece-connector-"));
  const stateFile = path.join(dir, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ relay_url: "http://127.0.0.1:9/v1", agent_id: "agt", token: "epa_live_x" }));
  const server = await serve((req, res) => {
    res.writeHead(402, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "pro_required", message: "nope" } }));
  });
  const ep = await EarpieceRemote.load(stateFile);
  ep.state.relay_url = `http://127.0.0.1:${server.address().port}/v1`;
  await assert.rejects(() => ep.emit({ session_id: "s", status: "done", line: "Hi" }), /Earpiece Pro needed/);
  await assert.rejects(() => ep.emit({ session_id: "s", status: "done", line: "Hi" }), /nope|Earpiece Pro needed|HTTP 402/);
  await new Promise((r) => server.close(r));
});
