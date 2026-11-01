// `earpiece doctor`: is everything wired to this copy of Earpiece? Reads every file Earpiece
// writes into (agent settings, Claude Desktop config, the hook shim), lists the Earpiece paths
// they mention, and flags any that no longer exist (a moved or deleted checkout) or that point
// at a different copy. Also checks the hub socket and the API keys. Read-only.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { configFiles } from "../adapters/claude-desktop.mjs";
import { apiKey, config } from "../config.mjs";
import { EDITORS, editorWindows } from "../hub/editors.mjs";
import { BIN, P, ROOT } from "../paths.mjs";
import { remoteDoctorLines } from "./remote.mjs";

/** Absolute paths in a config file that belong to Earpiece (or its old name). */
export function earpiecePaths(text) {
  const out = new Set();
  // JSON escapes "/" sometimes and quotes paths; TOML and shell quote them too.
  const s = String(text || "").replace(/\\+\//g, "/");
  for (const m of s.matchAll(/\/(?:[^\s"'`,;\]\[\\()]+\/)*[^\s"'`,;\]\[\\()]*(?:earpiece|jarvis)[^\s"'`,;\]\[\\()]*/gi)) {
    const p = m[0].replace(/[.:]+$/, "");
    if (p.length > 1) out.add(p);
  }
  return [...out];
}

/** The checkout a path belongs to: everything up to and including the folder holding bin/ or src/. */
const checkoutOf = (p) => {
  const m = /^(.*?)\/(?:bin|src)\/[^/]+\.mjs$/.exec(p);
  return m ? m[1] : null;
};

/**
 * Check one file. Returns { file, present, paths: [{ path, ok, why }] }.
 * `exists` and `root` are injectable for tests.
 */
export function checkFile(file, { read = (f) => fs.readFileSync(f, "utf8"), exists = fs.existsSync, root = ROOT } = {}) {
  if (!exists(file)) return { file, present: false, paths: [] };
  let text = "";
  try {
    text = read(file);
  } catch {
    return { file, present: true, unreadable: true, paths: [] };
  }
  const paths = earpiecePaths(text)
    // Backups and our own home folder are fine to mention; only things we run matter.
    .filter((p) => !/\.bak-earpiece-/.test(p) && /\.(mjs|js)$|earpiece-hook$|jarvis-hook$|\/bin\/[^/]+$/.test(p))
    .map((p) => {
      if (!exists(p)) return { path: p, ok: false, why: "missing (moved or deleted?)" };
      const co = checkoutOf(p);
      let real = co;
      try {
        real = co ? fs.realpathSync(co) : co;
      } catch {}
      let rootReal = root;
      try {
        rootReal = fs.realpathSync(root);
      } catch {}
      if (co && real !== rootReal && !p.includes(".app/Contents/Resources/")) return { path: p, ok: true, warn: true, why: `another copy of Earpiece (this one is ${root})` };
      return { path: p, ok: true };
    });
  return { file, present: true, paths };
}

export function doctorFiles(home = os.homedir()) {
  return [
    path.join(home, ".claude", "settings.json"),
    path.join(home, ".codex", "config.toml"),
    path.join(home, ".codex", "hooks.json"),
    ...configFiles(),
    P.shim,
    P.config, // the Codex chain keeps the previous notify command here
  ];
}

function hubHealth() {
  return new Promise((resolve) => {
    if (!fs.existsSync(P.socket)) return resolve(null);
    const req = http.get({ socketPath: P.socket, path: "/health", timeout: 1500 }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(b));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => (req.destroy(), resolve(null)));
  });
}

export async function cmdDoctor() {
  const tilde = (p) => p.replace(os.homedir(), "~");
  let problems = 0;
  let warnings = 0;
  console.log(`Earpiece at ${tilde(ROOT)}\n`);
  for (const r of doctorFiles().map((f) => checkFile(f))) {
    if (!r.present) continue;
    if (r.unreadable) {
      console.log(`  ? ${tilde(r.file)}: can't read it`);
      continue;
    }
    if (!r.paths.length) {
      console.log(`  - ${tilde(r.file)}: no Earpiece entries`);
      continue;
    }
    for (const p of r.paths) {
      if (!p.ok) problems++;
      else if (p.warn) warnings++;
      const mark = !p.ok ? "✗" : p.warn ? "!" : "✓";
      console.log(`  ${mark} ${tilde(r.file)} → ${tilde(p.path)}${p.why ? `  ${p.why}` : ""}`);
    }
  }
  // Editors: which windows a click on a session would find (see editors.mjs).
  const eds = EDITORS.filter((e) => fs.existsSync(path.join(os.homedir(), "Library", "Application Support", e.support)));
  if (eds.length) console.log("");
  for (const e of eds) {
    const ws = editorWindows(e);
    console.log(`  - ${e.name}: ${ws.length} window${ws.length === 1 ? "" : "s"} known${ws.length ? ` (${ws.slice(0, 4).map((w) => tilde(w.open)).join(", ")}${ws.length > 4 ? ", …" : ""})` : ""}`);
  }
  const health = await hubHealth();
  console.log(health ? `\n  ✓ hub running (pid ${health.pid}, ${health.version || "?"})` : "\n  - hub not running (hooks fall back to running Earpiece directly; open the Mac app or `earpiece serve`)");
  const cfg = config();
  for (const k of ["SMALLEST_API_KEY", "OPENAI_API_KEY"]) console.log(`  ${apiKey(cfg, k) ? "✓" : "-"} ${k} ${apiKey(cfg, k) ? "found" : "missing"}`);
  for (const line of await remoteDoctorLines()) console.log(line.startsWith("  ") ? line : `  ${line}`);
  if (cfg.envFile) console.log(`  ${fs.existsSync(cfg.envFile) ? "✓" : "✗"} keys file ${tilde(cfg.envFile)}`), fs.existsSync(cfg.envFile) || problems++;
  console.log(
    problems
      ? `\n${problems} broken path${problems > 1 ? "s" : ""}. Run \`node ${tilde(BIN)} install --chain\` from this copy to rewrite them (add --hub if you use the Mac app).`
      : warnings
        ? "\nWorking, but some entries point at another copy of Earpiece. Re-run install from the copy you want to keep."
        : "\nAll good.",
  );
  if (problems) process.exitCode = 1;
}
