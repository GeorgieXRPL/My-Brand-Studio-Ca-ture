import type { Platform } from "./types";

/** Platforms where a short-form film helper is useful. */
export const FILM_PLATFORMS: Platform[] = ["tiktok", "instagram", "snapchat"];

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
  /** Burn on-screen text into the generated clip/still. */
  burnIn: boolean;
};

const LABEL =
  /^(hook|beat\s*\d*|on[-\s]?screen|on\s*screen|caption|keyword|visual|spoken|search|imagine|prompt)\s*[:\-–]\s*/i;

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

/**
 * Turn a TikTok / Reels / Snap script-or-caption into a filmable guide.
 * Works with structured "HOOK:" lines or freeform AI scripts.
 */
export function buildFilmGuide(raw: string, platform: Platform): FilmGuide | null {
  const text = (raw || "").trim();
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

  // Full hook punchline as on-screen fallback — do not truncate for display.
  if (!onScreen) {
    onScreen = hook.split(/[.!?]/)[0].trim() || hook.trim();
  }

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
      burnIn: true,
    });
  }

  return {
    hook: hook || beats[0] || "",
    beats: beats.slice(0, 5),
    onScreen,
    keyword,
    caption,
    imagine,
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
  burnIn?: boolean;
}): string {
  const beatLine = (parts.beats || []).filter(Boolean).slice(0, 4).join("; ");
  const burnIn = parts.burnIn !== false;
  const textLine =
    burnIn && parts.onScreen
      ? `Burn this exact text clearly onto the video (large, readable, lower-third or center, high contrast): "${parts.onScreen}".`
      : "Do not burn any captions, titles, or watermarks onto the video.";

  return [
    "Vertical 9:16 short-form social video for TikTok/Reels.",
    "Energetic, mobile-first, natural motion.",
    textLine,
    parts.topic ? `Topic: ${parts.topic}.` : "",
    parts.hook ? `Opening energy: ${parts.hook}.` : "",
    beatLine ? `Beats: ${beatLine}.` : "",
    !burnIn && parts.onScreen ? `Visual focus (no text overlay): ${parts.onScreen}.` : "",
    parts.keyword ? `Theme: ${parts.keyword}.` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 1800);
}

/**
 * Final prompt sent to Imagine — applies burn-in instruction from current edits.
 */
export function resolveImaginePrompt(edit: FilmEdit, film: FilmGuide, topic?: string): string {
  const base = (edit.imagine || film.imagine || "").trim();
  const onScreen = (edit.onScreen || film.onScreen || "").trim();

  // Strip prior burn-in / no-burn instructions so we can re-apply cleanly
  const cleaned = base
    .replace(/\bBurn this exact text[^.]+\./gi, "")
    .replace(/\bDo not burn any captions[^.]+\./gi, "")
    .replace(/\bNo burned-in captions or watermarks\.?/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!cleaned) {
    return buildDefaultImaginePrompt({
      topic,
      hook: film.hook,
      beats: film.beats,
      onScreen,
      keyword: film.keyword,
      burnIn: edit.burnIn,
    });
  }

  const burnLine = edit.burnIn
    ? onScreen
      ? `Burn this exact text clearly onto the video (large, readable, lower-third or center, high contrast): "${onScreen}".`
      : ""
    : "Do not burn any captions, titles, or watermarks onto the video.";

  return [cleaned, burnLine].filter(Boolean).join(" ").slice(0, 1800);
}

/**
 * Text that should go on the clipboard / into the platform description box.
 * Never the full HOOK/BEAT talk track when a labeled script is present.
 */
export function extractShareCaption(raw: string, platform: Platform): string {
  const text = (raw || "").trim();
  if (!text) return "";
  if (!FILM_PLATFORMS.includes(platform)) return text;

  const guide = buildFilmGuide(text, platform);
  if (!guide) return text;

  if (guide.labeled || /^caption\s*[:\-–]/im.test(text)) {
    return (guide.caption || guide.hook || text).trim();
  }

  return text;
}

/** Upsert CAPTION: / IMAGINE: / ON_SCREEN: into a platform script. */
export function mergeFilmEditsIntoScript(
  raw: string,
  edits: { caption?: string; imagine?: string; onScreen?: string },
  film: FilmGuide | null
): string {
  const text = (raw || "").trim();
  const caption = (edits.caption ?? film?.caption ?? "").trim();
  const imagine = (edits.imagine ?? film?.imagine ?? "").trim();
  const onScreen = (edits.onScreen ?? film?.onScreen ?? "").trim();

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

  if (!sawOnScreen && onScreen) {
    // Insert after beats / hook when possible — append is fine
    out.push(`ON_SCREEN: ${onScreen}`);
  }
  if (!sawImagine && imagine) out.push(`IMAGINE: ${imagine}`);
  if (!sawCaption && caption) out.push(`CAPTION: ${caption}`);
  return out.join("\n").trim();
}
