// Shared helpers for adapters that edit an agent's own config file.
import fs from "node:fs";

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

// Copies file to file.bak-earpiece-<timestamp>. Returns the backup path, or null if file didn't exist.
export function backup(file) {
  if (!fs.existsSync(file)) return null;
  const b = `${file}.bak-earpiece-${stamp()}`;
  fs.copyFileSync(file, b);
  return b;
}

export const quote = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// Only commands Earpiece wrote count as ours: an earpiece.mjs path followed by one of our hook
// subcommands, either as a shell command (`"…/earpiece.mjs" hook`) or a TOML/JSON array
// (`"…/earpiece.mjs", "codex"`). Covers bin/earpiece.mjs, the desktop app's earpiece-hook shim
// and the names from before the rename (jarvis.mjs, jarvis-hook), so switching between any of
// them replaces the hook, never doubles it.
export const isOurCommand = (s) =>
  typeof s === "string" &&
  /(?:earpiece\.mjs|earpiece-hook|jarvis\.mjs|jarvis-hook)["']?(?:\s*,\s*["']|\s+)(?:hook|codex|ask|reply)\b/.test(s);

// The command prefix hooks run: [node, bin/earpiece.mjs] for the CLI, [shim] for the app.
export const commandPrefix = ({ cmd, node, bin }) => (cmd?.length ? cmd : [node, bin]);
