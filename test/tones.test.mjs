import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { tempHome } from "./helpers.mjs";

const home = tempHome({ quietHours: null, chimes: true, tones: { error: "none" } });
const { config } = await import("../src/config.mjs");
const { chime, toneFile } = await import("../src/voice/speak.mjs");

test("tones: defaults merge with user picks, unknown names map to no file", () => {
  assert.deepEqual(config().tones, { done: "Glass", needs_input: "Ping", error: "none" });
  assert.equal(toneFile("Hero"), "/System/Library/Sounds/Hero.aiff");
  assert.equal(toneFile("none"), null);
  assert.equal(toneFile("../../etc/passwd"), null);
});

test("chime: 'none', tones off, and a repeat within seconds all stay silent", async () => {
  assert.equal(await chime("error"), false);
  assert.equal(await chime("needs_input", { ...config(), chimes: false }), false);
  fs.writeFileSync(path.join(home, "last-tone.json"), JSON.stringify({ kind: "needs_input", at: Date.now() }));
  assert.equal(await chime("needs_input"), false);
});
