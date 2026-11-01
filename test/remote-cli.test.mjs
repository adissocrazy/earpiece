import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tempHome } from "./helpers.mjs";

const home = tempHome();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { buildEmitBody } = await import("../src/cli/remote.mjs");
const { idempotencyKey } = await import("../src/remote/protocol.mjs");
const { shouldConnect } = await import("../src/remote/runtime.mjs");

const envOf = (extra = {}) => ({ ...process.env, EARPIECE_HOME: home, EARPIECE_DRY_RUN: "1", EARPIECE_FOREGROUND: "1", ...extra });
const earpiece = (args, extra = {}) =>
  spawnSync(process.execPath, [path.join(ROOT, "bin/earpiece.mjs"), ...args], { env: envOf(extra), encoding: "utf8" });
// spawnSync would block the mock server in this process. The emit test has to stay async.
const earpieceAsync = (args, extra = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "bin/earpiece.mjs"), ...args], { env: envOf(extra) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

test("help lists remote commands", () => {
  const r = earpiece(["help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /earpiece remote status/);
  assert.match(r.stdout, /earpiece remote emit/);
});

test("device commands exit 3 when the account is not Pro, and make no relay call", () => {
  const r = earpiece(["remote", "status"]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /Remote agents need Earpiece Pro/);
  assert.equal(shouldConnect({ plan: "free", enabled: true, paired: 3 }), false);
  assert.equal(shouldConnect({ plan: "pro", enabled: true, paired: 0 }), false);
  assert.equal(shouldConnect({ plan: "pro", enabled: false, paired: 2, pairingUntil: Date.now() + 1000 }), true);
  assert.equal(shouldConnect({ plan: "pro", enabled: true, paired: 1 }), true);
});

test("emit is rejected for a remote.* agent id on the local command", () => {
  const r = earpiece(["emit", "--agent", "remote.grokbot", "--type", "info", "--line", "nope"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /reserved agent id/);
});

test("remote emit posts the body and the default idempotency key", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen.push({ url: req.url, key: req.headers["idempotency-key"], body: JSON.parse(b || "{}"), auth: req.headers.authorization });
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ event_id: "evt_test", duplicate: false }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const r = await earpieceAsync(
      ["remote", "emit", "--session", "callprep", "--status", "done", "--title", "Call prep", "--line", "Ready.", "--json"],
      { EARPIECE_RELAY_URL: `http://127.0.0.1:${port}/v1`, EARPIECE_AGENT_TOKEN: "epa_test_abc123456789" },
    );
    assert.equal(r.status, 0, r.stderr);
    const body = buildEmitBody({ session: "callprep", status: "done", title: "Call prep", line: "Ready." }, []);
    assert.equal(seen[0].key, idempotencyKey(body));
    assert.equal(seen[0].body.session_id, "callprep");
    assert.equal(seen[0].body.status, "done");
    assert.match(seen[0].auth, /^Bearer epa_test_/);
    const again = await earpieceAsync(
      ["remote", "emit", "--session", "callprep", "--status", "needs_you", "--prompt", "Go?", "--option", "yes=Yes", "--option", "no=No", "--allow-text", "--idempotency-key", "fixed-key"],
      { EARPIECE_RELAY_URL: `http://127.0.0.1:${port}/v1`, EARPIECE_AGENT_TOKEN: "epa_test_abc123456789" },
    );
    assert.equal(again.status, 0, again.stderr);
    assert.equal(seen[1].key, "fixed-key");
    assert.equal(seen[1].body.question.options[1].key, "no");
    assert.equal(seen[1].body.question.allow_text, true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("remote on writes the toggle for a Pro account", () => {
  fs.writeFileSync(path.join(home, "account.json"), JSON.stringify({ plan: "pro", access_token: "user-jwt", expires_at: Math.floor(Date.now() / 1000) + 3600 }));
  const r = earpiece(["remote", "on", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).enabled, true);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(cfg.remote.enabled, true);
  fs.rmSync(path.join(home, "account.json"), { force: true });
  void os;
});
