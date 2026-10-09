// Skill packs: a named list of skills (local folders or skills in git repos) that installs into
// every agent at once. Packs live in ~/.earpiece/packs/<name>.json. Export writes a folder that
// `npx skills` can read too (skills/<name>/SKILL.md). Every copy goes through sync's installSkill,
// so it gets the same backups and rollback.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME } from "./paths.mjs";
import { installSkill, skillDescription, skillRows, SYNC_TOOLS } from "./sync.mjs";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MANIFEST = "earpiece-pack.json";
const SCRIPT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl)$/i;
const SECRET = /(^|\/)\.env(\..*)?$|\.pem$|\.key$|(^|\/)id_[a-z0-9]+$/i;
const SKIP = new Set([".git", "node_modules", ".DS_Store"]);
const skippedPath = (rel) => rel.split(path.sep).some((p) => SKIP.has(p));

const DIR = () => path.join(HOME, "packs");
const expand = (p) => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : path.resolve(p));
const hasSkill = (dir) => fs.existsSync(path.join(dir, "SKILL.md"));
const isPath = (s) => /^[.~/]/.test(s);
const skillTools = () => SYNC_TOOLS.filter((t) => t.skills).map((t) => t.id);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function checkName(n) {
  if (typeof n !== "string" || !NAME.test(n) || n === "." || n === "..") throw new Error(`bad name "${n}": use letters, digits, . - _`);
  return n;
}
const file = (name) => path.join(DIR(), `${checkName(name)}.json`);

// A relative path that stays inside its root, or throws.
function inside(rel = "") {
  if (typeof rel !== "string") throw new Error("bad path: must be text");
  const norm = path.posix.normalize(rel || ".");
  if (path.posix.isAbsolute(norm) || rel.startsWith("~") || norm === ".." || norm.startsWith("../")) throw new Error(`bad path "${rel}": must stay inside the pack`);
  return norm === "." ? "" : norm.replace(/\/$/, "");
}

/** "github:org/repo[/sub/path][@ref]" or a git URL ("https://", "git@host:", "file://"). */
export function parseSource(s) {
  if (typeof s !== "string") throw new Error("bad source");
  let ref = null;
  const at = s.lastIndexOf("@");
  if (s.startsWith("github:") && at > 0) [s, ref] = [s.slice(0, at), s.slice(at + 1)];
  if (ref !== null && !REF.test(ref)) throw new Error(`bad ref "${ref}"`);
  const gh = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(.+))?$/.exec(s);
  if (gh && ![gh[1], gh[2]].some((p) => p === "." || p === ".."))
    return { repo: `github:${gh[1]}/${gh[2]}`, url: `https://github.com/${gh[1]}/${gh[2]}.git`, path: inside(gh[3]), ref };
  if (/^(https:\/\/|file:\/\/|git@[\w.-]+:)\S+$/.test(s)) return { repo: s, url: s, path: "", ref };
  throw new Error(`bad source "${s}": use github:org/repo or a git URL`);
}

// ---------- saved packs ----------

// One `pack create` item -> a pack entry.
function entry(item) {
  if (!isPath(item) && /^(github:|https:\/\/|file:\/\/|git@)/.test(item)) {
    const s = parseSource(item);
    if (!s.path) throw new Error(`${item}: say which skill, e.g. github:org/repo/skills/name`);
    return { name: checkName(path.posix.basename(s.path)), repo: s.repo, path: s.path, ...(s.ref ? { ref: s.ref } : {}) };
  }
  if (isPath(item)) {
    const dir = expand(item);
    if (!hasSkill(dir)) throw new Error(`${item} has no SKILL.md`);
    return { name: checkName(path.basename(dir)), path: dir };
  }
  const row = skillRows().find((r) => r.name === item);
  if (!row) throw new Error(`No skill called "${item}". Run earpiece sync --full to see them.`);
  return { name: item, path: row.by[row.newest].real };
}

function savePack(pack) {
  fs.mkdirSync(DIR(), { recursive: true });
  fs.writeFileSync(file(pack.name), JSON.stringify(pack, null, 2) + "\n");
}

/** Save a pack from installed skill names, folders and github:org/repo/path skills. */
export function createPack(name, items, { description = "", force = false } = {}) {
  checkName(name);
  if (!items?.length) throw new Error("A pack needs at least one skill.");
  if (fs.existsSync(file(name)) && !force) throw new Error(`A pack called ${name} already exists (use --force to replace it).`);
  const skills = items.map(entry);
  const dup = skills.find((s, i) => skills.findIndex((o) => o.name === s.name) !== i);
  if (dup) throw new Error(`Two skills are called ${dup.name}.`);
  savePack({ name, description: String(description || ""), skills, source: null, commit: null });
  return [`✓ Saved ${name} (${plural(skills.length, "skill")})`];
}

/** A saved pack, or null (also for anything that can't be a pack name, like a URL). */
export function readPack(name) {
  if (typeof name !== "string" || !NAME.test(name) || name === "." || name === "..") return null;
  try {
    return JSON.parse(fs.readFileSync(file(name), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`${name}.json: ${e.message}`);
  }
}

export function listPacks() {
  let names = [];
  try {
    names = fs.readdirSync(DIR()).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
  } catch {}
  return names.sort().flatMap((n) => {
    try {
      const p = readPack(n);
      return p && Array.isArray(p.skills) ? [p] : [];
    } catch {
      return []; // ponytail: a hand-broken pack file is hidden here; `pack show` reports the error
    }
  });
}

export function deletePack(name) {
  if (!readPack(name)) return [`✗ No pack called ${name}.`];
  fs.rmSync(file(name), { force: true });
  return [`✓ Deleted the pack ${name} (installed skills stay where they are)`];
}

// ---------- resolving a pack to folders on disk ----------

function clone({ url, ref }) {
  fs.mkdirSync(path.join(HOME, "tmp"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(HOME, "tmp", "pack-"));
  // Never prompt (the app has no terminal), never use exotic transports.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file:https:ssh" };
  try {
    execFileSync("git", ["clone", "-q", "--depth", "1", ...(ref ? ["--branch", ref] : []), "--", url, dir], { stdio: ["ignore", "ignore", "pipe"], env, timeout: 120_000 });
    const commit = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", env }).trim();
    return { dir, commit };
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    const why = String(e.stderr || e.message).trim().split("\n").filter(Boolean).pop() || "git failed";
    throw new Error(`couldn't fetch ${url}${ref ? ` @ ${ref}` : ""}: ${why}`);
  }
}

const under = (top, p) => p === top || p.startsWith(top + path.sep);

// Join a relative path onto a root and refuse anything that lands outside it (symlinks included).
function within(root, rel) {
  const dir = path.join(root, inside(rel));
  const top = fs.realpathSync(root);
  if (fs.existsSync(dir) && !under(top, fs.realpathSync(dir))) throw new Error(`bad path "${rel}": must stay inside the pack`);
  return dir;
}

// Name, description, file count and script files of one skill folder. With `top`, every file
// must really live under it, so a link in a repo can't pull in something like ~/.ssh.
function describe(name, dir, { top = null } = {}) {
  checkName(name);
  if (!hasSkill(dir)) throw new Error(`${name}: no SKILL.md in ${dir}`);
  const top_ = top && fs.realpathSync(top);
  const files = [];
  for (const rel of fs.readdirSync(dir, { recursive: true }).map(String)) {
    if (skippedPath(rel)) continue;
    const full = path.join(dir, rel);
    let real;
    try {
      real = fs.realpathSync(full);
    } catch {
      continue; // broken link
    }
    if (top_ && !under(top_, real)) throw new Error(`${name}: ${rel} points outside the pack`);
    if (fs.statSync(real).isFile()) files.push(rel);
  }
  return { name, dir, description: skillDescription(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")), files: files.length, scripts: files.filter((r) => SCRIPT.test(r)) };
}

// Skills in a folder that has no manifest: skills/*/SKILL.md, else a SKILL.md at the root.
function scan(root, label) {
  const sub = path.join(root, "skills");
  const names = fs.existsSync(sub) ? fs.readdirSync(sub).filter((n) => !n.startsWith(".") && hasSkill(path.join(sub, n))).sort() : [];
  if (names.length) return names.map((n) => ({ name: n, path: `skills/${n}` }));
  if (hasSkill(root)) return [{ name: baseName(label), path: "" }];
  throw new Error(`${label} has no ${MANIFEST} and no skills/*/SKILL.md`);
}

// "github:acme/skills@main" -> "skills", "file:///tmp/repo.git" -> "repo"
const baseName = (src) => path.posix.basename(String(src).replace(/@[^/]*$/, "").replace(/\/+$/, "").replace(/\.git$/, "").replace(/^[^:]*:/, "/"));

/**
 * Turn a saved pack name, a git source or a local folder into skill folders on disk. Each skill
 * keeps the manifest `entry` it came from. Call cleanup() when done (it removes any clones).
 */
export function resolvePack(ref) {
  const temps = [];
  const cleanup = () => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  try {
    const clones = new Map(); // "url@ref" -> { dir, commit }
    const fetch = (s) => {
      const k = `${s.url}@${s.ref || ""}`;
      if (!clones.has(k)) {
        const c = clone(s);
        temps.push(c.dir);
        clones.set(k, c);
      }
      return clones.get(k);
    };
    const saved = readPack(ref);
    let pack = saved;
    let root = null;
    let source = null;
    let commit = null;
    if (!saved) {
      if (typeof ref !== "string" || !ref) throw new Error("Say which pack: a name, github:org/repo, a git URL or a folder.");
      if (isPath(ref)) [root, source] = [expand(ref), ref];
      else {
        const s = parseSource(ref);
        const c = fetch(s);
        [root, source, commit] = [s.path ? within(c.dir, s.path) : c.dir, ref, c.commit];
      }
      if (!fs.existsSync(root)) throw new Error(`${ref} doesn't exist`);
      const m = path.join(root, MANIFEST);
      if (fs.existsSync(m)) {
        try {
          pack = JSON.parse(fs.readFileSync(m, "utf8"));
        } catch (e) {
          throw new Error(`${MANIFEST}: ${e.message}`);
        }
      } else pack = { name: baseName(isPath(ref) ? expand(ref) : ref), skills: scan(root, ref) };
      checkName(pack.name);
    }
    if (!Array.isArray(pack.skills) || !pack.skills.length) throw new Error(`${pack.name} lists no skills`);
    const seen = new Set();
    const skills = pack.skills.map((e) => {
      if (!e || typeof e !== "object") throw new Error(`${pack.name}: bad skill entry`);
      if (seen.has(e.name)) throw new Error(`${pack.name}: two skills are called ${e.name}`);
      seen.add(e.name);
      if (e.repo) {
        const s = { ...parseSource(e.repo), ref: e.ref || null };
        if (s.ref && !REF.test(s.ref)) throw new Error(`bad ref "${s.ref}"`);
        if (!saved && s.url.startsWith("file:")) throw new Error(`${e.name}: a shared pack can't point at files on this machine`);
        const c = fetch(s);
        return { ...describe(e.name, within(c.dir, path.posix.join(s.path, inside(e.path))), { top: c.dir }), entry: e, from: `${s.repo}${s.ref ? `@${s.ref}` : ""}` };
      }
      // Absolute paths only in packs you saved yourself; a repo or folder's manifest stays inside it.
      if (saved) {
        if (typeof e.path !== "string" || !/^[~/]/.test(e.path)) throw new Error(`${e.name}: use a full path in ${pack.name}.json`);
        return { ...describe(e.name, expand(e.path)), entry: e, from: e.path };
      }
      return { ...describe(e.name, within(root, e.path), { top: root }), entry: e, from: `${source}${e.path ? `:${e.path}` : ""}` };
    });
    const commits = [...new Set([...clones.values()].map((c) => c.commit))];
    return { pack: { name: pack.name, description: String(pack.description || "") }, saved: Boolean(saved), source: saved ? saved.source || null : source, commit: commit ?? (commits.length === 1 ? commits[0] : null), skills, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

// ---------- install, preview, export ----------

/** What `install` would do, for the CLI confirmation and the app's preview. */
export function previewPack(ref, { to } = {}) {
  const r = resolvePack(ref);
  try {
    const targets = to?.length ? to : skillTools();
    return {
      ...r.pack,
      source: r.source,
      commit: r.commit,
      saved: r.saved,
      skills: r.skills.map(({ name, description, files, scripts, from }) => ({ name, description, files, scripts, from })),
      lines: r.skills.flatMap((s) => targets.map((id) => installSkill(s.dir, s.name, id, { dryRun: true, fromLabel: s.from }))),
    };
  } finally {
    r.cleanup();
  }
}

/**
 * Install every skill in a pack into `to` (default: every tool with skills). A pack from a repo or
 * folder is saved too, with where it came from, so it can be installed again by name. Installing
 * a saved pack fetches its repos again, so you get their latest. Returns message lines.
 */
export function installPack(ref, { to, dryRun = false } = {}) {
  let r;
  try {
    r = resolvePack(ref);
  } catch (e) {
    return [`✗ ${e.message}`];
  }
  try {
    if (!r.saved && !dryRun) {
      const have = readPack(r.pack.name);
      if (have && have.source !== r.source) return [`✗ You already have a pack called ${r.pack.name}. Delete or rename it first.`];
    }
    const out = r.skills.flatMap((s) => (to?.length ? to : skillTools()).map((id) => installSkill(s.dir, s.name, id, { dryRun, fromLabel: s.from })));
    if (dryRun || out.some((l) => l.startsWith("✗"))) return out;
    if (!r.saved) {
      const remote = isPath(r.source) ? null : parseSource(r.source);
      const skills = r.skills.map(({ name, dir, entry: e }) => {
        if (e.repo) return e;
        if (!remote) return { name, path: fs.realpathSync(dir) };
        return { name, repo: remote.repo, path: path.posix.join(remote.path, inside(e.path)), ...(remote.ref ? { ref: remote.ref } : {}) };
      });
      savePack({ ...r.pack, skills, source: r.source, commit: r.commit });
      out.push(`✓ Saved the pack ${r.pack.name}${r.commit ? ` at ${r.commit.slice(0, 7)}` : ""}`);
    } else if (r.commit) {
      const p = readPack(r.pack.name);
      if (p.commit !== r.commit) savePack({ ...p, commit: r.commit });
    }
    return out;
  } finally {
    r.cleanup();
  }
}

/**
 * Write a saved pack to `outDir` as earpiece-pack.json + skills/<name>/… (the layout `npx skills`
 * reads), with every skill copied in so the folder stands alone. Files that look like secrets are
 * left out. Refuses a folder that has other things in it, unless it's an earlier export.
 */
export function exportPack(name, outDir) {
  if (!readPack(name)) return [`✗ No pack called ${name}.`];
  const dest = expand(outDir);
  const prior = fs.existsSync(path.join(dest, MANIFEST));
  if (fs.existsSync(dest) && fs.readdirSync(dest).some((n) => n !== ".git" && n !== ".DS_Store") && !prior)
    return [`✗ ${outDir} isn't empty. Pick an empty folder or an earlier export.`];
  let r;
  try {
    r = resolvePack(name);
  } catch (e) {
    return [`✗ ${e.message}`];
  }
  try {
    const left = [];
    fs.rmSync(path.join(dest, "skills"), { recursive: true, force: true }); // an earlier export: start clean
    for (const s of r.skills) {
      const real = fs.realpathSync(s.dir);
      fs.cpSync(real, path.join(dest, "skills", s.name), {
        recursive: true,
        dereference: true,
        filter: (src) => {
          const rel = path.relative(real, src);
          if (skippedPath(rel)) return false;
          if (SECRET.test(rel)) return left.push(`${s.name}/${rel}`), false;
          return true;
        },
      });
    }
    const manifest = { name: r.pack.name, description: r.pack.description, skills: r.skills.map((s) => ({ name: s.name, path: `skills/${s.name}`, from: s.entry.repo ? s.from : "local" })) };
    fs.writeFileSync(path.join(dest, MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
    return [
      `✓ Exported ${name} to ${outDir} (${plural(r.skills.length, "skill")})`,
      ...left.map((p) => `• Left out ${p} (looks like a secret)`),
      "• Push the folder to GitHub, then anyone can run: earpiece pack install github:<org>/<repo>",
    ];
  } finally {
    r.cleanup();
  }
}
