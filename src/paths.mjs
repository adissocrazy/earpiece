// Filesystem locations. EARPIECE_HOME is read once, at import time.
import "./env-compat.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BIN = path.join(ROOT, "bin", "earpiece.mjs");
export const HOME = process.env.EARPIECE_HOME || path.join(os.homedir(), ".earpiece");
export const LEGACY_HOME = path.join(os.homedir(), ".jarvis-voice");

// Before the rename everything lived in ~/.jarvis-voice. Move it once and leave a symlink, so
// hooks and MCP entries that still point at the old path keep working until the next install.
export function migrateHome({ from = LEGACY_HOME, to = HOME } = {}) {
  try {
    if (fs.existsSync(to) || !fs.lstatSync(from, { throwIfNoEntry: false })?.isDirectory()) return false;
    fs.renameSync(from, to);
    fs.symlinkSync(to, from);
    return true;
  } catch {
    return false; // another process got there first, or the disk said no; either way keep going
  }
}
if (!process.env.EARPIECE_HOME) migrateHome();

export const P = {
  config: path.join(HOME, "config.json"),
  env: path.join(HOME, ".env"),
  mode: path.join(HOME, "mode.json"),
  last: path.join(HOME, "last-spoken.json"),
  tone: path.join(HOME, "last-tone.json"),
  card: path.join(HOME, "card.json"), // what the app's floating card shows
  flushed: path.join(HOME, "flushed.json"),
  log: path.join(HOME, "log.jsonl"),
  lock: path.join(HOME, "speak.lock"),
  sessions: path.join(HOME, "sessions"),
  tmp: path.join(HOME, "tmp"),
  socket: path.join(HOME, "hub.sock"), // the desktop app (or `earpiece serve`) listens here
  shim: path.join(HOME, "bin", "earpiece-hook"), // what hooks call when the hub is installed
  account: path.join(HOME, "account.json"), // Pro sign-in, written by the Mac app (src/pro.mjs)
  appClosed: path.join(HOME, "app-closed.json"), // the Mac app was quit: hooks stay silent until it opens again
  appPid: path.join(HOME, "app.pid.json"), // the Mac app while it runs; if that process is gone, it's closed too
};
