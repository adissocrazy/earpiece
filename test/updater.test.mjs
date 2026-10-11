// One-click updates: picking the release, checking the download, and the swap script.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bundleOf, createUpdater, newerThan, nudgeFor, parseSums, pickRelease, swapBlocker, SWAP_SCRIPT } from "../app/main/updater.mjs";

const DL = "https://github.com/adissocrazy/earpiece/releases/download/app-v0.4.0";
const ZIP = Buffer.from("pretend this is a zip");
const SHA = crypto.createHash("sha256").update(ZIP).digest("hex");
const release = (extra = {}) => ({
  tag_name: "app-v0.4.0",
  draft: false,
  html_url: "https://github.com/adissocrazy/earpiece/releases/tag/app-v0.4.0",
  assets: [
    { name: "Earpiece-0.4.0-universal.dmg", size: 10, browser_download_url: `${DL}/Earpiece-0.4.0-universal.dmg` },
    { name: "Earpiece-0.4.0-universal-mac.zip", size: ZIP.length, browser_download_url: `${DL}/Earpiece-0.4.0-universal-mac.zip`, digest: `sha256:${SHA}` },
  ],
  ...extra,
});

test("versions and release picking skip drafts, prereleases and other tags", () => {
  assert.equal(newerThan("0.4.0", "0.3.9"), true);
  assert.equal(newerThan("0.3.0", "0.3.0"), false);
  assert.equal(newerThan("0.10.0", "0.9.9"), true);
  const r = pickRelease([{ tag_name: "app-v9.0.0", draft: true }, { tag_name: "v1.0.0" }, { tag_name: "app-v0.5.0", prerelease: true }, release()], "0.3.0");
  assert.equal(r.latest, "0.4.0");
  assert.equal(r.newer, true);
  assert.equal(r.zip.sha256, SHA);
  assert.match(r.dmg.url, /\.dmg$/);
  // Assets that don't live under the repo's releases are ignored.
  const evil = pickRelease([release({ assets: [{ name: "x-mac.zip", browser_download_url: "https://evil.example/x-mac.zip" }] })], "0.3.0");
  assert.equal(evil.zip, null);
});

test("SHA256SUMS parsing and bundle paths", () => {
  const m = parseSums(`${SHA}  Earpiece-0.4.0-universal-mac.zip\n${"a".repeat(64)} *Earpiece.dmg\n`);
  assert.equal(m.get("Earpiece-0.4.0-universal-mac.zip"), SHA);
  assert.equal(m.get("Earpiece.dmg"), "a".repeat(64));
  assert.equal(bundleOf("/Applications/Earpiece.app/Contents/MacOS/Earpiece"), "/Applications/Earpiece.app");
  assert.equal(bundleOf("/usr/bin/node"), null);
});

test("the app won't try to replace itself from a disk image, a translocated copy or a read-only folder", () => {
  const yes = () => true;
  assert.equal(swapBlocker("/Applications/Earpiece.app", { writable: yes }), null);
  assert.match(swapBlocker("/Volumes/Earpiece/Earpiece.app", { writable: yes }), /disk image/);
  assert.match(swapBlocker("/private/var/folders/x/AppTranslocation/ABC/d/Earpiece.app", { writable: yes }), /temporary copy/);
  assert.match(swapBlocker("/Applications/Earpiece.app", { writable: () => false }), /can't write/);
  assert.match(swapBlocker("/Applications/Earpiece.app", { isPackaged: false }), /source/);
});

function fakeDeps(dir, { zip = ZIP, rel = release(), plist = { CFBundleIdentifier: "dev.earpiece.mac", CFBundleShortVersionString: "0.4.0" } } = {}) {
  const calls = { spawn: [], opened: [], quit: 0, run: [] };
  const deps = {
    version: "0.3.0",
    exePath: "/Applications/Earpiece.app/Contents/MacOS/Earpiece",
    isPackaged: true,
    tmpDir: dir,
    pid: 4242,
    writable: () => true,
    openExternal: async (u) => calls.opened.push(u),
    quit: () => calls.quit++,
    fetch: async (url) => {
      if (url.startsWith("https://api.github.com/")) return new Response(JSON.stringify([rel]), { status: 200 });
      if (url.endsWith(".zip")) return new Response(zip, { status: 200 });
      return new Response("", { status: 404 });
    },
    run: async (cmd, args) => {
      calls.run.push(cmd);
      if (cmd === "ditto") fs.mkdirSync(path.join(args[3], "Earpiece.app", "Contents"), { recursive: true });
      if (cmd === "plutil") return `${plist[args[1]]}\n`;
      return "";
    },
    spawn: (cmd, args) => (calls.spawn.push([cmd, ...args]), { unref() {} }),
  };
  return { deps, calls };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "earpiece-upd-"));

test("install: downloads, checks the hash, unpacks, checks the bundle, hands over to the swap script and quits", async () => {
  const dir = tmp();
  const { deps, calls } = fakeDeps(dir);
  const u = createUpdater(deps);
  const s = await u.check();
  assert.equal(s.newer, true);
  assert.equal(s.oneClick, true);
  await u.install();
  await new Promise((r) => setTimeout(r, 350));
  assert.deepEqual(calls.run, ["ditto", "plutil", "plutil", "codesign"]);
  assert.equal(calls.spawn.length, 1);
  const [sh, script, pid, newApp, dest, old] = calls.spawn[0];
  assert.equal(sh, "/bin/sh");
  assert.equal(fs.readFileSync(script, "utf8"), SWAP_SCRIPT);
  assert.equal(pid, "4242");
  assert.match(newApp, /unpacked\/Earpiece\.app$/);
  assert.equal(dest, "/Applications/Earpiece.app");
  assert.equal(old, "/Applications/Earpiece.app.old-4242");
  assert.equal(calls.quit, 1);
  assert.equal(u.state().status, "installing");
});

test("install refuses a download that doesn't match its checksum, or the wrong app", async () => {
  const { deps, calls } = fakeDeps(tmp(), { zip: Buffer.from("tampered!!!!!!!!!!!!!") });
  const u = createUpdater(deps);
  await u.install();
  assert.equal(u.state().status, "failed");
  assert.match(u.state().error, /checksum/);
  assert.equal(calls.spawn.length, 0);

  const other = fakeDeps(tmp(), { plist: { CFBundleIdentifier: "com.evil.app", CFBundleShortVersionString: "0.4.0" } });
  const u2 = createUpdater(other.deps);
  await u2.install();
  assert.match(u2.state().error, /not Earpiece/);
  assert.equal(other.calls.spawn.length, 0);
  assert.equal(other.calls.quit, 0);
});

test("without a checksum, or when it can't swap, Update opens the disk image instead", async () => {
  const rel = release();
  delete rel.assets[1].digest;
  const { deps, calls } = fakeDeps(tmp(), { rel });
  const u = createUpdater(deps);
  const s = await u.check();
  assert.equal(s.oneClick, false);
  assert.match(s.blocker, /checksum/);
  await u.install();
  assert.deepEqual(calls.opened, [`${DL}/Earpiece-0.4.0-universal.dmg`]);
  assert.equal(calls.spawn.length, 0);

  const ro = fakeDeps(tmp());
  ro.deps.exePath = "/Volumes/Earpiece/Earpiece.app/Contents/MacOS/Earpiece";
  const u2 = createUpdater(ro.deps);
  await u2.install();
  assert.equal(ro.calls.opened.length, 1);
  assert.equal(ro.calls.spawn.length, 0);
});

test("the swap script moves the new copy in, opens it, and keeps the old one if that fails", { skip: process.platform === "win32" }, () => {
  const dir = tmp();
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  // Stand-ins for the macOS tools the script calls.
  fs.writeFileSync(path.join(bin, "ditto"), '#!/bin/sh\ncp -R "$1" "$2"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "xattr"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "open"), `#!/bin/sh\necho "$1" >> "${dir}/opened"\nexit \${OPEN_FAIL:-0}\n`, { mode: 0o755 });
  const script = path.join(dir, "swap.sh");
  fs.writeFileSync(script, SWAP_SCRIPT, { mode: 0o700 });
  const setup = () => {
    for (const p of ["Earpiece.app", "new"]) fs.rmSync(path.join(dir, p), { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, "Earpiece.app"));
    fs.writeFileSync(path.join(dir, "Earpiece.app", "v"), "old");
    fs.mkdirSync(path.join(dir, "new", "Earpiece.app"), { recursive: true });
    fs.writeFileSync(path.join(dir, "new", "Earpiece.app", "v"), "new");
  };
  const go = (env = {}) => {
    const dest = path.join(dir, "Earpiece.app");
    return spawnSync("/bin/sh", [script, "999999", path.join(dir, "new", "Earpiece.app"), dest, `${dest}.old-1`, path.join(dir, "log")], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
    });
  };
  setup();
  assert.equal(go().status, 0);
  assert.equal(fs.readFileSync(path.join(dir, "Earpiece.app", "v"), "utf8"), "new");
  assert.equal(fs.existsSync(path.join(dir, "Earpiece.app.old-1")), false);

  setup();
  assert.equal(go({ OPEN_FAIL: "1" }).status, 1);
  assert.equal(fs.readFileSync(path.join(dir, "Earpiece.app", "v"), "utf8"), "old");

  // A backup path that isn't next to the app is refused before anything moves.
  setup();
  const bad = spawnSync("/bin/sh", [script, "999999", path.join(dir, "new", "Earpiece.app"), path.join(dir, "Earpiece.app"), "/tmp/elsewhere", path.join(dir, "log")]);
  assert.equal(bad.status, 1);
  assert.equal(fs.readFileSync(path.join(dir, "Earpiece.app", "v"), "utf8"), "old");
});

test("the notch announces each newer version once", () => {
  assert.equal(nudgeFor({ newer: true, latest: "0.5.0" }, undefined), "0.5.0");
  assert.equal(nudgeFor({ newer: true, latest: "0.5.0" }, "0.5.0"), null, "already told you about this one");
  assert.equal(nudgeFor({ newer: true, latest: "0.5.1" }, "0.5.0"), "0.5.1");
  assert.equal(nudgeFor({ newer: false, latest: "0.4.2" }, undefined), null);
  assert.equal(nudgeFor(null, undefined), null);
});
