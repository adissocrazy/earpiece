// What the Mac app (and a test) drives: start the outbound client only when Pro, signed in,
// enabled, and at least one agent is paired (or a pairing code is still live). Otherwise zero requests.
import { config as readConfig, updateConfig } from "../config.mjs";
import { createAsks } from "../hub/asks.mjs";
import { ingestEvent as ingest } from "../hub/hub.mjs";
import { createRemoteApi, loadRemoteState, relayUrl, saveRemoteState } from "./api.mjs";
import { createRemoteBridge } from "./bridge.mjs";
import { createRemoteClient } from "./client.mjs";
import { reservedName } from "./sanitize.mjs";

export const PRO_MSG = "Remote agents need Earpiece Pro. Open Earpiece › Settings › Remote agents to upgrade.";

/** Pure gate. `pairingUntil` covers the minute before the first agent exists, so the claim can arrive. */
export function shouldConnect({ plan, enabled, paired = 0, pairingUntil = 0, now = Date.now() } = {}) {
  if (plan !== "pro") return false;
  if (pairingUntil > now) return true;
  return enabled === true && paired > 0;
}

export function remoteTelemetry(st = loadRemoteState()) {
  const kinds = new Set((st.agents || []).map((a) => a.kind));
  const transport = st.planLapsed ? "off" : st.transport === "sse" || st.transport === "poll" ? st.transport : "off";
  return {
    remoteAgents: (st.agents || []).length,
    remoteHasGrokbot: kinds.has("grokbot"),
    remoteHasDots: kinds.has("dots"),
    remoteHasOpenclaw: kinds.has("openclaw"),
    remoteHasHermes: kinds.has("hermes"),
    remoteHasCustom: kinds.has("custom"),
    remoteEventsToday: st.eventsToday || 0,
    remoteQuestionsToday: st.questionsToday || 0,
    remoteAnswersToday: st.answersToday || 0,
    remoteTransport: transport,
    remoteReconnectsToday: st.reconnectsToday || 0,
  };
}

export function createRemoteRuntime({
  fetch,
  token = () => null,
  plan = () => "free",
  signedIn = () => false,
  config = readConfig,
  saveConfig = updateConfig,
  asks = null,
  ingestEvent = ingest,
  log = () => {},
  now = Date.now,
  version = "",
  deviceName = () => "Mac",
  onChange = () => {},
  openExternal = () => {},
} = {}) {
  let client = null;
  let bridge = null;
  let claims = [];
  const askStore = asks || createAsks();

  function paired() {
    return (loadRemoteState().agents || []).length;
  }

  async function gate() {
    const p = await Promise.resolve(plan());
    if (p !== "pro") {
      const err = new Error(PRO_MSG);
      err.code = "pro_required";
      throw err;
    }
    return p;
  }

  function freshApi() {
    return createRemoteApi({ fetch, token, relayUrl: relayUrl(config()) });
  }

  async function sync() {
    const p = await Promise.resolve(plan()).catch(() => "free");
    const tok = await Promise.resolve(typeof token === "function" ? token() : token).catch(() => null);
    const cfg = config();
    const st = loadRemoteState();
    const connect = Boolean(tok) && shouldConnect({ plan: p, enabled: cfg.remote?.enabled === true, paired: (st.agents || []).length, pairingUntil: st.pairingUntil || 0, now: now() });
    if (!connect) {
      await client?.stop?.();
      client = null;
      bridge = null;
      return { connected: false };
    }
    if (client) return { connected: true };
    client = createRemoteClient({
      fetch,
      token,
      relayUrl: relayUrl(cfg),
      log,
      now,
      onFrame: (frame, meta) => bridge?.handleFrame(frame, meta),
    });
    bridge = createRemoteBridge({
      ingestEvent,
      asks: askStore,
      log,
      now,
      config,
      reply: (body) => client.reply(body),
      onReplyError: (msg) => {
        saveRemoteState({ inboxError: msg });
        onChange();
      },
      onPairing: (frame) => {
        claims = claims.filter((c) => c.claim_id !== frame.claim_id).concat([frame]);
        onChange();
      },
      onPlan: () => {
        saveRemoteState({ planLapsed: true, transport: "off" });
        onChange();
      },
    });
    client.start();
    freshApi().openQuestions().then((q) => bridge?.resync(q?.questions || q || [])).catch(() => {});
    return { connected: true };
  }

  async function rememberAgents(list) {
    saveRemoteState({ agents: list });
    await sync();
    onChange();
    return list;
  }

  return {
    asks: askStore,
    sync,
    async stop() {
      await client?.stop?.();
      client = null;
    },
    telemetry: () => remoteTelemetry(loadRemoteState()),
    snapshot() {
      const st = loadRemoteState();
      const live = client?.state?.() || {};
      return {
        enabled: config().remote?.enabled === true,
        transport: live.transport || st.transport || "off",
        retryInS: live.retryInS || st.retryInS || 0,
        planLapsed: live.planLapsed || st.planLapsed || false,
        deviceId: st.deviceId || null,
        agents: st.agents || [],
        devices: st.devices || [],
        claims,
        inboxError: st.inboxError || "",
        connected: Boolean(client),
      };
    },
    async handle(action, value = {}) {
      if (action === "status") {
        const p = await Promise.resolve(plan()).catch(() => "free");
        const snap = this.snapshot();
        return { ...snap, plan: p === "pro" ? "pro" : "free", signedIn: Boolean(await Promise.resolve(signedIn()).catch(() => false)) };
      }
      if (action === "docs") {
        await openExternal("https://earpiece.dev/docs/remote-agents");
        return { ok: true };
      }
      await gate();
      const a = freshApi();
      if (action === "toggle") {
        const enabled = value.enabled === true;
        saveConfig({ remote: { enabled } });
        if (!enabled) saveRemoteState({ pairingUntil: 0 });
        await sync();
        return { enabled };
      }
      if (action === "list") {
        const res = await a.listAgents();
        const agents = res.agents || [];
        await rememberAgents(agents);
        return agents;
      }
      if (action === "devices") {
        const res = await a.listDevices();
        const devices = res.devices || [];
        saveRemoteState({ devices });
        return devices;
      }
      if (action === "removeDevice") {
        await a.removeDevice(String(value.device_id || ""));
        return this.handle("devices");
      }
      if (action === "pair") {
        const hint = String(value.label_hint || value.name || "Remote").slice(0, 32);
        if (reservedName(hint)) throw new Error("That name is reserved.");
        const st = loadRemoteState();
        if (!st.deviceId) await a.registerDevice({ name: deviceName() || "Mac", platform: "macos", app_version: version || "0.4.2" });
        const code = await a.createCode({ device_id: loadRemoteState().deviceId, label_hint: hint });
        saveRemoteState({ pairingUntil: Date.parse(code.expires_at) || now() + 600_000 });
        await sync();
        return code;
      }
      if (action === "approve") {
        const scopes = Array.isArray(value.scopes) && value.scopes.length ? value.scopes : ["events:write"];
        const approved = await a.approve(String(value.claim_id), { scopes, display_name: String(value.display_name || "Remote").slice(0, 32) });
        claims = claims.filter((c) => c.claim_id !== value.claim_id);
        const hub = approved.hub_id;
        if (hub) saveConfig({ remote: { enabled: true }, agents: { [hub]: { label: value.display_name || approved.name || "Remote" } } });
        else saveConfig({ remote: { enabled: true } });
        const agents = (loadRemoteState().agents || []).filter((g) => g.agent_id !== approved.agent_id).concat([{ ...approved, name: value.display_name }]);
        saveRemoteState({ pairingUntil: 0 });
        await rememberAgents(agents);
        return approved;
      }
      if (action === "deny") {
        await a.deny(String(value.claim_id));
        claims = claims.filter((c) => c.claim_id !== value.claim_id);
        onChange();
        return { denied: true };
      }
      if (action === "rename") {
        const updated = await a.renameAgent(String(value.agent_id), { name: String(value.name || "").slice(0, 32) });
        if (updated.hub_id) saveConfig({ agents: { [updated.hub_id]: { label: value.name } } });
        return this.handle("list");
      }
      if (action === "revoke") {
        await a.revokeAgent(String(value.agent_id));
        const agents = (loadRemoteState().agents || []).filter((g) => g.agent_id !== value.agent_id);
        await rememberAgents(agents);
        return agents;
      }
      if (action === "rotate") {
        await a.rotateAgent(String(value.agent_id));
        return { rotated: true };
      }
      if (action === "test") {
        return a.testAgent(String(value.agent_id));
      }
      if (action === "clearError") {
        saveRemoteState({ inboxError: "" });
        return { ok: true };
      }
      throw new Error("unknown action");
    },
  };
}
