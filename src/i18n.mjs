// Spoken languages: prompt instructions, script checks and fixed phrases.

export const LANG_NAMES = {
  hi: "Hindi", mr: "Marathi", gu: "Gujarati", pa: "Punjabi", bn: "Bengali", or: "Odia",
  ta: "Tamil", te: "Telugu", kn: "Kannada", ml: "Malayalam", es: "Spanish", fr: "French",
  de: "German", it: "Italian", pt: "Portuguese", ru: "Russian", nl: "Dutch", pl: "Polish",
  ar: "Arabic", zh: "Mandarin Chinese", ja: "Japanese", ko: "Korean", id: "Indonesian",
  ms: "Malay", tr: "Turkish", vi: "Vietnamese", el: "Greek", fi: "Finnish", no: "Norwegian", sv: "Swedish",
};

export const isKnownLang = (code) => code === "en" || code === "hinglish" || Boolean(LANG_NAMES[code]);
export const langLabel = (code) => (code === "hinglish" ? "Hinglish" : LANG_NAMES[code] || "English");

// The Unicode script a summary in that language must contain. Catches an LLM that answers
// in English or in Latin transliteration, which TTS voices read badly.
export const SCRIPT = {
  hi: /[ऀ-ॿ]/, hinglish: /[ऀ-ॿ]/, mr: /[ऀ-ॿ]/, bn: /[ঀ-৿]/,
  or: /[଀-୿]/, gu: /[઀-૿]/, pa: /[਀-੿]/, ta: /[஀-௿]/,
  te: /[ఀ-౿]/, kn: /[ಀ-೿]/, ml: /[ഀ-ൿ]/, ar: /[؀-ۿ]/,
  ru: /[Ѐ-ӿ]/, el: /[Ͱ-Ͽ]/, zh: /[一-鿿]/, ja: /[぀-ヿ一-鿿]/,
  ko: /[가-힯]/,
};

export function langInstruction(lang) {
  if (!lang || lang === "en") return "Plain spoken English.";
  if (lang === "hinglish")
    return 'Write natural spoken Hinglish, the way an Indian developer talks: Hindi grammar and everyday words in Devanagari script, with technical terms and product or project names kept in English (Latin script). Never write Hindi in Latin letters. Example: "cart drawer का refactor हो गया, सारे tests pass हैं, बस free-shipping bar पर आपका input चाहिए।"';
  const name = LANG_NAMES[lang] || lang;
  const ex = lang === "hi" ? ' Example: "कार्ट ड्रॉअर का काम पूरा हो गया, सारे टेस्ट पास हैं।"' : "";
  return `Write it in simple spoken ${name} using its native script, never Latin transliteration. Keep product names and project names in English.${ex}`;
}

// Language code the TTS engines expect for a speakLanguage.
export const ttsLang = (lang) => (lang === "hinglish" ? "hi" : lang || "en");

// Fixed phrases, so non-summary pings match the chosen language too.
// To add a language, add a block with the same keys (falls back to English).
export const PHRASES = {
  en: {
    waiting: (p) => `${p} is waiting for you.`,
    permission: (p, tool) => `${p} needs your permission to use ${tool}.`,
    attention: (p, msg) => `${p} ${msg}`.replace(/\.*$/, "."),
    runOk: (p, l) => `${p}. ${l} finished.`,
    runFail: (p, l) => `${p}. ${l} failed.`,
    failed: (p) => `${p} hit an error.`,
    test: "Earpiece is on. You'll hear from me when your agents finish or need you.",
    remoteDone: (name) => `${name} is done.`,
    remoteNeeds: (name) => `${name} needs you.`,
    remoteQuestions: (name, n) => `${name} has ${n} ${Number(n) === 1 ? "question" : "questions"} waiting.`,
  },
  hinglish: {
    waiting: (p) => `${p} आपका wait कर रहा है।`,
    permission: (p, tool) => `${p} को ${tool} use करने की permission चाहिए।`,
    attention: (p) => `${p} को आपकी ज़रूरत है।`,
    runOk: (p, l) => `${p}. ${l} finish हो गया।`,
    runFail: (p, l) => `${p}. ${l} fail हो गया।`,
    failed: (p) => `${p} में error आया है।`,
    test: "Earpiece on है। जब भी आपके agents का काम पूरा होगा या उन्हें आपकी ज़रूरत होगी, मैं बता दूँगी।",
  },
  hi: {
    waiting: (p) => `${p} आपका इंतज़ार कर रहा है।`,
    permission: (p, tool) => `${p} को ${tool} इस्तेमाल करने की अनुमति चाहिए।`,
    attention: (p) => `${p} को आपकी ज़रूरत है।`,
    runOk: (p, l) => `${p}. ${l} पूरा हो गया।`,
    runFail: (p, l) => `${p}. ${l} विफल हो गया।`,
    failed: (p) => `${p} में त्रुटि आई है।`,
    test: "जार्विस तैयार है। जब आपके एजेंट का काम पूरा होगा या उन्हें आपकी ज़रूरत होगी, मैं बता दूँगी।",
  },
};

export function phrase(cfg, name, ...args) {
  const lang = PHRASES[cfg.speakLanguage]?.[name] ? cfg.speakLanguage : "en";
  const v = PHRASES[lang][name];
  return { text: typeof v === "function" ? v(...args) : v, lang };
}
