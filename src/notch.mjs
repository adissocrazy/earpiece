// What the notch island shows when it is at rest: the agents you have running, as a short list.
// The app passes in the same session rows the menu bar popover gets (see state() in the app);
// this picks the ones worth a glance and the one colour the resting icon should be.

export const RECENT_MS = 30 * 60_000; // finished agents stay on the list this long
export const MAX_ROWS = 6;

const ACTIVE = new Set(["waiting", "error", "working"]);
const ORDER = { waiting: 0, error: 1, working: 2, done: 3, idle: 4 };

/**
 * @param {Array<{agent:string, agentId:string, session:string, project?:string, status?:string, updated?:number, lastLine?:string}>} rows
 * @returns {{ rows: object[], more: number, active: number, waiting: number, tone: "waiting"|"error"|"working"|"idle" }}
 */
export function notchAgents(rows, { now = Date.now(), recentMs = RECENT_MS, max = MAX_ROWS } = {}) {
  const keep = (Array.isArray(rows) ? rows : []).filter((r) => {
    if (!r || !r.agentId || !r.session) return false;
    const status = r.status || "idle";
    if (ACTIVE.has(status)) return true;
    return now - (Number(r.updated) || 0) < recentMs;
  });
  keep.sort((a, b) => (ORDER[a.status || "idle"] ?? 4) - (ORDER[b.status || "idle"] ?? 4) || (b.updated || 0) - (a.updated || 0));
  const count = (s) => keep.filter((r) => r.status === s).length;
  const waiting = count("waiting");
  const tone = waiting ? "waiting" : count("error") ? "error" : count("working") ? "working" : "idle";
  return {
    rows: keep.slice(0, max).map((r) => ({
      agent: r.agent || r.agentId,
      agentId: r.agentId,
      session: r.session,
      project: r.project || "",
      status: r.status || "idle",
      updated: Number(r.updated) || 0,
      lastLine: String(r.lastLine || "").slice(0, 200),
      run: r.run || null, // started by Earpiece (Pro shows these with their own controls)
    })),
    more: Math.max(0, keep.length - max),
    active: keep.filter((r) => ACTIVE.has(r.status)).length,
    waiting,
    tone,
  };
}

/**
 * Parse `lsappinfo info <front ASN>` output: the app that has the keyboard, so the island can give
 * it back after you type a reply. Returns null when there is nothing usable.
 */
export function parseFrontApp(text) {
  const t = String(text || "");
  const bundleId = t.match(/bundleID="([A-Za-z0-9.-]+)"/)?.[1] || null;
  const pid = Number(t.match(/\bpid\s*=\s*(\d+)/)?.[1]) || null;
  return bundleId ? { bundleId, pid } : null;
}
