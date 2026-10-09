// Skill packs: create, install, export, against a fake home folder and local git repos.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { tempHome } from "./helpers.mjs";

const home = tempHome();
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "earpiece-packs-"));
process.env.HOME = fakeHome;
const P = await import("../src/packs.mjs");

const f = (...p) => path.join(fakeHome, ...p);
const write = (file, text) => (fs.mkdirSync(path.dirname(file), { recursive: true }), fs.writeFileSync(file, text));
const md = (n, d = "does a thing") => `---\nname: ${n}\ndescription: ${d}\n---\nbody\n`;
const tmps = () => fs.readdirSync(path.join(home, "tmp")).filter((n) => n.startsWith("pack-"));

// A local git repo standing in for GitHub.
function repo(files) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "earpiece-repo-")));
  for (const [rel, text] of Object.entries(files)) write(path.join(dir, rel), text);
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return { dir, url: `file://${dir}`, name: path.basename(dir) };
}

write(f(".claude", "skills", "deploy", "SKILL.md"), md("deploy", "ships it"));
write(f("work", "lint", "SKILL.md"), md("lint"));
fs.mkdirSync(f(".agents", "skills"), { recursive: true }); // Codex
fs.mkdirSync(path.join(home, "tmp"), { recursive: true });

test("sources: github shorthand, urls, sub-paths and refs", () => {
  assert.deepEqual(P.parseSource("github:acme/skills"), { repo: "github:acme/skills", url: "https://github.com/acme/skills.git", path: "", ref: null });
  assert.deepEqual(P.parseSource("github:acme/skills/skills/review@v2"), { repo: "github:acme/skills", url: "https://github.com/acme/skills.git", path: "skills/review", ref: "v2" });
  assert.equal(P.parseSource("file:///tmp/x").url, "file:///tmp/x");
  assert.equal(P.parseSource("git@github.com:acme/skills.git").url, "git@github.com:acme/skills.git");
  for (const bad of ["github:../x", "github:acme", "--upload-pack=touch /tmp/p", "ext::sh -c x", "github:acme/skills/../../etc", "github:a/b@-x"])
    assert.throws(() => P.parseSource(bad), /source|path|ref/, bad);
});

test("names: letters, digits, dot, dash, underscore; never . or ..", () => {
  for (const ok of ["deploy", "acme-eng", "a.b_c"]) assert.equal(P.checkName(ok), ok);
  for (const bad of ["", ".", "..", "../x", "a/b", "-x", "x".repeat(65)]) assert.throws(() => P.checkName(bad), /name/, bad);
});

test("create resolves installed names and paths, rejects missing skills, lists and deletes", () => {
  assert.match(P.createPack("team", ["deploy", "~/work/lint", "github:acme/skills/skills/review@main"], { description: "Team setup" }).join(), /✓ Saved team \(3 skills\)/);
  const pack = P.readPack("team");
  assert.deepEqual(pack.skills.map((s) => s.name), ["deploy", "lint", "review"]);
  assert.equal(pack.skills[0].path, fs.realpathSync(f(".claude", "skills", "deploy")));
  assert.deepEqual(pack.skills[2], { name: "review", repo: "github:acme/skills", path: "skills/review", ref: "main" });
  assert.throws(() => P.createPack("team", ["deploy"]), /already exists/);
  assert.throws(() => P.createPack("x", ["nope"]), /No skill called "nope"/);
  assert.throws(() => P.createPack("x", ["~/work"]), /no SKILL\.md/);
  assert.throws(() => P.createPack("x", ["deploy", "~/.claude/skills/deploy"]), /Two skills are called deploy/);
  assert.deepEqual(P.listPacks().map((p) => [p.name, p.skills.length]), [["team", 3]]);
  assert.match(P.deletePack("team").join(), /✓ Deleted/);
  assert.deepEqual(P.listPacks(), []);
});

test("resolve: a repo with a manifest, a repo without one, and no temp folders left", () => {
  const a = repo({ "earpiece-pack.json": JSON.stringify({ name: "eng", skills: [{ name: "review", path: "skills/review" }] }), "skills/review/SKILL.md": md("review"), "skills/review/run.sh": "echo hi" });
  const r = P.resolvePack(a.url);
  assert.equal(r.pack.name, "eng");
  assert.deepEqual(r.skills.map((s) => [s.name, s.files, s.scripts]), [["review", 2, ["run.sh"]]]);
  assert.match(r.commit, /^[0-9a-f]{40}$/);
  r.cleanup();

  const b = repo({ "skills/a/SKILL.md": md("a"), "skills/b/SKILL.md": md("b"), "skills/c/SKILL.md": "---\nname: c\ndescription:\n  wraps onto\n  two lines\n---\n", "skills/notaskill/README.md": "x" });
  const r2 = P.resolvePack(b.url);
  assert.equal(r2.pack.name, b.name);
  assert.deepEqual(r2.skills.map((s) => [s.name, s.description]), [["a", "does a thing"], ["b", "does a thing"], ["c", "wraps onto two lines"]]);
  r2.cleanup();
  assert.deepEqual(tmps(), []);
});

test("resolve: a shared pack can't reach outside itself", () => {
  write(f("secret", "SKILL.md"), md("secret"));
  const cases = [
    [{ name: "x", path: "../../etc" }, /inside the pack/],
    [{ name: "x", path: f("secret") }, /inside the pack/],
    [{ name: "x", path: "~/secret" }, /inside the pack/],
    [{ name: "x", repo: `file://${f("anything")}`, path: "" }, /files on this machine/],
  ];
  for (const [skill, err] of cases) {
    const evil = repo({ "earpiece-pack.json": JSON.stringify({ name: "evil", skills: [skill] }) });
    assert.throws(() => P.resolvePack(evil.url), err, JSON.stringify(skill));
  }
  // A link inside a skill that points at a file outside the repo.
  const linked = repo({ "skills/x/SKILL.md": md("x") });
  fs.symlinkSync(f("secret", "SKILL.md"), path.join(linked.dir, "skills", "x", "leak.md"));
  execFileSync("git", ["-C", linked.dir, "add", "."]);
  execFileSync("git", ["-C", linked.dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "link"]);
  assert.throws(() => P.resolvePack(linked.url), /points outside the pack/);
  assert.deepEqual(tmps(), []);
});

test("resolve: a git failure is a clear error and leaves no temp folder", () => {
  assert.throws(() => P.resolvePack("file:///does/not/exist"), /couldn't fetch/);
  assert.deepEqual(tmps(), []);
});

test("install copies into Claude Code and Codex, is idempotent, and backs up edited copies", () => {
  P.createPack("mine", ["~/work/lint"]);
  let out = P.installPack("mine").join("\n");
  assert.match(out, /✓ Claude Code: copied lint/);
  assert.match(out, /✓ Codex: copied lint/);
  assert.ok(fs.existsSync(f(".agents", "skills", "lint", "SKILL.md")));
  assert.match(P.installPack("mine").join("\n"), /already up to date[\s\S]*already up to date/);
  write(f(".agents", "skills", "lint", "SKILL.md"), md("lint", "edited"));
  assert.match(P.installPack("mine", { to: ["codex"], dryRun: true }).join(), /would update lint/);
  assert.match(P.installPack("mine", { to: ["codex"] }).join(), /✓ Codex: updated lint.*backup/);
  assert.match(P.installPack("mine", { to: ["claude-desktop"] }).join(), /has no skills folder/);
});

test("install from git saves the pack with its source and commit, and reinstalls by name", () => {
  const r = repo({ "skills/fmt/SKILL.md": md("fmt") });
  const preview = P.previewPack(r.url);
  assert.deepEqual(preview.skills.map((s) => s.name), ["fmt"]);
  assert.match(preview.lines.join(), /would copy fmt/);
  assert.equal(P.readPack(r.name), null, "preview writes nothing");
  assert.match(P.installPack(r.url).join("\n"), /✓ Claude Code: copied fmt[\s\S]*✓ Saved the pack/);
  const saved = P.readPack(r.name);
  assert.equal(saved.source, r.url);
  assert.match(saved.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(saved.skills, [{ name: "fmt", repo: r.url, path: "skills/fmt" }]);
  assert.match(P.installPack(r.name).join(), /already up to date/); // a saved pack may point at a local repo
  assert.deepEqual(tmps(), []);
});

test("install won't overwrite a different pack with the same name", () => {
  P.createPack("clash", ["~/work/lint"]);
  const r = repo({ "earpiece-pack.json": JSON.stringify({ name: "clash", skills: [{ name: "z", path: "z" }] }), "z/SKILL.md": md("z") });
  assert.match(P.installPack(r.url).join(), /✗ You already have a pack called clash/);
});

test("export copies every skill, leaves out secrets, and installs back from the folder", () => {
  write(f("work", "lint", ".env"), "TOKEN=secret");
  const r = repo({ "skills/fmt/SKILL.md": md("fmt") });
  write(path.join(home, "packs", "share.json"), JSON.stringify({ name: "share", description: "d", skills: [{ name: "lint", path: f("work", "lint") }, { name: "fmt", repo: r.url, path: "skills/fmt" }] }));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "earpiece-export-"));
  const lines = P.exportPack("share", out).join("\n");
  assert.match(lines, /✓ Exported share .*2 skills/);
  assert.match(lines, /Left out lint\/\.env/);
  assert.ok(fs.existsSync(path.join(out, "skills", "lint", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(out, "skills", "fmt", "SKILL.md")));
  assert.ok(!fs.existsSync(path.join(out, "skills", "lint", ".env")));
  const m = JSON.parse(fs.readFileSync(path.join(out, "earpiece-pack.json"), "utf8"));
  assert.deepEqual(m.skills, [{ name: "lint", path: "skills/lint", from: "local" }, { name: "fmt", path: "skills/fmt", from: r.url }]);
  assert.match(P.exportPack("share", out).join(), /✓ Exported/, "an earlier export can be refreshed");
  P.deletePack("share");
  assert.deepEqual(P.previewPack(out).skills.map((s) => s.name), ["lint", "fmt"]);
  assert.match(P.exportPack("mine", f("work")).join(), /isn't empty/);
});
