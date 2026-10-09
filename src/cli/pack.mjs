// `earpiece pack`: named bundles of skills you install into every agent at once.
import { createPack, deletePack, exportPack, installPack, listPacks, previewPack, readPack } from "../packs.mjs";
import { parseFlags } from "../util.mjs";

const USAGE = `usage: earpiece pack                      list your packs
       earpiece pack show <name>
       earpiece pack create <name> <skill|path|github:org/repo/path[@ref]>… [--description "…"] [--force]
       earpiece pack preview <name|github:org/repo[@ref]|git url|./dir> [--to …]
       earpiece pack install <name|github:org/repo[@ref]|git url|./dir> [--to claude-code,codex] [--dry-run] [--yes]
       earpiece pack export <name> <dir>
       earpiece pack delete <name>`;

const say = (lines) => lines.forEach((l) => console.log(l));
let json = false; // --json: one JSON value on stdout (the Mac app runs git work through here, off its main thread)
const done = (lines) => {
  if (lines.some((l) => l.startsWith("✗"))) process.exitCode = 1;
  return json ? console.log(JSON.stringify(lines)) : say(lines);
};

function preview(p) {
  console.log(`${p.name}${p.commit ? ` @ ${p.commit.slice(0, 7)}` : ""}: ${p.skills.length} skill${p.skills.length === 1 ? "" : "s"}${p.source ? ` from ${p.source}` : ""}`);
  for (const s of p.skills) {
    console.log(`  ${s.name.padEnd(22)} ${s.files} file${s.files === 1 ? "" : "s"}${s.scripts.length ? `, scripts: ${s.scripts.join(", ")}` : ""}`);
    if (s.description) console.log(`    ${s.description}`);
  }
  say(p.lines.map((l) => `  ${l}`));
}

export function cmdPack(args) {
  const { flags, words } = parseFlags(args, ["to", "description"]);
  const [sub, name, ...rest] = words;
  const to = flags.to ? String(flags.to).split(",") : undefined;
  json = Boolean(flags.json);
  try {
    if (!sub) {
      const packs = listPacks();
      if (!packs.length) return console.log("No packs yet. Make one: earpiece pack create <name> <skill>…");
      for (const p of packs) console.log(`${p.name.padEnd(20)} ${String(p.skills.length).padStart(3)} skills  ${p.source ? `from ${p.source}` : "local"}${p.description ? `  · ${p.description}` : ""}`);
      return;
    }
    if (sub === "show" && name) {
      const p = readPack(name);
      if (!p) return console.log(`✗ No pack called ${name}.`);
      if (p.description) console.log(p.description);
      for (const s of p.skills) console.log(`  ${s.name.padEnd(22)} ${s.repo ? `${s.repo}/${s.path}${s.ref ? `@${s.ref}` : ""}` : s.path}`);
      return p.source && console.log(`from ${p.source}${p.commit ? ` @ ${p.commit.slice(0, 7)}` : ""}`);
    }
    if (sub === "preview" && name) {
      const p = previewPack(name, { to });
      return json ? console.log(JSON.stringify(p)) : preview(p);
    }
    if (sub === "create" && name && rest.length) return done(createPack(name, rest, { description: flags.description, force: Boolean(flags.force) }));
    if (sub === "install" && name) {
      // Your own packs install straight away; anything from a repo or folder is shown first.
      if (!readPack(name) && !flags.yes && !flags["dry-run"]) {
        preview(previewPack(name, { to }));
        return console.log("\nSkills can run code on your machine. Read them first, then run this again with --yes to install.");
      }
      return done(installPack(name, { to, dryRun: Boolean(flags["dry-run"]) }));
    }
    if (sub === "export" && name && rest[0]) return done(exportPack(name, rest[0]));
    if (sub === "delete" && name) return done(deletePack(name));
  } catch (e) {
    process.exitCode = 1;
    return json ? console.log(JSON.stringify({ error: e.message })) : console.error(`✗ ${e.message}`);
  }
  process.exitCode = 2;
  console.error(USAGE);
}
