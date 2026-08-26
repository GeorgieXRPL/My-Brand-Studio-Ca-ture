import type { Platform } from "./types";

/** Platforms where a short-form film helper is useful. */
export const FILM_PLATFORMS: Platform[] = ["tiktok", "instagram", "snapchat", "youtube"];

export type FilmGuide = {
  hook: string;
  beats: string[];
  onScreen: string;
  keyword: string;
  caption: string;
  imagine: string;
  /** Full spoken talk-track (hook + beats), ready to copy. */
  talkTrack: string;
  /** True when HOOK:/BEAT:/CAPTION: style labels were found. */
  labeled: boolean;
};

export type FilmEdit = {
  caption: string;
  imagine: string;
  onScreen: string;
  /** Apply deterministic on-screen overlay after generation (hub draws text). */
  burnIn: boolean;
  /** Stamp the Brand Brain watermark on still/video output. */
  watermark?: boolean;
  /** Optional TTS / delivery voice id, or "none". */
  voiceId?: string;
};

/** Voice styles for talk-track delivery + Studio AI clip narration. */
export type VoiceStyle = {
  id: string;
  label: string;
  vibe: string;
  example: string;
};

export const VOICE_STYLES: VoiceStyle[] = [
  {
    id: "eve",
    label: "Eve",
    vibe: "Energetic & upbeat",
    example: "Stop scrolling — this tip takes ten seconds and actually works.",
  },
  {
    id: "ara",
    label: "Ara",
    vibe: "Warm & conversational",
    example: "Hey, real talk — here's what I'd try first.",
  },
  {
    id: "rex",
    label: "Rex",
    vibe: "Confident & clear",
    example: "Three moves. Do these and you'll feel the difference today.",
  },
  {
    id: "sal",
    label: "Sal",
    vibe: "Smooth & balanced",
    example: "Quick walkthrough — keep it simple and stick with it.",
  },
  {
    id: "leo",
    label: "Leo",
    vibe: "Authoritative & strong",
    example: "Listen up. This is the part most people skip — and it matters.",
  },
];

export function getVoiceStyle(id?: string | null): VoiceStyle | null {
  if (!id || id === "none") return null;
  return VOICE_STYLES.find((v) => v.id === id) || null;
}

/** Talk track copy with optional voice-style delivery note. */
export function formatTalkTrackCopy(talkTrack: string, voiceId?: string | null): string {
  const body = String(talkTrack || "").trim();
  const style = getVoiceStyle(voiceId);
  if (!style) return body;
  return [
    `Voice style: ${style.label} — ${style.vibe}`,
    `Speak like: "${style.example}"`,
    "",
    body,
  ].join("\n");
}

const LABEL =
  /^(hook|beat\s*\d*|on[-\s]?screen|on\s*screen|caption|keyword|visual|spoken|search|imagine|prompt|title)\s*[:\-–]\s*/i;

function cleanLine(line: string): string {
  return line.replace(LABEL, "").replace(/^[\d]+[\).\]]\s*/, "").replace(/^[-*•]\s*/, "").trim();
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8);
}

function isLabeledScript(text: string): boolean {
  return /^(hook|beat\s*\d*|on[-\s]?screen|caption|imagine)\s*[:\-–]/im.test(text);
}

/** Strip double hyphens from copy shown / saved in the app. */
export function sanitizeClientCopy(text: string): string {
  return String(text || "")
    .replace(/\u2014|\u2013/g, " - ")
    .replace(/--+/g, " - ")
    .replace(/\s+-\s+/g, " - ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Turn a TikTok / Reels / Snap script-or-caption into a filmable guide.
 */
export function buildFilmGuide(raw: string, platform: Platform): FilmGuide | null {
  const text = sanitizeClientCopy(raw || "").trim();
  if (!text || !FILM_PLATFORMS.includes(platform)) return null;

  const lines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  let hook = "";
  let onScreen = "";
  let keyword = "";
  let caption = "";
  let imagine = "";
  const beats: string[] = [];
  const labeled = isLabeledScript(text);

  for (const line of lines) {
    const lower = line.toLowerCase();
    const body = cleanLine(line);
    if (!body) continue;

    if (/^hook\b/i.test(line) || lower.startsWith("hook:")) {
      hook = body;
      continue;
    }
    if (/^beat\b/i.test(line) || /^spoken\b/i.test(line)) {
      beats.push(body);
      continue;
    }
    if (/^imagine\b|^prompt\b/i.test(line)) {
      imagine = body;
      continue;
    }
    if (/^caption\b/i.test(line)) {
      caption = body;
      continue;
    }
    if (/^on[-\s]?screen\b|^on\s+screen\b/i.test(line)) {
      onScreen = body;
      continue;
    }
    if (/^keyword\b|^search\b/i.test(line)) {
      keyword = body;
      continue;
    }
    if (/^title\b/i.test(line)) {
      continue;
    }
    if (/^#\w+/.test(body) && body.split(/\s+/).every((w) => w.startsWith("#"))) continue;
  }

  if (!hook) {
    const nonTag = lines.map(cleanLine).filter((l) => l && !l.split(/\s+/).every((w) => w.startsWith("#")));
    if (nonTag[0]) hook = nonTag[0].slice(0, 200);
    if (!beats.length) {
      const rest = nonTag.slice(1).join(" ");
      const parts = rest ? sentences(rest).slice(0, 4) : [];
      if (parts.length) beats.push(...parts);
      else if (nonTag.length > 1) beats.push(...nonTag.slice(1, 5));
    }
  }

  if (!beats.length && hook) {
    const more = sentences(text).filter((s) => s !== hook).slice(0, 3);
    beats.push(...more);
  }

  if (!onScreen) {
    onScreen = hook.split(/[.!?]/)[0].trim() || hook.trim();
  }
  // Keep overlay short for the hub renderer
  onScreen = onScreen.split(/\s+/).slice(0, 8).join(" ").slice(0, 72);

  if (!keyword) {
    const words = hook
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 3);
    keyword = words.join(" ");
  }

  if (!caption) {
    if (labeled) {
      const hashLine = lines.find((l) => l.split(/\s+/).filter(Boolean).every((w) => w.startsWith("#")));
      caption = [hook.split(/[.!?]/)[0].trim(), hashLine].filter(Boolean).join("\n\n");
    } else {
      caption = text;
    }
  }

  if (!hook && !beats.length && !caption) return null;

  const talkTrack = [hook, ...beats].filter(Boolean).join("\n\n");

  if (!imagine) {
    imagine = buildDefaultImaginePrompt({
      topic: "",
      hook,
      beats,
      onScreen,
      keyword,
    });
  }

  return {
    hook: hook || beats[0] || "",
    beats: beats.slice(0, 5),
    onScreen,
    keyword,
    caption: sanitizeClientCopy(caption),
    imagine: sanitizeClientCopy(imagine),
    talkTrack,
    labeled,
  };
}

export function buildDefaultImaginePrompt(parts: {
  topic?: string;
  hook?: string;
  beats?: string[];
  onScreen?: string;
  keyword?: string;
}): string {
  const beatLine = (parts.beats || []).filter(Boolean).slice(0, 4).join("; ");
  return [
    "Vertical 9:16 short-form social video for TikTok/Reels.",
    "Energetic, mobile-first, natural motion, sharp detail.",
    "Do not burn any captions, titles, watermarks, or on-screen text onto the video. Leave the frame clean for a separate caption overlay.",
    parts.topic ? `Topic: ${parts.topic}.` : "",
    parts.hook ? `Opening energy: ${parts.hook}.` : "",
    beatLine ? `Beats: ${beatLine}.` : "",
    parts.onScreen ? `Visual focus (no text overlay): ${parts.onScreen}.` : "",
    parts.keyword ? `Theme: ${parts.keyword}.` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 1800);
}

/**
 * Final Imagine prompt — never asks the model to paint text (hub overlays it).
 */
export function resolveImaginePrompt(edit: FilmEdit, film: FilmGuide, topic?: string): string {
  const base = (edit.imagine || film.imagine || "").trim();
  const onScreen = (edit.onScreen || film.onScreen || "").trim();

  let cleaned = base
    .replace(/\bBurn this exact text[\s\S]*?(?=(?:\.\s)|$)/gi, " ")
    .replace(
      /\b(?:burn|paint|render)\b[\s\S]{0,40}?\b(?:this )?(?:exact )?(?:text|caption|title|words?)\b[\s\S]{0,200}?(?=(?:\.\s)|$)/gi,
      " "
    )
    .replace(/\blarge,?\s*readable[\s\S]{0,80}?high contrast\b[:\s]*/gi, " ")
    .replace(/\bDo not burn any captions[^.]+\./gi, "")
    .replace(/\bNo burned-in captions or watermarks\.?/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+\./g, ".")
    .trim();

  if (!cleaned) {
    return buildDefaultImaginePrompt({
      topic,
      hook: film.hook,
      beats: film.beats,
      onScreen,
      keyword: film.keyword,
    });
  }

  if (onScreen && !/visual focus/i.test(cleaned)) {
    cleaned = `${cleaned} Visual focus (no text overlay): ${onScreen}.`;
  }

  return `${cleaned} Do not burn any captions, titles, watermarks, or on-screen text onto the video.`
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 1800);
}

export function extractShareCaption(raw: string, platform: Platform): string {
  const text = sanitizeClientCopy(raw || "").trim();
  if (!text) return "";
  if (!FILM_PLATFORMS.includes(platform)) return text;

  const guide = buildFilmGuide(text, platform);
  if (!guide) return text;

  if (guide.labeled || /^caption\s*[:\-–]/im.test(text)) {
    return (guide.caption || guide.hook || text).trim();
  }

  return text;
}

export function mergeFilmEditsIntoScript(
  raw: string,
  edits: { caption?: string; imagine?: string; onScreen?: string },
  film: FilmGuide | null
): string {
  const text = (raw || "").trim();
  const caption = sanitizeClientCopy(edits.caption ?? film?.caption ?? "");
  const imagine = sanitizeClientCopy(edits.imagine ?? film?.imagine ?? "");
  const onScreen = sanitizeClientCopy(edits.onScreen ?? film?.onScreen ?? "")
    .split(/\s+/)
    .slice(0, 8)
    .join(" ");

  if (!text && !caption && !imagine) return "";

  if (text && !isLabeledScript(text) && caption && edits.caption !== undefined) {
    return caption;
  }

  const lines = text ? text.split(/\n/) : [];
  const out: string[] = [];
  let sawCaption = false;
  let sawImagine = false;
  let sawOnScreen = false;

  for (const line of lines) {
    if (/^\s*caption\s*[:\-–]/i.test(line)) {
      if (caption) out.push(`CAPTION: ${caption}`);
      sawCaption = true;
      continue;
    }
    if (/^\s*(imagine|prompt)\s*[:\-–]/i.test(line)) {
      if (imagine) out.push(`IMAGINE: ${imagine}`);
      sawImagine = true;
      continue;
    }
    if (/^\s*on[-\s]?screen\s*[:\-–]/i.test(line)) {
      if (onScreen) out.push(`ON_SCREEN: ${onScreen}`);
      sawOnScreen = true;
      continue;
    }
    out.push(line);
  }

  if (!text && film) {
    const block = [
      film.hook ? `HOOK: ${film.hook}` : "",
      ...film.beats.map((b, i) => `BEAT ${i + 1}: ${b}`),
      onScreen ? `ON_SCREEN: ${onScreen}` : "",
      film.keyword ? `KEYWORD: ${film.keyword}` : "",
      imagine ? `IMAGINE: ${imagine}` : "",
      caption ? `CAPTION: ${caption}` : "",
    ].filter(Boolean);
    return block.join("\n");
  }

  if (!sawOnScreen && onScreen) out.push(`ON_SCREEN: ${onScreen}`);
  if (!sawImagine && imagine) out.push(`IMAGINE: ${imagine}`);
  if (!sawCaption && caption) out.push(`CAPTION: ${caption}`);
  return out.join("\n").trim();
}

/** Preview wrap for the Drafts UI (matches hub overlay). */
export function previewOverlayLines(text: string, maxChars = 18): string[] {
  const words = sanitizeClientCopy(text).split(/\s+/).filter(Boolean).slice(0, 8);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length >= 3) break;
    } else cur = next;
  }
  if (cur && lines.length < 3) lines.push(cur);
  return lines.slice(0, 3);
}
