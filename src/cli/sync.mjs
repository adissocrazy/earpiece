// `earpiece sync`: show and copy MCP servers and skills between Claude Code, Codex and Claude Desktop.
import { removeMcp, removeSkill, syncInventory, syncMcp, syncSkill } from "../sync.mjs";
import { parseFlags } from "../util.mjs";

const USAGE = `usage: earpiece sync [--full]
       earpiece sync mcp <name>|--all [--to a,b] [--from id] [--dry-run]
       earpiece sync skill <name>|--all|--outdated [--to a,b] [--from id] [--dry-run]
       earpiece sync remove mcp|skill <name> --from a,b|--everywhere [--dry-run]
tools: claude-code, codex, claude-desktop`;

function grid(inv, full) {
  const pad = (s, n) => String(s).padEnd(n);
  const table = (title, rows, tools, cell) => {
    const w = Math.max(title.length, ...rows.map((r) => r.name.length)) + 2;
    const shown = full ? rows : rows.filter((r) => tools.some((t) => cell(r, t) !== "✓"));
    console.log(`\n${pad(title, w)}${tools.map((t) => pad(t.name, t.name.length + 2)).join("")}`);
    for (const r of shown) console.log(`${pad(r.name, w)}${tools.map((t) => pad(cell(r, t), t.name.length + 2)).join("")}`);
    if (shown.length < rows.length) console.log(`(${rows.length - shown.length} more already everywhere; --full lists them)`);
  };
  const tools = inv.tools.filter((t) => t.present);
  for (const t of inv.tools) if (t.error) console.log(`! ${t.name}: couldn't read its config (${t.error})`);
  table("MCP servers", inv.mcp, tools, (r, t) => (r.by[t.id] ? (r.differs ? "≠" : "✓") : r.cantCopy[t.id] ? "✗" : "–"));
  table("Skills", inv.skills, tools.filter((t) => t.skills), (r, t) => (!r.by[t.id] ? "–" : r.outdated.includes(t.id) ? "↻" : "✓"));
  console.log("\n✓ has it   – missing   ≠ set up differently   ✗ can't be copied there   ↻ out of date");
}

export function cmdSync(args) {
  const { flags, words } = parseFlags(args, ["to", "from"]);
  const [kind, name] = words;
  if (!kind) return grid(syncInventory(), flags.full);
  if (kind === "remove") return remove(words.slice(1), flags);
  const opts = { to: flags.to ? String(flags.to).split(",") : undefined, from: flags.from, dryRun: Boolean(flags["dry-run"]) };
  const inv = syncInventory();
  const present = inv.tools.filter((t) => t.present);
  let names = name ? [name] : null;
  if (kind === "mcp" && flags.all) names = inv.mcp.filter((r) => present.some((t) => !r.by[t.id] && !r.cantCopy[t.id])).map((r) => r.name);
  if (kind === "skill" && flags.all) names = inv.skills.filter((r) => r.outdated.length || present.some((t) => t.skills && !r.by[t.id])).map((r) => r.name);
  if (kind === "skill" && flags.outdated) names = inv.skills.filter((r) => r.outdated.length).map((r) => r.name);
  if (!["mcp", "skill"].includes(kind) || !names) {
    process.exitCode = 2;
    return console.error(USAGE);
  }
  if (!names.length) return console.log("Nothing to do: everything is already in sync.");
  for (const n of names) for (const line of (kind === "mcp" ? syncMcp : syncSkill)(n, opts)) console.log(line);
}

function remove([kind, name], flags) {
  const inv = syncInventory();
  const row = (kind === "mcp" ? inv.mcp : inv.skills).find((r) => r.name === name);
  const from = flags.everywhere ? Object.keys(row?.by || {}).filter((id) => row.by[id]) : flags.from ? String(flags.from).split(",") : null;
  if (!["mcp", "skill"].includes(kind) || !name || !from) {
    process.exitCode = 2;
    return console.error(USAGE);
  }
  if (!row) return console.log(`✗ No ${kind === "mcp" ? "MCP server" : "skill"} called "${name}".`);
  for (const line of (kind === "mcp" ? removeMcp : removeSkill)(name, { from, dryRun: Boolean(flags["dry-run"]) })) console.log(line);
}
