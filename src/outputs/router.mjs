// Route completed Earpiece updates to configured external destinations.
// Hermes is the preferred transport because it already owns platform credentials.
import { spawn } from "node:child_process";
import { config } from "../config.mjs";
import { log } from "../util.mjs";

function matches(route, event) {
  if (route?.enabled === false) return false;
  const agents = route?.agents;
  const types = route?.types;
  return (!Array.isArray(agents) || !agents.length || agents.includes("*") || agents.includes(event.agent)) &&
    (!Array.isArray(types) || !types.length || types.includes("*") || types.includes(event.type));
}

function hermesSend(target, text, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const child = spawn("hermes", ["send", "--to", target, "--quiet"], { stdio: ["pipe", "ignore", "pipe"], env: process.env });
    let error = "";
    child.stderr.on("data", (chunk) => (error += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, error: "hermes send timed out" });
    }, timeoutMs);
    child.once("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String(e.message || e) });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, error: error.trim() || `hermes send exited ${code}` });
    });
    child.stdin.end(text);
  });
}

async function webhookSend(url, payload, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal });
    return res.ok ? { ok: true } : { ok: false, error: `webhook returned HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: String(e.name === "AbortError" ? "webhook timed out" : e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

export async function deliverRoutes(update, cfg = config(), deps = {}) {
  const routes = Array.isArray(cfg.remote?.routes) ? cfg.remote.routes : [];
  const selected = routes.filter((route) => matches(route, update.event));
  const results = [];
  for (const route of selected) {
    const targets = Array.isArray(route.targets) ? route.targets : [];
    for (const target of targets) {
      let result;
      if (typeof target === "string" && target.startsWith("hermes:")) {
        result = deps.hermesSend ? await deps.hermesSend(target.slice("hermes:".length), update.text) : await hermesSend(target.slice("hermes:".length), update.text);
      } else if (typeof target === "string" && target.startsWith("webhook:")) {
        result = deps.webhookSend ? await deps.webhookSend(target.slice("webhook:".length), update) : await webhookSend(target.slice("webhook:".length), update);
      } else {
        result = { ok: false, error: `unsupported route target ${JSON.stringify(target)}` };
      }
      const entry = { route: route.name || "unnamed", target, ...result };
      results.push(entry);
      if (!result.ok) log({ error: "route_delivery_failed", ...entry, agent: update.event.agent, type: update.event.type });
    }
  }
  return results;
}

export { matches as routeMatches, hermesSend, webhookSend };
