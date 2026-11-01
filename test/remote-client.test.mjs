import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { tempHome } from "./helpers.mjs";

const home = tempHome();
const { backoffMs, createRemoteClient, parseSse } = await import("../src/remote/client.mjs");
const { P } = await import("../src/paths.mjs");

function sseResponse(chunks, status = 200) {
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "Content-Type": "text/event-stream" } });
}

test("parseSse handles multi-line data, heartbeats, bye and a split chunk", () => {
  const split = parseSse("id: c_000000000001\nevent: remote\ndata: {\"frame\":");
  assert.equal(split.events.length, 0);
  const rest = parseSse(split.rest + "\"event\"}\n\n: hb\n\nid: c_000000000002\nevent: bye\ndata: {\"resume\":\"c_000000000001\"}\n\n");
  assert.equal(rest.events.length, 2);
  assert.equal(rest.events[0].id, "c_000000000001");
  assert.equal(JSON.parse(rest.events[0].data).frame, "event");
  assert.equal(rest.events[1].event, "bye");
  const multi = parseSse("data: one\ndata: two\n\n");
  assert.equal(multi.events[0].data, "one\ntwo");
});

test("backoff stays inside the cap", () => {
  assert.equal(backoffMs(0, 0), 0);
  assert.equal(backoffMs(0, 1), 1000);
  assert.equal(backoffMs(3, 1), 8000);
  assert.equal(backoffMs(20, 1), 60_000);
  assert.equal(backoffMs(0, 1, 5), 5000);
  assert.ok(backoffMs(2, 0.25) <= 4000);
});

test("SSE resume sends Last-Event-ID, bye reconnects, cursor is written 0600", async () => {
  const frames = [];
  const calls = [];
  let n = 0;
  const fetch = async (url, opts) => {
    calls.push({ url, headers: opts.headers });
    n++;
    if (n === 1) return sseResponse(["id: c_000000000003\nevent: remote\ndata: {\"frame\":\"event\",\"event_id\":\"e1\"}\n\n", "event: bye\ndata: {\"resume\":\"c_000000000003\"}\n\n"]);
    if (n === 2) return sseResponse(["id: c_000000000004\nevent: remote\ndata: {\"frame\":\"agent_revoked\",\"agent_id\":\"agt\"}\n\n"]);
    return sseResponse([]);
  };
  const client = createRemoteClient({
    fetch,
    token: () => "user-jwt",
    relayUrl: "https://relay.test/v1",
    onFrame: (f) => frames.push(f),
    sleep: () => Promise.resolve(),
  });
  client.start();
  await new Promise((r) => setTimeout(r, 30));
  await client.stop();
  assert.equal(frames[0].frame, "event");
  assert.equal(frames[1].frame, "agent_revoked");
  assert.equal(calls[1].headers["Last-Event-ID"], "c_000000000003");
  const st = JSON.parse(fs.readFileSync(P.remoteState, "utf8"));
  assert.equal(st.cursor, "c_000000000004");
  assert.equal((fs.statSync(P.remoteState).mode & 0o777).toString(8), "600");
  assert.equal(path.dirname(P.remoteState), path.join(home, "remote"));
});

test("three SSE failures fall back to long-poll", async () => {
  const calls = [];
  let n = 0;
  const fetch = async (url) => {
    calls.push(url);
    n++;
    if (n < 4) return new Response("nope", { status: 502 });
    return new Response(JSON.stringify({ frames: [{ id: "c_000000000009", data: { frame: "event", event_id: "e" } }], next_cursor: "c_000000000009" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const got = [];
  const client = createRemoteClient({
    fetch,
    token: () => "user-jwt",
    relayUrl: "https://relay.test/v1",
    onFrame: (f) => got.push(f),
    sleep: () => Promise.resolve(),
  });
  client.start();
  await new Promise((r) => setTimeout(r, 40));
  await client.stop();
  assert.ok(calls.slice(0, 3).every((u) => u.includes("/device/stream")));
  assert.ok(calls.some((u) => u.includes("/device/events")));
  assert.equal(got[0].frame, "event");
});

test("402 stops the client and surfaces plan_lapsed, and nothing throws", async () => {
  const got = [];
  const fetch = async () => new Response(JSON.stringify({ error: { code: "pro_required", message: "Remote agents need Earpiece Pro." } }), { status: 402 });
  const client = createRemoteClient({
    fetch,
    token: () => "user-jwt",
    relayUrl: "https://relay.test/v1",
    onFrame: (f) => {
      got.push(f);
      throw new Error("listener blew up");
    },
    sleep: () => Promise.resolve(),
  });
  client.start();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(got[0].frame, "plan_lapsed");
  assert.equal(client.state().planLapsed, true);
  await client.stop();
  const reply = await client.reply({ question_id: "q" });
  assert.equal(reply.ok, false);
});
