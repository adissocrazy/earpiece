// One-click updates. Looks for a newer `app-v*` release on GitHub, downloads its zip, checks the
// size and SHA-256, unpacks it, checks the bundle id, version and signature, and hands over to a
// small shell script that waits for Earpiece to quit, puts the new copy where the old one was,
// and opens it. If the app can't replace itself (it runs from the disk image, from a temporary
// "translocated" copy, or from a folder it can't write to), it opens the download instead.
//
// No Electron imports here: main.mjs passes in what it needs, so the logic can be tested in Node.
import { execFile, spawn as nodeSpawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const REPO = "adissocrazy/earpiece";
export const BUNDLE_ID = "dev.earpiece.mac";
const CHECK_EVERY_MS = 6 * 3600_000;
const FIRST_CHECK_MS = 8000;
const MAX_ZIP = 600 * 1024 * 1024;
const RELEASES = `https://github.com/${REPO}/releases`;

const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      err ? reject(Object.assign(err, { stderr: String(stderr || "") })) : resolve(String(stdout || "")),
    );
  });

// ---------- pure helpers (tested) ----------

const nums = (v) => String(v || "").split(/[.-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
/** Is version a newer than version b? Compares major.minor.patch. */
export function newerThan(a, b) {
  const [x, y] = [nums(a), nums(b)];
  return (x[0] - y[0] || x[1] - y[1] || x[2] - y[2]) > 0;
}

const HEX64 = /^[a-f0-9]{64}$/;
const okUrl = (u) => typeof u === "string" && u.startsWith(`${RELEASES}/`);

/** The newest published app release and the files a one-click update needs from it. */
export function pickRelease(releases, current) {
  const rel = (Array.isArray(releases) ? releases : []).find((r) => r && !r.draft && !r.prerelease && /^app-v\d/.test(r.tag_name || ""));
  if (!rel) return { current, latest: null, newer: false };
  const latest = rel.tag_name.replace(/^app-v/, "");
  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const find = (re) => assets.find((a) => re.test(a?.name || "") && okUrl(a.browser_download_url));
  const zip = find(/-mac\.zip$/i);
  const dmg = find(/\.dmg$/i);
  const sums = find(/^SHA256SUMS(\.txt)?$/i);
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(zip?.digest || "")?.[1]?.toLowerCase() || null;
  return {
    current,
    latest,
    newer: newerThan(latest, current),
    url: okUrl(rel.html_url) ? rel.html_url : RELEASES,
    notes: String(rel.body || "").slice(0, 2000),
    zip: zip ? { name: zip.name, size: Number(zip.size) || 0, url: zip.browser_download_url, sha256: digest } : null,
    dmg: dmg ? { name: dmg.name, url: dmg.browser_download_url } : null,
    sumsUrl: sums?.browser_download_url || null,
  };
}

/** The version to announce in the notch: a newer release you haven't been told about yet, else null. */
export function nudgeFor(state, lastNudged) {
  return state?.newer && state.latest && state.latest !== lastNudged ? state.latest : null;
}

/** `shasum -a 256` output: "<hex>  <name>" per line. */
export function parseSums(text) {
  const out = new Map();
  for (const line of String(text || "").split("\n")) {
    const m = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (m) out.set(path.basename(m[2]), m[1].toLowerCase());
  }
  return out;
}

/** /Applications/Earpiece.app/Contents/MacOS/Earpiece → /Applications/Earpiece.app */
export function bundleOf(exe) {
  const m = /^(\/.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(String(exe || ""));
  return m ? m[1] : null;
}

/** Why the app can't swap itself in place, or null when it can. */
export function swapBlocker(bundle, { isPackaged = true, writable = defaultWritable } = {}) {
  if (!isPackaged) return "This copy runs from source. Pull and rebuild it instead.";
  if (!bundle) return "Couldn't find where Earpiece is installed.";
  if (bundle.includes("/AppTranslocation/")) return "macOS is running Earpiece from a temporary copy. Move it to Applications, open it from there, then update.";
  if (bundle.startsWith("/Volumes/")) return "Earpiece is running from the disk image. Drag it to Applications, open it from there, then update.";
  if (!writable(path.dirname(bundle)) || !writable(bundle)) return `Earpiece can't write to ${path.dirname(bundle)}.`;
  return null;
}

function defaultWritable(p) {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Runs after Earpiece quits. Arguments: app pid, new .app, installed .app, backup path, log file.
// Paths only ever arrive as arguments.
export const SWAP_SCRIPT = `#!/bin/sh
pid="$1"; new="$2"; dest="$3"; old="$4"; logf="$5"
exec >>"$logf" 2>&1
case "$dest" in /*.app) ;; *) echo "bad destination"; exit 1;; esac
case "$old" in "$dest".old-*) ;; *) echo "bad backup path"; exit 1;; esac
n=0
while kill -0 "$pid" 2>/dev/null; do
  n=$((n+1))
  if [ "$n" -gt 600 ]; then echo "Earpiece did not quit"; exit 1; fi
  sleep 0.1
done
if ! mv "$dest" "$old"; then echo "could not move the old copy"; open "$dest"; exit 1; fi
if ditto "$new" "$dest"; then
  xattr -dr com.apple.quarantine "$dest" 2>/dev/null
  if open "$dest"; then rm -rf "$old"; echo "updated"; exit 0; fi
  rm -rf "$dest"
fi
mv "$old" "$dest"
open "$dest"
echo "update failed, kept the old copy"
exit 1
`;

// ---------- the updater ----------

/**
 * deps: { version, exePath, isPackaged, tmpDir, pid, log, openExternal, quit, onChange,
 *         fetch?, run?, spawn?, writable? }
 */
export function createUpdater(deps) {
  const fetchImpl = deps.fetch || fetch;
  const runCmd = deps.run || run;
  const spawn = deps.spawn || nodeSpawn;
  const bundle = bundleOf(deps.exePath);
  let info = null; // pickRelease() result
  let st = { status: "idle", progress: 0, error: null, checkedAt: 0 };
  let timer = null;
  let busy = null;

  const set = (patch) => {
    st = { ...st, ...patch };
    deps.onChange?.(state());
  };

  function state() {
    const blocker = swapBlocker(bundle, { isPackaged: deps.isPackaged, writable: deps.writable });
    return {
      current: deps.version,
      latest: info?.latest || null,
      newer: Boolean(info?.newer),
      url: info?.url || RELEASES,
      status: st.status,
      progress: st.progress,
      error: st.error,
      checkedAt: st.checkedAt,
      // One click works when the app can swap itself and the release has a zip with a checksum.
      oneClick: Boolean(info?.newer && !blocker && info.zip && (info.zip.sha256 || info.sumsUrl)),
      blocker: info?.newer ? blocker || (!info.zip ? "This release has no zip to install from." : !(info.zip.sha256 || info.sumsUrl) ? "This release has no checksum, so the download can't be checked." : null) : null,
    };
  }

  async function check() {
    if (["downloading", "verifying", "installing"].includes(st.status)) return state();
    set({ status: "checking", error: null });
    try {
      const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases?per_page=20`, {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`GitHub said ${res.status}`);
      info = pickRelease(await res.json(), deps.version);
      set({ status: info.newer ? "available" : "current", checkedAt: Date.now() });
    } catch (e) {
      set({ status: info?.newer ? "available" : "idle", error: `Couldn't check for updates: ${e.message}`, checkedAt: Date.now() });
    }
    return state();
  }

  function start() {
    clearTimeout(timer);
    const loop = async () => {
      await check();
      timer = setTimeout(loop, CHECK_EVERY_MS);
      timer.unref?.();
    };
    timer = setTimeout(loop, FIRST_CHECK_MS);
    timer.unref?.();
  }

  /** Open the disk image (or the release page) in the browser: the manual way. */
  function openDownload() {
    const url = info?.dmg?.url || info?.url || RELEASES;
    if (!url.startsWith(RELEASES)) throw new Error("not allowed");
    return deps.openExternal(url);
  }

  async function expectedHash() {
    if (info.zip.sha256) return info.zip.sha256;
    const res = await fetchImpl(info.sumsUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`checksum file: ${res.status}`);
    const h = parseSums(await res.text()).get(info.zip.name);
    if (!h || !HEX64.test(h)) throw new Error("the checksum file doesn't list the zip");
    return h;
  }

  async function download(to) {
    const res = await fetchImpl(info.zip.url, { signal: AbortSignal.timeout(15 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`download: ${res.status}`);
    const total = info.zip.size || Number(res.headers.get("content-length")) || 0;
    const hash = crypto.createHash("sha256");
    let got = 0;
    let lastPush = 0;
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        got += chunk.length;
        if (got > MAX_ZIP || (total && got > total)) return cb(new Error("the download is bigger than the release says"));
        hash.update(chunk);
        if (total && Date.now() - lastPush > 1000) (lastPush = Date.now(), set({ progress: Math.min(got / total, 1) }));
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(to, { mode: 0o600 }));
    if (info.zip.size && got !== info.zip.size) throw new Error(`the download is ${got} bytes, the release says ${info.zip.size}`);
    return hash.digest("hex");
  }

  async function unpackAndCheck(zip, dir) {
    const out = path.join(dir, "unpacked");
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    await runCmd("ditto", ["-x", "-k", zip, out]);
    const name = fs.readdirSync(out).find((f) => f.endsWith(".app"));
    if (!name) throw new Error("the zip has no app in it");
    const app = path.join(out, name);
    const plist = path.join(app, "Contents", "Info.plist");
    const read = async (key) => (await runCmd("plutil", ["-extract", key, "raw", "-o", "-", plist])).trim();
    const id = await read("CFBundleIdentifier");
    if (id !== BUNDLE_ID) throw new Error(`the zip holds ${id}, not Earpiece`);
    const ver = await read("CFBundleShortVersionString");
    if (ver !== info.latest) throw new Error(`the zip holds version ${ver}, expected ${info.latest}`);
    await runCmd("codesign", ["--verify", "--deep", "--strict", app]);
    return app;
  }

  async function install() {
    if (busy) return busy;
    busy = (async () => {
      if (!info?.newer) await check();
      const s = state();
      if (!s.newer) return s;
      if (!s.oneClick) {
        await openDownload();
        return s;
      }
      const dir = path.join(deps.tmpDir, `earpiece-update-${info.latest}`);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        set({ status: "downloading", progress: 0, error: null });
        const want = await expectedHash();
        const zip = path.join(dir, info.zip.name.replace(/[^\w.-]/g, "_"));
        const got = await download(zip);
        if (got !== want) throw new Error("the download doesn't match its checksum");
        set({ status: "verifying", progress: 1 });
        const newApp = await unpackAndCheck(zip, dir);
        const script = path.join(dir, "swap.sh");
        fs.writeFileSync(script, SWAP_SCRIPT, { mode: 0o700 });
        set({ status: "installing" });
        const child = spawn("/bin/sh", [script, String(deps.pid), newApp, bundle, `${bundle}.old-${deps.pid}`, path.join(dir, "update.log")], { detached: true, stdio: "ignore" });
        child.unref?.();
        deps.log?.({ info: `app update: installing ${info.latest} over ${deps.version}` });
        setTimeout(() => deps.quit(), 300);
      } catch (e) {
        deps.log?.({ error: `app update: ${e.message}` });
        set({ status: "failed", error: `Update failed: ${e.message}`, progress: 0 });
      }
      return state();
    })().finally(() => (busy = null));
    return busy;
  }

  return { state, check, start, install, openDownload, stop: () => clearTimeout(timer) };
}
