// Agent adapter registry. An adapter turns one agent's native hook/notify payload into hub events.
//
//   {
//     id, name,
//     toEvents(payload) -> Event[]        sync and cheap: runs inside the agent's hook process
//     enrich?(event)    -> Promise<Event> slow work (reading transcripts), runs in the background worker
//     install?({ node, bin, uninstall, chain }) -> string[]   edit the agent's config, return messages
//     isInstalled?()    -> boolean
//     forward?(raw)                         pass the raw payload on to a chained command
//   }
//
// Agents without an adapter can still talk to the hub with `earpiece emit --agent <id> …`.
// See docs/adapters.md.
import claudeCode from "./claude-code.mjs";
import claudeDesktop from "./claude-desktop.mjs";
import codex from "./codex.mjs";
import hermes from "./hermes.mjs";
import openclaw from "./openclaw.mjs";

const ADAPTERS = new Map();

export function registerAdapter(a) {
  if (!a?.id || typeof a.toEvents !== "function") throw new Error("adapter needs an id and toEvents()");
  ADAPTERS.set(a.id, a);
}

const titleCase = (id) => String(id).replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// Unknown ids get a pass-through adapter, so `earpiece emit --agent aider` works with no code.
export function getAdapter(id) {
  return (
    ADAPTERS.get(id) || {
      id,
      name: titleCase(id),
      generic: true,
      toEvents: (e) => [{ ...e, agent: id }],
    }
  );
}

export const listAdapters = () => [...ADAPTERS.values()];

for (const a of [claudeCode, codex, claudeDesktop, openclaw, hermes]) registerAdapter(a);
