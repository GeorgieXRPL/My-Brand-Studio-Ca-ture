/**
 * xAI Grok Imagine — video, still generation, and still editing.
 * Docs: https://docs.x.ai/developers/model-capabilities/imagine
 */

const XAI_BASE = "https://api.x.ai/v1";

export function imagineConfigured() {
  return Boolean(process.env.XAI_API_KEY?.trim());
}

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.XAI_API_KEY}`,
    "Content-Type": "application/json",
  };
}

export function videoModel() {
  // Latest Imagine video as of 2026-08: grok-imagine-video-1.5 ($0.08/s).
  return process.env.XAI_VIDEO_MODEL || "grok-imagine-video-1.5";
}

export function imageModel() {
  return process.env.XAI_IMAGE_MODEL || "grok-imagine-image";
}

/** @deprecated use VIDEO_LIMITS / STILL_LIMITS from plans.js */
export function imagineMonthlyLimit() {
  const n = Number(process.env.IMAGINE_MONTHLY_LIMIT);
  return Number.isFinite(n) && n > 0 ? n : 8;
}

const FILM_POST_PLATFORMS = new Set(["tiktok", "instagram", "snapchat"]);

/** Lightweight parse of HOOK:/BEAT:/ON_SCREEN:/CAPTION:/IMAGINE: labeled scripts. */
export function parseFilmLabels(raw) {
  const text = (raw || "").trim();
  if (!text) return { hook: "", beats: [], onScreen: "", keyword: "", caption: "", imagine: "", labeled: false };
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  let hook = "";
  let onScreen = "";
  let keyword = "";
  let caption = "";
  let imagine = "";
  const beats = [];
  const labeled = /^(hook|beat\s*\d*|on[-\s]?screen|caption|imagine)\s*[:\-\u2013]/im.test(text);
  for (const line of lines) {
    const m = line.match(
      /^(hook|beat\s*\d*|on[-\s]?screen|keyword|search|caption|imagine|prompt)\s*[:\-\u2013]\s*(.+)$/i
    );
    if (!m) continue;
    const label = m[1].toLowerCase();
    const body = m[2].trim();
    if (label.startsWith("hook")) hook = body;
    else if (label.startsWith("beat")) beats.push(body);
    else if (label.includes("screen")) onScreen = body;
    else if (label.startsWith("keyword") || label.startsWith("search")) keyword = body;
    else if (label.startsWith("caption")) caption = body;
    else if (label.startsWith("imagine") || label.startsWith("prompt")) imagine = body;
  }
  if (!hook) {
    const first = lines.find((l) => !/^#/.test(l) && !/^caption\b/i.test(l) && !/^imagine\b/i.test(l));
    hook = (first || text).slice(0, 160);
  }
  if (!caption && labeled) {
    caption = hook.split(/[.!?]/)[0].trim();
  }
  return { hook, beats, onScreen, keyword, caption, imagine, labeled };
}

/** Caption for Share/Post — never the full talk-track script on video platforms. */
export function extractPostCaption(raw, platform) {
  const text = (raw || "").trim();
  if (!text) return "";
  if (!FILM_POST_PLATFORMS.has(platform)) return text;
  const labels = parseFilmLabels(text);
  if (labels.labeled || /^caption\s*[:\-\u2013]/im.test(text)) {
    return (labels.caption || labels.hook || text).trim();
  }
  return text;
}

const NO_BURN =
  "Do not burn any captions, titles, watermarks, or on-screen text onto the video. Leave the frame clean for a separate caption overlay.";

/**
 * Strip any "paint/burn text into the frame" instructions (Claude or older clients).
 * Optionally recover the intended on-screen phrase from quoted burn clauses.
 */
export function sanitizeImaginePrompt(prompt, { forStill = false } = {}) {
  let text = String(prompt || "").trim();
  let extractedOnScreen = "";

  const burnQuoted =
    text.match(
      /\b(?:burn|paint|render|overlay|add)\b[\s\S]{0,80}?\b(?:text|caption|title|words?)\b[\s\S]{0,120}?[\u201c"']([^\u201c"']{3,120})[\u201d"']/i
    ) ||
    text.match(
      /\bBurn this exact text[\s\S]{0,160}?[\u201c"']([^\u201c"']{3,120})[\u201d"']/i
    );
  if (burnQuoted?.[1]) {
    extractedOnScreen = burnQuoted[1].replace(/\s+/g, " ").trim();
  }

  text = text
    .replace(/\bBurn this exact text[\s\S]*?(?=(?:\.\s)|$)/gi, " ")
    .replace(
      /\b(?:burn|paint|render)\b[\s\S]{0,40}?\b(?:this )?(?:exact )?(?:text|caption|title|words?)\b[\s\S]{0,200}?(?=(?:\.\s)|$)/gi,
      " "
    )
    .replace(/\blarge,?\s*readable[\s\S]{0,80}?high contrast\b[:\s]*/gi, " ")
    .replace(/\blower[-\s]?third or center\b[:\s,]*/gi, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+\./g, ".")
    .trim();

  const cleanNote = forStill
    ? "Do not burn any captions, titles, watermarks, or on-screen text onto the image. Leave the frame clean for a separate caption overlay."
    : NO_BURN;

  if (!/\bdo not burn\b/i.test(text)) {
    text = `${text} ${cleanNote}`.trim();
  }
  return {
    prompt: text.slice(0, 1800),
    extractedOnScreen: extractedOnScreen.slice(0, 80),
  };
}

/**
 * Build a vertical short-form video prompt from draft topic + film beats.
 * Pass short vibe / content_style / target_audience. Do not pass never-use lists.
 * brandVoice stays sliced to 200 chars.
 */
export function buildVideoPrompt({ topic, hook, beats, onScreen, keyword, brandVoice, vibe, content_style, target_audience }) {
  const beatLine = (beats || []).filter(Boolean).slice(0, 4).join("; ");
  const look = [vibe, content_style, target_audience]
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .join("; ");
  const parts = [
    "Vertical 9:16 short-form social video for TikTok/Reels.",
    "Energetic, mobile-first, natural motion, sharp detail, cinematic lighting.",
    NO_BURN,
    topic ? `Topic: ${topic}.` : "",
    hook ? `Opening hook energy: ${hook}.` : "",
    beatLine ? `Story beats: ${beatLine}.` : "",
    onScreen ? `Visual focus (no text overlay): ${onScreen}.` : "",
    keyword ? `Subtle theme keyword: ${keyword}.` : "",
    brandVoice ? `Brand vibe: ${String(brandVoice).slice(0, 200)}.` : "",
    look ? `Look and feel: ${look.slice(0, 240)}.` : "",
  ];
  return sanitizeImaginePrompt(parts.filter(Boolean).join(" ")).prompt;
}
