// The notch panel's "Needs you" tab (app/renderer/panel.js) with a tiny fake DOM: keys answer the
// selected item, every answer is held 2 s so Esc can take it back, and only then is it sent.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (f) => fs.readFileSync(new URL(`../app/renderer/${f}`, import.meta.url), "utf8");

function node(tag = "div") {
  const n = {
    tagName: tag, className: "", textContent: "", hidden: false, dataset: {}, style: {}, children: [], value: "",
    classList: { add() {}, remove() {}, toggle() {}, replace() {} },
    append: (...c) => n.children.push(...c),
    prepend: (...c) => n.children.unshift(...c),
    replaceChildren: (...c) => (n.children = c),
    querySelector: () => null,
    set innerHTML(_) {},
    get offsetWidth() { return 0; },
  };
  return n;
}

function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const els = new Map();
  const sent = [];
  const events = [];
  const ctx = {
    setTimeout, clearTimeout,
    document: { getElementById: (id) => (els.has(id) ? els.get(id) : els.set(id, node()).get(id)), createElement: node },
    window: {
      earpiece: { card: async (action, value) => (sent.push({ action, value }), { ok: true }), dictate: async () => ({ ok: false }) },
      dispatchEvent: (e) => e.type !== "panel-resize" && events.push(e.type),
    },
    Event: class { constructor(type) { this.type = type; } },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read("hold.js"), ctx);
  vm.runInContext(read("panel.js"), ctx);
  const P = ctx.window.EarpiecePanel;
  const key = (k) => P.onKey({ key: k, target: null, preventDefault() {} });
  return { P, key, sent, events, els, tick: (ms) => t.mock.timers.tick(ms) };
}

const perm = { id: "p1", kind: "permission", agentId: "claude-code", agent: "Claude Code", session: "s", project: "shop", at: 1, line: "Allow Bash?", detail: "ls", canAlways: false };

test("1 allows the selected permission after 2 s; Esc in between takes it back", async (t) => {
  const f = fixture(t);
  f.P.update({ needs: [perm] });
  assert.equal(f.P.count(), 1);
  f.key("1");
  assert.equal(f.els.get("undo").hidden, false, "the undo bar shows");
  assert.ok(f.P.busy(), "an answer is held, so the panel won't fold");
  f.key("Escape");
  f.tick(3000);
  assert.deepEqual(f.sent, [], "undone: nothing sent");
  assert.deepEqual(f.events, [], "Esc undid; it didn't close the panel");
  f.key("1");
  f.tick(1999);
  assert.deepEqual(f.sent, []);
  f.tick(1);
  await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(f.sent)), [{ action: "inbox-act", value: { id: "p1", action: "permission", behavior: "allow" } }]);
});

test("Esc with nothing held closes the panel; closing sends a held answer at once", async (t) => {
  const f = fixture(t);
  f.P.update({ needs: [perm] });
  f.key("Escape");
  assert.deepEqual(f.events, ["panel-close"]);
  f.key("1");
  f.P.close();
  await Promise.resolve();
  assert.equal(f.sent.length, 1, "you picked it; folding the panel doesn't take it back");
});

test("keys go to the Agents tab only for Tab and Esc", (t) => {
  const f = fixture(t);
  f.P.update({ needs: [perm] });
  f.key("Tab");
  assert.equal(f.P.tab(), "agents");
  f.key("1");
  f.tick(3000);
  assert.deepEqual(f.sent, []);
});
