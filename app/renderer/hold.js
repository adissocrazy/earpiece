// Every Inbox answer waits a moment before it goes, so Esc can take it back. One at a time: a new
// answer sends the one still waiting right away. Plain script (the Inbox window has no modules);
// the tests load it with node:vm.
globalThis.createHold = function createHold(ms, timers = globalThis) {
  let held = null; // { what, send, timer }
  const fire = () => {
    const h = held;
    held = null;
    if (h) h.send();
  };
  return {
    /** Hold `send` for ms. `what` describes it for the undo bar. */
    start(what, send) {
      this.flush();
      held = { what, send, timer: timers.setTimeout(fire, ms) };
    },
    /** Esc: drop the waiting answer. True if there was one. */
    cancel() {
      if (!held) return false;
      timers.clearTimeout(held.timer);
      held = null;
      return true;
    },
    /** Send now (the window is closing). */
    flush() {
      if (held) timers.clearTimeout(held.timer);
      fire();
    },
    pending: () => held?.what ?? null,
  };
};
