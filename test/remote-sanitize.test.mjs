import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { tempHome } from "./helpers.mjs";

tempHome();
const { clean, fixedLine, nameSkeleton, reservedName, speakable, spokenLine } = await import("../src/remote/sanitize.mjs");
const { redact, SECRET_PATTERNS } = await import("../src/util.mjs");

const corpus = fs.readFileSync(new URL("./fixtures/remote-injection.txt", import.meta.url), "utf8").split("\n").map((l) => l.trim()).filter(Boolean);

test("secrets, bidi, zero-width and clamps", () => {
  assert.match(redact("token epa_live_abcdefghijklmnopqrstuvwxyz"), /\[redacted\]/);
  assert.equal(redact("token epa_live_abcdefghijklmnopqrstuvwxyz").includes("epa_live_abc"), false);
  assert.equal(clean("a\u202Eb\u200Bc\u0000d").includes("\u202E"), false);
  assert.equal(clean("a\u202Eb\u200Bc\u0000d").includes("\u0000"), false);
  assert.match(speakable("see https://example.com/a and ada@x.io and 123456789"), /a link/);
  assert.match(speakable("see https://example.com/a and ada@x.io and 123456789"), /an email address/);
  assert.match(speakable("see https://example.com/a and ada@x.io and 123456789"), /a number/);
  assert.equal(speakable("https://example.com/a").includes("http"), false);
  assert.equal(speakable("Claude Code: do the thing"), "do the thing");
  assert.equal(speakable("<b>hi</b> {{x}} **no**"), "hi no");
  const long = speakable("word ".repeat(80));
  assert.ok(long.length <= 200, long.length);
  assert.equal(fixedLine({}, "Avery", "done"), "Avery is done.");
  assert.equal(fixedLine({}, "Avery", "needs_you"), "Avery needs you.");
  assert.equal(spokenLine({ name: "Avery", title: "Call prep", status: "done", body: "Ready." }), "Avery, Call prep. Ready.");
  assert.equal(spokenLine({ name: "Avery", title: "Call prep", status: "needs_you", body: "Look.", question: null }), "Avery needs you: Look.");
  assert.match(spokenLine({ name: "Avery", title: "Posts", status: "needs_you", body: "Three posts.", question: {} }), /^Avery, Posts\./);
  assert.equal(SECRET_PATTERNS.some(([re]) => re.source.includes("epa_")), true);
});

test("reserved names include homoglyphs", () => {
  for (const name of ["Claude", "Claude Code", "Codex", "Earpiece", "System", "Terminal", "macOS"]) assert.equal(reservedName(name), true, name);
  assert.equal(reservedName("Сlаude"), true, nameSkeleton("Сlаude"));
  assert.equal(reservedName("Avery"), false);
});

test("injection corpus: spoken lines start with the agent and carry no url or secret", () => {
  const speech = corpus.filter((l) => !l.startsWith("NAME:"));
  assert.ok(speech.length >= 40, `corpus has ${speech.length} speech lines`);
  for (const line of speech) {
    const said = spokenLine({ name: "Avery", title: "Call prep", status: "done", body: speakable(line) });
    assert.match(said, /^Avery, /, line);
    assert.equal(/https?:\/\//i.test(said), false, line);
    assert.equal(/epa_(?:live|test)_/i.test(said), false, line);
    assert.equal(/\bsk-[A-Za-z0-9]/.test(said), false, line);
    assert.equal(said.includes("\u202E") || said.includes("\u200B"), false, line);
  }
  const names = corpus.filter((l) => l.startsWith("NAME:")).map((l) => l.slice(5));
  assert.equal(reservedName(names[0]), true);
  assert.equal(reservedName("Avery"), false);
});
