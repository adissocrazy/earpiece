// Remote strings are untrusted data. They are cleaned before the registry, the card, the log
// and the voice. The spoken form also loses URLs, secrets and any leading "Claude Code:" claim,
// then the bridge prepends the paired name so the line cannot impersonate a local agent.
import { phrase } from "../i18n.mjs";
import { redact } from "../util.mjs";

const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const IDENTITY = /^(?:claude(?: code)?|codex|earpiece|system|warning|alert)\b[:,-]\s*/i;

// Letters that look like Latin, so "Сlаυde" (Cyrillic) cannot be paired as a local agent.
const HOMO = {
  "\u0430": "a", "\u03b1": "a", "\u00e0": "a", "\u00e1": "a", "\u00e2": "a", "\u00e4": "a", "\u00e5": "a",
  "\u0441": "c", "\u03f2": "c", "\u00e7": "c",
  "\u0501": "d", "\u0111": "d",
  "\u0435": "e", "\u0451": "e", "\u03b5": "e", "\u00e8": "e", "\u00e9": "e", "\u00ea": "e", "\u00eb": "e",
  "\u0261": "g", "\u011f": "g",
  "\u04bb": "h", "\u0127": "h",
  "\u0456": "i", "\u03b9": "i", "\u00ec": "i", "\u00ed": "i", "\u00ee": "i", "\u00ef": "i", "\u0131": "i",
  "\u04cf": "l", "\u0142": "l",
  "\u043c": "m",
  "\u0578": "n", "\u00f1": "n",
  "\u043e": "o", "\u03bf": "o", "\u00f2": "o", "\u00f3": "o", "\u00f4": "o", "\u00f6": "o", "\u00f8": "o",
  "\u0440": "p", "\u03c1": "p",
  "\u0433": "r",
  "\u0455": "s", "\u015b": "s",
  "\u0442": "t", "\u0163": "t",
  "\u0443": "u", "\u03c5": "u", "\u00f9": "u", "\u00fa": "u", "\u00fc": "u",
  "\u0445": "x", "\u03c7": "x",
  "\u0443": "y", "\u00fd": "y", "\u00ff": "y",
  0: "o", 1: "l", 3: "e", 5: "s",
};

const RESERVED = new Set(["claude", "claudecode", "codex", "earpiece", "system", "terminal", "macos"]);

/** NFKC, strip bidi and zero-width and other controls, collapse whitespace, redact. */
export function clean(s, max = 2000) {
  let t = String(s ?? "").normalize("NFKC").replace(CONTROLS, "");
  t = t.replace(/\s+/g, " ").trim();
  t = redact(t);
  if ([...t].length > max) t = [...t].slice(0, max).join("").trim();
  return t;
}

function clampWords(t, max = 200) {
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > 80 ? cut.slice(0, sp) : cut).trim();
}

/**
 * The words to speak, before the paired name is prepended. URLs, emails and long numbers
 * are not read out. An empty result means the caller should use the fixed phrase.
 */
export function speakable(s) {
  let t = clean(s, 2000);
  t = t.replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)]*\)/gi, "$1");
  t = t.replace(/https?:\/\/\S+/gi, "a link");
  t = t.replace(/\bwww\.\S+/gi, "a link");
  t = t.replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "an email address");
  t = t.replace(/\d{8,}/g, "a number");
  t = t.replace(/\{\{[^}]*\}\}/g, " ");
  t = t.replace(/<[^>]*>/g, " ");
  t = t.replace(/[*_~`#>]+/g, " ");
  t = t.replace(IDENTITY, "");
  t = t.replace(/\s+/g, " ").trim();
  return clampWords(t, 200);
}

/** "Avery is done" / "Avery needs you" when sanitizing left nothing worth saying. */
export function fixedLine(cfg, name, status) {
  const key = status === "needs_you" ? "remoteNeeds" : "remoteDone";
  return phrase(cfg || {}, key, name || "Remote").text;
}

export function questionsLine(cfg, name, n) {
  return phrase(cfg || {}, "remoteQuestions", name || "Remote", n).text;
}

/**
 * The sentence processEvent will speak verbatim. The hub does not prefix an explicit `line`
 * (announceAgent only affects the summary and phrase paths), so the paired name is added here.
 */
export function spokenLine({ name, title, status, body, question }) {
  const who = name || "Remote";
  const said = String(body || "").trim();
  if (!said) return fixedLine({}, who, status);
  if (status === "needs_you" && !question) return `${who} needs you: ${said}`;
  const label = title || who;
  return `${who}, ${label}. ${said}`;
}

export function nameSkeleton(name) {
  const n = String(name || "").normalize("NFKC").toLowerCase();
  let s = "";
  for (const ch of n) {
    if (/[\s._-]/.test(ch)) continue;
    s += HOMO[ch] || ch;
  }
  return s.replace(/[^a-z]/g, "");
}

/** True when a paired name would impersonate a local agent, including homoglyphs. */
export function reservedName(name) {
  const s = nameSkeleton(name);
  return !s || RESERVED.has(s);
}
