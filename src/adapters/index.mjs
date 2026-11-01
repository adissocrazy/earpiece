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

const ADAPTERS = new Map();

export function registerAdapter(a) {
  if (!a?.id || typeof a.toEvents !== "function") throw new Error("adapter needs an id and toEvents()");
  ADAPTERS.set(a.id, a);
}

const titleCase = (id) => String(id).replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const KIND_NAME = { grokbot: "Grok Bot", dots: "Dots", openclaw: "OpenClaw", hermes: "Hermes", custom: "Remote" };

// Cloud agents share one pass-through. The paired name lives in config (`agents[hub_id].label`);
// this name is only the fallback. `remote: true` is how the UI tells them from a local agent.
function remoteAdapter(id) {
  const kind = String(id).split(".")[1] || "custom";
  return {
    id,
    name: KIND_NAME[kind] || titleCase(kind),
    remote: true,
    generic: true,
    toEvents: (e) => [{ ...e, agent: id }],
  };
}

// Unknown ids get a pass-through adapter, so `earpiece emit --agent aider` works with no code.
export function getAdapter(id) {
  if (ADAPTERS.has(id)) return ADAPTERS.get(id);
  if (String(id || "").startsWith("remote.")) return remoteAdapter(id);
  return {
    id,
    name: titleCase(id),
    generic: true,
    toEvents: (e) => [{ ...e, agent: id }],
  };
}

export const listAdapters = () => [...ADAPTERS.values()];

for (const a of [claudeCode, codex, claudeDesktop]) registerAdapter(a);
