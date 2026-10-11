// OpenClaw adapter. Installs a local plugin using OpenClaw's typed lifecycle hooks.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backup } from "./install-util.mjs";

const pluginDir = () => path.join(process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw"), "extensions", "earpiece");
const packageFile = () => path.join(pluginDir(), "package.json");
const manifestFile = () => path.join(pluginDir(), "openclaw.plugin.json");
const indexFile = () => path.join(pluginDir(), "index.mjs");

export function lastAssistantText(messages) {
  for (const message of [...(Array.isArray(messages) ? messages : [])].reverse()) {
    if (message?.role !== "assistant") continue;
    const content = message.content;
    const text = Array.isArray(content)
      ? content.filter((part) => part?.type === "text").map((part) => part.text).join("\n")
      : typeof content === "string" ? content : message.text || "";
    if (String(text).trim()) return String(text).trim();
  }
  return "";
}

export function openclawEvents(event = {}, ctx = {}) {
  const session = ctx.sessionKey || event.sessionKey || event.session_id || event.runId || "openclaw";
  const cwd = ctx.cwd || event.cwd;
  if (event.hook_event_name === "session_start" || event.type === "session_start")
    return [{ agent: "openclaw", type: "turn_start", session, cwd }];
  if (event.hook_event_name === "session_end" || event.type === "session_end")
    return [{ agent: "openclaw", type: "session_end", session, cwd }];
  if (event.hook_event_name === "agent_end" || event.type === "agent_end") {
    const text = lastAssistantText(event.messages) || event.lastAssistant || event.response || event.error || "";
    return [{ agent: "openclaw", type: event.success === false || event.error ? "error" : "turn_end", session, cwd, text, ...(event.durationMs != null ? { durationMs: event.durationMs } : {}) }];
  }
  return [];
}

function pluginSource(node, bin) {
  const command = JSON.stringify([node, bin, "emit"]);
  return `import { spawn } from "node:child_process";\n\nconst EARPIECE = ${command};\n\nfunction emit(event) {\n  const child = spawn(EARPIECE[0], EARPIECE.slice(1), {\n    detached: true,\n    stdio: ["pipe", "ignore", "ignore"],\n    env: process.env,\n  });\n  child.stdin.end(JSON.stringify(event));\n  child.unref();\n}\n\nfunction textOf(messages) {\n  for (const message of [...(Array.isArray(messages) ? messages : [])].reverse()) {\n    if (message?.role !== "assistant") continue;\n    const content = message.content;\n    const text = Array.isArray(content)\n      ? content.filter((part) => part?.type === "text").map((part) => part.text).join("\\n")\n      : typeof content === "string" ? content : message.text || "";\n    if (String(text).trim()) return String(text).trim();\n  }\n  return "";\n}\n\nexport default {\n  id: "earpiece",\n  name: "Earpiece",\n  description: "Send OpenClaw lifecycle events to Earpiece.",\n  activation: { onStartup: true },\n  configSchema: { type: "object", additionalProperties: false },\n  register(api) {\n    api.on("agent_end", (event, ctx) => {\n      const text = textOf(event.messages) || event.lastAssistant || event.response || event.error || "";\n      emit({\n        agent: "openclaw",\n        type: event.success === false || event.error ? "error" : "turn_end",\n        session: ctx.sessionKey || event.runId || "openclaw",\n        text,\n        cwd: ctx.cwd,\n        ...(event.durationMs != null ? { durationMs: event.durationMs } : {}),\n      });\n    });\n    api.on("session_start", (event, ctx) => {\n      emit({ agent: "openclaw", type: "turn_start", session: ctx.sessionKey || event.sessionKey || "openclaw", cwd: ctx.cwd });\n    });\n    api.on("session_end", (event, ctx) => {\n      emit({ agent: "openclaw", type: "session_end", session: ctx.sessionKey || event.sessionKey || "openclaw", cwd: ctx.cwd });\n    });\n  },\n};\n`;
}

const PACKAGE = JSON.stringify({ name: "earpiece-openclaw", private: true, type: "module", openclaw: { extensions: ["./index.mjs"] } }, null, 2) + "\n";
const MANIFEST = JSON.stringify({ id: "earpiece", name: "Earpiece", description: "Send OpenClaw lifecycle events to Earpiece." }, null, 2) + "\n";

export default {
  id: "openclaw",
  name: "OpenClaw",
  toEvents(payload) {
    return openclawEvents(payload, payload?.context || {});
  },
  configFile: pluginDir,
  isInstalled() {
    return fs.existsSync(packageFile()) && fs.existsSync(manifestFile()) && fs.existsSync(indexFile());
  },
  install({ node, bin, uninstall = false }) {
    const dir = pluginDir();
    if (uninstall) {
      if (!this.isInstalled()) return [];
      for (const file of [packageFile(), manifestFile(), indexFile()]) if (fs.existsSync(file)) backup(file);
      fs.rmSync(dir, { recursive: true, force: true });
      return [`✓ OpenClaw Earpiece plugin removed from ${dir}`];
    }
    fs.mkdirSync(dir, { recursive: true });
    const files = [[packageFile(), PACKAGE], [manifestFile(), MANIFEST], [indexFile(), pluginSource(node, bin)]];
    const backups = [];
    for (const [file, content] of files) {
      if (fs.existsSync(file) && fs.readFileSync(file, "utf8") !== content) backups.push(backup(file));
      fs.writeFileSync(file, content, { mode: 0o700 });
    }
    const installed = spawnSync("openclaw", ["plugins", "install", "--link", dir, "--force"], { stdio: "ignore" });
    const enabled = installed.status === 0 ? spawnSync("openclaw", ["plugins", "enable", "earpiece"], { stdio: "ignore" }) : null;
    const suffix = backups.length ? ` (backup: ${backups.map((f) => path.basename(f)).join(", ")})` : "";
    if (installed.status === 0 && enabled?.status === 0)
      return [`✓ OpenClaw Earpiece plugin installed and enabled at ${dir}${suffix}`, "  Run `openclaw plugins reload` if the Gateway is already running."];
    return [`✓ OpenClaw Earpiece plugin written to ${dir}${suffix}`, "  Run: openclaw plugins install --link " + dir + " --force && openclaw plugins enable earpiece"];
  },
};
