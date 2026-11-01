// `earpiece remote …`. Device commands need a Pro token. `emit` and `replies` are the agent side
// (a token that was issued at pairing) and work without the Mac app.
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { updateConfig, config } from "../config.mjs";
import { proToken } from "../pro.mjs";
import { isDry, parseFlags, readJson } from "../util.mjs";
import { P } from "../paths.mjs";
import { claimPairing, createRemoteApi, pollClaim, relayUrl, saveRemoteState } from "../remote/api.mjs";
import { idempotencyKey, validateEvent } from "../remote/protocol.mjs";
import { reservedName } from "../remote/sanitize.mjs";

export const PRO_MSG = "Remote agents need Earpiece Pro. Open Earpiece › Settings › Remote agents to upgrade.";

const needPro = () => {
  if (!proToken()) {
    console.error(PRO_MSG);
    process.exitCode = 3;
    return false;
  }
  return true;
};

function api(flags = {}) {
  return createRemoteApi({
    relayUrl: relayUrl(config()),
    token: () => proToken(),
    agentToken: flags.token || process.env.EARPIECE_AGENT_TOKEN || null,
  });
}

function optionsOf(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    let raw = null;
    if (args[i] === "--option") raw = args[++i];
    else if (String(args[i]).startsWith("--option=")) raw = args[i].slice("--option=".length);
    if (raw == null) continue;
    const eq = raw.indexOf("=");
    if (eq <= 0) continue;
    out.push({ key: raw.slice(0, eq), label: raw.slice(eq + 1) });
  }
  return out;
}

export function buildEmitBody(flags, options) {
  const question = flags.prompt
    ? {
        prompt: flags.prompt,
        options,
        allow_text: flags["allow-text"] === true,
        ...(flags["expires-in"] ? { expires_in_s: Number(flags["expires-in"]) } : {}),
      }
    : undefined;
  return {
    v: 1,
    session_id: flags.session,
    status: flags.status,
    ...(flags.title ? { title: flags.title } : {}),
    ...(flags.line ? { line: flags.line } : {}),
    ...(flags.text ? { text: flags.text } : {}),
    ...(question ? { question } : {}),
    ...(flags.link ? { link: flags.link } : {}),
  };
}

async function ensureDevice(a, name) {
  const st = readJson(P.remoteState, {}) || {};
  if (st.deviceId) return st.deviceId;
  const json = await a.registerDevice({ name: name || "CLI", platform: "cli", app_version: "0.4.2" });
  return json.device_id;
}

async function confirm(prompt, yes) {
  if (yes) return true;
  if (!input.isTTY) return false;
  const rl = readline.createInterface({ input, output });
  try {
    const ans = (await rl.question(prompt)).trim().toLowerCase();
    return ans === "y" || ans === "yes";
  } finally {
    rl.close();
  }
}

export async function remoteDoctorLines({ fetch } = {}) {
  const cfg = config();
  const account = readJson(P.account, null);
  const plan = account?.plan === "pro" ? "pro" : "free";
  const on = cfg.remote?.enabled === true;
  const st = readJson(P.remoteState, {}) || {};
  const lines = [`Remote agents: ${plan}${on ? ", on" : ", off"}${st.deviceId ? `, ${st.deviceId}` : ""}${st.transport ? `, ${st.transport}` : ""}`];
  if (st.lastConnectAt) lines.push(`  last connect ${new Date(st.lastConnectAt).toISOString()}`);
  if (isDry()) {
    lines.push("  relay health not checked (dry run)");
    return lines;
  }
  try {
    const health = await createRemoteApi({ fetch, relayUrl: relayUrl(cfg), token: () => null }).health();
    lines.push(health?.ok ? "  ✓ relay health" : "  ✗ relay health");
  } catch {
    lines.push("  - relay unreachable");
  }
  return lines;
}

export async function cmdRemote(argv) {
  const [sub, ...rest] = argv;
  const names = ["name", "session", "status", "title", "line", "text", "prompt", "link", "token", "wait", "idempotency-key", "expires-in", "remove", "kind"];
  const { flags, words } = parseFlags(rest, names);
  const json = flags.json === true;
  const say = (obj, text) => (json ? console.log(JSON.stringify(obj)) : console.log(text));

  if (!sub || sub === "help" || sub === "--help") {
    console.log("usage: earpiece remote status|on|off|pair|list|revoke|rotate|devices|emit|replies");
    return;
  }

  if (sub === "on" || sub === "off") {
    if (!needPro()) return;
    updateConfig({ remote: { enabled: sub === "on" } });
    return say({ enabled: sub === "on" }, `earpiece: remote agents ${sub}`);
  }

  if (sub === "status") {
    if (!needPro()) return;
    const cfg = config();
    const st = readJson(P.remoteState, {}) || {};
    const row = {
      plan: "pro",
      enabled: cfg.remote?.enabled === true,
      transport: st.transport || "off",
      device_id: st.deviceId || null,
      agents: (st.agents || []).length,
      retry_in_s: st.retryInS || 0,
    };
    return say(row, `plan pro · ${row.enabled ? "on" : "off"} · ${row.transport} · ${row.device_id || "no device"} · ${row.agents} paired`);
  }

  if (sub === "emit") {
    const token = flags.token || process.env.EARPIECE_AGENT_TOKEN;
    if (!token) {
      process.exitCode = 2;
      return console.error("earpiece: remote emit needs --token or EARPIECE_AGENT_TOKEN");
    }
    if (!flags.session || !flags.status) {
      process.exitCode = 2;
      return console.error("usage: earpiece remote emit --session s --status working|needs_you|done|error [--line l]");
    }
    const body = buildEmitBody({ ...flags, token }, optionsOf(rest));
    const check = validateEvent(body);
    if (!check.ok) {
      process.exitCode = 2;
      return console.error(`earpiece: ${check.error}`);
    }
    const key = flags["idempotency-key"] || idempotencyKey(body);
    try {
      const res = await api({ token }).emit(body, key);
      return say({ ...res, idempotency_key: key }, `accepted ${res.event_id || ""}`.trim());
    } catch (e) {
      process.exitCode = e.status === 402 ? 3 : 1;
      return console.error(e.status === 402 ? "Earpiece Pro needed for notch updates." : `earpiece: ${e.message}`);
    }
  }

  if (sub === "replies") {
    const token = flags.token || process.env.EARPIECE_AGENT_TOKEN;
    if (!token) {
      process.exitCode = 2;
      return console.error("earpiece: remote replies needs --token or EARPIECE_AGENT_TOKEN");
    }
    const wait = flags.wait != null ? Math.min(25, Math.max(0, Number(flags.wait) || 0)) : 0;
    try {
      const res = await api({ token }).agentReplies({ wait });
      if (flags.ack && res.replies?.length) await api({ token }).ackReplies(res.replies.map((r) => r.reply_id));
      if (json) return console.log(JSON.stringify(res));
      for (const r of res.replies || []) {
        const choice = r.choice?.key || r.type;
        console.log(`${r.reply_id}  ${r.session_id || ""}  ${choice}${r.text ? `  ${r.text}` : ""}`);
      }
      if (!(res.replies || []).length) console.log("no replies");
      return;
    } catch (e) {
      process.exitCode = 1;
      return console.error(`earpiece: ${e.message}`);
    }
  }

  if (!needPro()) return;
  const a = api();

  if (sub === "list") {
    const res = await a.listAgents();
    saveRemoteState({ agents: res.agents || res || [] });
    const agents = res.agents || res || [];
    if (json) return console.log(JSON.stringify(agents));
    if (!agents.length) return console.log("no remote agents paired");
    for (const g of agents) console.log(`${g.name}\t${g.kind}\t${g.agent_id}\t${g.token_prefix || ""}\t${(g.scopes || []).join(",")}`);
    return;
  }

  if (sub === "devices") {
    if (flags.remove) {
      await a.removeDevice(flags.remove);
      return say({ removed: flags.remove }, `removed ${flags.remove}`);
    }
    const res = await a.listDevices();
    const devices = res.devices || res || [];
    if (json) return console.log(JSON.stringify(devices));
    for (const d of devices) console.log(`${d.id}${d.this_device ? "\tthis Mac" : ""}\t${d.name || ""}\t${d.last_seen_at || ""}`);
    return;
  }

  if (sub === "revoke" || sub === "rotate") {
    const which = words[0];
    if (!which) {
      process.exitCode = 2;
      return console.error(`usage: earpiece remote ${sub} <name|agent_id> [--yes]`);
    }
    const res = await a.listAgents();
    const agents = res.agents || [];
    const hit = agents.find((g) => g.agent_id === which || g.name === which || g.hub_id === which);
    if (!hit) {
      process.exitCode = 1;
      return console.error(`earpiece: no remote agent ${which}`);
    }
    const ok = await confirm(`${sub === "revoke" ? "Revoke" : "Rotate"} ${hit.name}? [y/N] `, flags.yes === true);
    if (!ok) return console.log("cancelled");
    if (sub === "revoke") await a.revokeAgent(hit.agent_id);
    else await a.rotateAgent(hit.agent_id);
    const left = agents.filter((g) => g.agent_id !== hit.agent_id);
    saveRemoteState({ agents: sub === "revoke" ? left : agents });
    return say({ agent_id: hit.agent_id, [sub]: true }, `${sub} ${hit.name}`);
  }

  if (sub === "pair") {
    const hint = flags.name || "Remote";
    if (reservedName(hint)) {
      process.exitCode = 2;
      return console.error("earpiece: that name is reserved");
    }
    await ensureDevice(a, "CLI");
    const code = await a.createCode({ device_id: readJson(P.remoteState, {}).deviceId, label_hint: hint });
    saveRemoteState({ pairingUntil: Date.parse(code.expires_at) || Date.now() + 600_000 });
    say(
      { code: code.code, expires_at: code.expires_at, relay_url: code.relay_url, qr: code.qr_modules || null },
      `Code ${code.code}\nexpires ${code.expires_at}\n${code.qr_modules ? code.qr_modules.split("\n").map((row) => [...row].map((c) => (c === "1" ? "██" : "  ")).join("")).join("\n") : ""}`,
    );
    const deadline = Date.parse(code.expires_at) || Date.now() + 600_000;
    while (Date.now() < deadline) {
      const wait = Math.min(25, Math.max(1, Math.ceil((deadline - Date.now()) / 1000)));
      const polled = await a.events(readJson(P.remoteState, {}).cursor || "", wait);
      const frames = polled.frames || [];
      if (polled.next_cursor) saveRemoteState({ cursor: polled.next_cursor });
      const claim = frames.map((f) => f.data || f).find((f) => f.frame === "pairing");
      if (!claim) continue;
      const ag = claim.agent || {};
      const allow = await confirm(`Allow ${ag.name} (${ag.kind} ${ag.version || ""})? [y/N] `, flags.yes === true);
      if (!allow) {
        await a.deny(claim.claim_id);
        return say({ status: "denied" }, "denied");
      }
      const scopes = claim.requested_scopes || ["events:write", "questions:write", "replies:read"];
      const approved = await a.approve(claim.claim_id, { scopes, display_name: ag.name || hint });
      updateConfig({ remote: { enabled: true }, agents: { [approved.hub_id || `remote.${ag.kind}`]: { label: ag.name || hint } } });
      const agents = (readJson(P.remoteState, {}).agents || []).concat([{ ...approved, name: ag.name, kind: ag.kind }]);
      saveRemoteState({ agents, pairingUntil: 0 });
      return say({ status: "approved", ...approved }, `${ag.name || hint} is connected.`);
    }
    process.exitCode = 1;
    return console.error("earpiece: pairing code expired");
  }

  process.exitCode = 2;
  console.error(`earpiece: unknown remote command "${sub}"`);
}
