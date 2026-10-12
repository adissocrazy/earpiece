// Hermes Agent adapter. Installs a small trusted gateway hook under $HERMES_HOME/hooks.
// Hermes hook events arrive as { hook_event_name, session_id, cwd, response, extra }.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backup } from "./install-util.mjs";

const home = () => process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
const hookDir = () => path.join(home(), "hooks", "earpiece");
const manifest = () => path.join(hookDir(), "HOOK.yaml");
const handler = () => path.join(hookDir(), "handler.py");

const MANIFEST = `name: earpiece\ndescription: Send Hermes Agent lifecycle events to Earpiece\nevents:\n  - agent: start\n  - agent: step\n  - agent: end\n  - session: end\n`;

function handlerSource(node, bin) {
  const command = JSON.stringify([node, bin, "emit"]);
  return `"""Bridge Hermes Agent lifecycle events to Earpiece."""\nimport json\nimport subprocess\n\nEARPIECE = ${command}\n\ndef _send(event):\n    try:\n        subprocess.Popen(\n            EARPIECE,\n            stdin=subprocess.PIPE,\n            stdout=subprocess.DEVNULL,\n            stderr=subprocess.DEVNULL,\n            text=True,\n        ).communicate(json.dumps(event), timeout=2)\n    except Exception:\n        # Notifications must never affect the Hermes turn.\n        pass\n\ndef handle(event_type: str, context: dict):\n    mapping = {\n        "agent:start": "turn_start",\n        "agent:step": "activity",\n        "agent:end": "turn_end",\n        "session:end": "session_end",\n    }\n    kind = mapping.get(event_type)\n    if not kind:\n        return\n    event = {\n        "agent": "hermes",\n        "type": kind,\n        "session": context.get("session_id") or context.get("session_key") or "hermes",\n        "cwd": context.get("cwd"),\n    }\n    if kind == "turn_end":\n        event["text"] = context.get("response") or context.get("message") or ""\n        event["durationMs"] = context.get("duration_ms") or context.get("durationMs")\n    elif kind == "activity":\n        tools = context.get("tool_names") or []\n        event["tool"] = ", ".join(str(t) for t in tools) or "tool"\n    _send(event)\n`;
}

export function hermesEvent(eventType, context = {}) {
  const type = {
    "agent:start": "turn_start",
    "agent:step": "activity",
    "agent:end": "turn_end",
    "session:end": "session_end",
  }[eventType];
  if (!type) return [];
  const event = {
    agent: "hermes",
    type,
    session: context.session_id || context.session_key || "hermes",
    cwd: context.cwd,
  };
  if (type === "turn_end") {
    event.text = context.response || context.message || "";
    if (context.duration_ms != null) event.durationMs = context.duration_ms;
  }
  if (type === "activity") event.tool = (context.tool_names || []).join(", ") || "tool";
  return [event];
}

export default {
  id: "hermes",
  name: "Hermes Agent",
  toEvents(payload) {
    return hermesEvent(payload?.hook_event_name || payload?.event, payload);
  },
  configFile: manifest,
  isInstalled() {
    return fs.existsSync(manifest()) && fs.existsSync(handler());
  },
  install({ node, bin, uninstall = false }) {
    const dir = hookDir();
    if (uninstall) {
      if (!fs.existsSync(manifest()) && !fs.existsSync(handler())) return [];
      const backups = [manifest(), handler()].filter((f) => fs.existsSync(f)).map(backup);
      fs.rmSync(dir, { recursive: true, force: true });
      return [`✓ Hermes Agent Earpiece hook removed from ${dir}${backups.length ? ` (backup: ${backups.map((f) => path.basename(f)).join(", ")})` : ""}`];
    }
    fs.mkdirSync(dir, { recursive: true });
    const backups = [];
    for (const [file, content] of [[manifest(), MANIFEST], [handler(), handlerSource(node, bin)]]) {
      if (fs.existsSync(file) && fs.readFileSync(file, "utf8") !== content) backups.push(backup(file));
      fs.writeFileSync(file, content, { mode: 0o700 });
    }
    return [
      `✓ Hermes Agent Earpiece hook installed at ${dir}${backups.length ? ` (backup: ${backups.map((f) => path.basename(f)).join(", ")})` : ""}`,
      "  Restart the Hermes gateway to load the hook.",
    ];
  },
};
