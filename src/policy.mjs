// When Earpiece is allowed to talk: modes (on / quiet / off) and quiet hours.
import fs from "node:fs";
import { P } from "./paths.mjs";
import { now, readJson, writeJson } from "./util.mjs";

export function inQuietHours(qh, d = new Date()) {
  if (!qh?.start || !qh?.end) return false;
  const mins = (s) => {
    const [h, m] = String(s).split(":").map(Number);
    return h * 60 + (m || 0);
  };
  const cur = d.getHours() * 60 + d.getMinutes();
  const a = mins(qh.start), b = mins(qh.end);
  return a <= b ? cur >= a && cur < b : cur >= a || cur < b;
}

export function currentMode() {
  const m = readJson(P.mode, { mode: "on" });
  if (m.until && now() > m.until) return "on";
  return m.mode || "on";
}

export function setMode(mode, minutes = 0) {
  writeJson(P.mode, mode === "on" ? { mode } : { mode, until: minutes ? now() + minutes * 60_000 : null });
}

// Kinds that may still speak during quiet hours. Default: only "needs you" pings.
// `allow: []` makes quiet hours fully silent.
export const QUIET_ALLOW_DEFAULT = ["needs_input"];
export const quietAllows = (qh, kind) => (Array.isArray(qh?.allow) ? qh.allow : QUIET_ALLOW_DEFAULT).includes(kind);

// The Mac app writes this on Quit and removes it on launch: quitting Earpiece means Earpiece is off.
// Hooks that fire meanwhile still update the session list, but nothing is spoken or summarised.
// CLI-only installs (no app) never have it. `earpiece on` clears it.
// The app also leaves its pid while it runs: if that process is gone without a Quit (Ctrl+C on the
// dev app, a crash, a force quit), it's closed all the same.
export const appClosed = () => fs.existsSync(P.appClosed) || appGone();

// ponytail: a reused pid reads as "still running"; rare, and the next launch rewrites the file.
function appGone() {
  const pid = readJson(P.appPid, null)?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === "ESRCH";
  }
}

// Returns a skip reason, or null if this kind of line may be spoken now.
export function policyBlock(kind, cfg, d = new Date()) {
  if (appClosed()) return "app_closed";
  const mode = currentMode();
  if (mode === "off") return "mode_off";
  // Quiet: nothing is spoken or chimed. Every line still shows on the card, tagged "Quiet".
  if (mode === "quiet") return "mode_quiet";
  if (inQuietHours(cfg.quietHours, d) && !quietAllows(cfg.quietHours, kind)) return "quiet_hours";
  return null;
}
