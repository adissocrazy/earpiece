import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createCardPointer } from "../app/main/card-pointer.mjs";

const renderer = fs.readFileSync(new URL("../app/renderer/card.js", import.meta.url), "utf8");

// Run the real renderer's events and timers with a native cursor. Layout is fixed here;
// the pointer tests cover geometry, while these exercise the hover/close IPC handoff.
function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const elements = new Map();
  const callbacks = {};
  const messages = [];
  function element() {
    const listeners = new Map();
    const children = new Map();
    return {
      dataset: {}, style: { setProperty() {} }, classList: { toggle() {} },
      value: "", offsetHeight: 200, offsetWidth: 460, scrollWidth: 24,
      querySelector(selector) {
        if (!children.has(selector)) children.set(selector, element());
        return children.get(selector);
      },
      querySelectorAll: () => [],
      prepend() {}, append() {}, remove() {}, replaceChildren() {},
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      fire(type, event = {}) {
        for (const fn of listeners.get(type) || []) fn({ target: { closest: () => null }, ...event });
      },
    };
  }
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  let point = { x: 100, y: 100 };
  const pointer = createCardPointer({
    getWindow: () => ({
      isVisible: () => true,
      isDestroyed: () => false,
      getBounds: () => ({ x: 516, y: 0, width: 480, height: 560 }),
      setIgnoreMouseEvents() {},
    }),
    getCursor: () => point,
    onChange: (on) => callbacks.Pointer?.(on),
  });
  const bridge = {
    card(action, value) {
      messages.push({ action, value });
      if (action === "rect") pointer.setRect(value);
      if (action === "hover") pointer.check();
    },
  };
  for (const name of ["Card", "Geom", "Agents", "Rest", "Pointer", "Inbox", "Panel"]) bridge[`on${name}`] = (fn) => { callbacks[name] = fn; };
  // The "Needs you" tab (panel.js) has its own tests; here it only has to answer card.js.
  const panel = { calls: [], count: () => 0, busy: () => false, update() {}, close() {}, onKey() {}, setTab: (t) => panel.calls.push(["tab", t]), focus: (id) => panel.calls.push(["focus", id]) };
  vm.runInNewContext(renderer, {
    window: { earpiece: bridge, EarpieceLogos: { logo: element }, EarpiecePanel: panel, addEventListener() {} },
    document: { getElementById: get, body: element(), activeElement: null, createElement: element, addEventListener() {} },
    setTimeout, clearTimeout, requestAnimationFrame: (fn) => fn(),
  });
  callbacks.Geom({ notch: true, notchW: 204, notchH: 33 });
  callbacks.Rest(true);
  pointer.start();
  t.after(() => pointer.stop());
  return {
    get, callbacks, messages, panel,
    move(x, y) { point = { x, y }; t.mock.timers.tick(60); },
    tick: (ms) => t.mock.timers.tick(ms),
    view: () => get("card").dataset.view,
  };
}

test("agents list stays open through DOM mouseleave while moving into the panel", (t) => {
  const f = fixture(t);
  f.move(630, 15);
  f.get("card").fire("click");
  assert.equal(f.view(), "list");
  f.move(550, 180);
  f.get("card").fire("mouseleave");
  f.tick(1000);
  assert.equal(f.view(), "list");
  f.move(550, 400);
  f.tick(250);
  assert.equal(f.view(), "rest", "a real exit still closes the list");
});

test("returning before the close timer expires keeps the list open without DOM entry", (t) => {
  const f = fixture(t);
  f.move(630, 15);
  f.get("card").fire("click");
  f.move(550, 400);
  f.tick(100);
  f.move(550, 180);
  f.tick(1000);
  assert.equal(f.view(), "list");
});

test("a notification stays readable while hovered and folds after a real exit", (t) => {
  const f = fixture(t);
  f.callbacks.Card({ id: "line-1", line: "Finished the task.", state: "spoken", kind: "done" });
  assert.equal(f.view(), "peek");
  f.move(630, 100);
  f.get("card").fire("mouseleave");
  f.tick(6000);
  assert.equal(f.view(), "peek");
  f.move(630, 400);
  f.tick(6000);
  assert.equal(f.view(), "mini");
});

test("a question waits in the notch until clicked, then opens the panel on it", (t) => {
  const f = fixture(t);
  f.callbacks.Card({ id: "ask-1", line: "Run the command?", state: "ask", kind: "needs_input", ask: { id: "ask-1" } });
  f.move(630, 15);
  f.tick(1000);
  assert.equal(f.view(), "mini", "hover does not open permission prompts");
  f.get("card").fire("click");
  assert.equal(f.view(), "list");
  assert.deepEqual(f.panel.calls.at(-1), ["focus", "ask-1"]);
  assert.deepEqual(f.messages.filter((m) => m.action === "panel").map((m) => m.value), [true], "the panel takes the keyboard");
  f.move(550, 400);
  f.tick(300);
  assert.equal(f.view(), "mini", "leaving folds it back; the question still waits");
  assert.deepEqual(f.messages.filter((m) => m.action === "panel").map((m) => m.value), [true, false], "and gives the keyboard back");
});

test("opened with ⌥⌘I, the panel stays until the pointer has been on it and left", (t) => {
  const f = fixture(t);
  f.move(550, 400);
  f.callbacks.Panel({ focus: null });
  assert.equal(f.view(), "list");
  assert.deepEqual(f.panel.calls.at(-1), ["tab", "agents"], "nothing waiting: the agents");
  f.tick(2000);
  assert.equal(f.view(), "list", "the pointer was never on it");
  f.move(550, 180);
  f.move(550, 400);
  f.tick(300);
  assert.equal(f.view(), "rest");
});

test("a gone island reports no interactive area even on a notched display", (t) => {
  const f = fixture(t);
  f.callbacks.Rest(false);
  const rect = f.messages.filter((m) => m.action === "rect").at(-1).value;
  assert.equal(rect.w, 0);
  assert.equal(rect.h, 0);
});
