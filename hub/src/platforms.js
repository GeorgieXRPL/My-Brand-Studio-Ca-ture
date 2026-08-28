/**
 * Destinations we write captions for.
 * Direct Post APIs stay on UNIFIED_PLATFORMS; the rest use the phone share sheet.
 */

export const DEFAULT_ENABLED_PLATFORMS = [
  "x",
  "facebook",
  "tiktok",
  "snapchat",
  "instagram",
  "linkedin",
  "youtube",
];

/** Pre-Shorts default. Exact match is upgraded to include YouTube. */
const LEGACY_DEFAULT_PLATFORMS = [
  "x",
  "facebook",
  "tiktok",
  "snapchat",
  "instagram",
  "linkedin",
];

export const PLATFORMS = [
  ...DEFAULT_ENABLED_PLATFORMS,
  "reddit",
  "threads",
  "pinterest",
  "nextdoor",
];

const GUIDANCE = {
  x: "a punchy post OR a short thread (use line breaks). Max ~280 chars per tweet; if a thread, separate tweets with a blank line. Conversational, hook first — write for replies and bookmarks.",
  facebook:
    "a slightly longer, warmer post with a clear hook and a light call to engage. 1-3 short paragraphs. Sound native to FB, not a copy-paste of Instagram.",
  tiktok: `a short-form VIDEO script using this exact labeled format (one line each):
  HOOK: (spoken in first 1–1.5s)
  BEAT 1: …
  BEAT 2: …
  BEAT 3: …
  ON_SCREEN: (max 6-8 plain words for a lower-third caption — no periods, no emojis, no invented words; exact short phrase only)
  KEYWORD: (1–3 search-friendly spoken words)
  IMAGINE: (1–2 sentences describing visuals/motion ONLY — never mention text, captions, titles, burn-in, or on-screen words; the app stamps ON_SCREEN separately)
  CAPTION: (short post caption + a few hashtags — this is what gets pasted when sharing, NOT the script)
  Keep it energetic and filmable in ~15–30 seconds. Never use double hyphens (--); use commas or periods.`,
  snapchat: "a casual, in-the-moment caption for a snap (1-2 lines) plus a suggested visual.",
  instagram:
    "prefer a Reels-ready block when the idea is visual — same HOOK / BEAT / ON_SCREEN / KEYWORD / CAPTION labels as TikTok when it fits; otherwise a caption with a hook line, 2-4 short lines of value, a CTA for saves/DMs, and 5-10 hashtags on a new line.",
  linkedin:
    "a professional but human post. Strong first line (dwell), short paragraphs, one clear insight or story, soft CTA for comments/saves. No hashtag spam; avoid leading with an external link.",
  youtube: `a YouTube Shorts package using this labeled format:
  HOOK: (spoken in first 1s, on-camera or VO)
  BEAT 1: …
  BEAT 2: …
  ON_SCREEN: (max 6-8 plain words)
  TITLE: (searchable Shorts title, under ~70 chars)
  CAPTION: (description + 3-5 hashtags — this is what gets pasted, NOT the script)
  Keep it filmable in ~15–45 seconds.`,
  reddit:
    "a native Reddit post: useful title (no clickbait emoji) on the first line, blank line, then 1-3 short paragraphs. If a subreddit is obvious from the idea, start with r/name on its own first line. Conversational, specific, no hashtag spam. Sound like a person in the sub, not a brand account.",
  threads:
    "a Threads post: casual, punchy, 1-4 short lines. More conversational than Instagram captions. Light emoji ok. No hashtag stuffing.",
  pinterest:
    "a Pinterest pin description: clear first line (what it is), 2-3 useful lines, then 4-8 search-friendly keywords/hashtags. Descriptive, not salesy.",
  nextdoor:
    "a Nextdoor post for neighbours: local, helpful, human. 2-4 short sentences. No hashtags. Fine for real estate / local services if it sounds neighbourly, not spammy.",
};

const ALLOWED = new Set(PLATFORMS);

function isLegacyDefault(list) {
  if (list.length !== LEGACY_DEFAULT_PLATFORMS.length) return false;
  const set = new Set(list);
  return LEGACY_DEFAULT_PLATFORMS.every((p) => set.has(p));
}

/** Selected destinations to generate. Falls back to the default set (includes YouTube Shorts). */
export function resolveEnabledPlatforms(traits, override) {
  const raw = Array.isArray(override) && override.length ? override : traits?.enabled_platforms;
  const list = (Array.isArray(raw) ? raw : DEFAULT_ENABLED_PLATFORMS)
    .map((p) => String(p || "").toLowerCase().trim())
    .filter((p) => ALLOWED.has(p));
  const unique = [...new Set(list)];
  if (!unique.length || isLegacyDefault(unique)) return [...DEFAULT_ENABLED_PLATFORMS];
  return unique;
}

export function platformGuidanceFor(targets) {
  const keys = resolveEnabledPlatforms({ enabled_platforms: targets });
  const lines = keys.map((p) => `- ${p}: ${GUIDANCE[p] || "a native post for this app."}`);
  return `Adapt the SAME idea natively for each requested platform:\n${lines.join("\n")}`;
}
