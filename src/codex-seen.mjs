// When you last started a Codex turn yourself, read from Codex's own session file
// (~/.codex/sessions/YYYY/MM/DD/rollout-…-<session id>.jsonl). Codex tells Earpiece only when a turn
// ends, so without this a question you've already answered in Codex would stay in the Inbox.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TAIL = 512 * 1024; // turns start near the end; the file can be tens of MB
const DAYS = 30; // how far back to look for a session's file
const files = new Map(); // session id → its file
const seen = new Map(); // file → { mtimeMs, at }

const root = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
const dirs = (d) => fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();

function findFile(id) {
  if (files.has(id) && fs.existsSync(files.get(id))) return files.get(id);
  const r = root();
  let looked = 0;
  try {
    for (const y of dirs(r))
      for (const m of dirs(path.join(r, y)))
        for (const d of dirs(path.join(r, y, m))) {
          if (++looked > DAYS) return null;
          const dir = path.join(r, y, m, d);
          const f = fs.readdirSync(dir).find((n) => n.endsWith(`-${id}.jsonl`));
          if (f) return files.set(id, path.join(dir, f)).get(id);
        }
  } catch {}
  return null;
}

/** Last `task_started` in a session file, in ms, or 0. Exported for the tests. */
export function lastTurnStart(file) {
  const st = fs.statSync(file, { throwIfNoEntry: false });
  if (!st) return 0;
  const hit = seen.get(file);
  if (hit?.mtimeMs === st.mtimeMs) return hit.at;
  const fd = fs.openSync(file, "r");
  const len = Math.min(TAIL, st.size);
  const buf = Buffer.alloc(len);
  try {
    fs.readSync(fd, buf, 0, len, st.size - len);
  } finally {
    fs.closeSync(fd);
  }
  let at = 0;
  const lines = buf.toString("utf8").split("\n");
  for (let i = lines.length - 1; i >= 0 && !at; i--) {
    if (!lines[i].includes('"task_started"')) continue;
    try {
      const j = JSON.parse(lines[i]);
      if (j.payload?.type === "task_started") at = Date.parse(j.timestamp) || 0;
    } catch {} // the first line of the tail may be cut
  }
  seen.set(file, { mtimeMs: st.mtimeMs, at });
  return at;
}

/** When you last sent this Codex session a prompt, in ms (0: unknown). */
export function codexTurnStarted(sessionId) {
  if (!/^[\w-]{8,80}$/.test(String(sessionId))) return 0;
  const f = findFile(sessionId);
  return f ? lastTurnStart(f) : 0;
}
