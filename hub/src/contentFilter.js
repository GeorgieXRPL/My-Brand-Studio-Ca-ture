/**
 * Lightweight prompt/topic abuse filter for Brand Studio.
 * Extend via CONTENT_BLOCKLIST env (comma-separated phrases).
 */
const DEFAULT_BLOCK = [
  "child sexual",
  "csam",
  "child porn",
  "revenge porn",
  "how to make a bomb",
  "make ricin",
];

export function contentBlocklist() {
  const extra = (process.env.CONTENT_BLOCKLIST || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_BLOCK, ...extra];
}

/** Returns a reason string if blocked, otherwise null. */
export function findBlockedContent(text) {
  const hay = String(text || "").toLowerCase();
  if (!hay.trim()) return null;
  for (const phrase of contentBlocklist()) {
    if (phrase && hay.includes(phrase)) {
      return "This content isn't allowed on Brand Studio. See our Terms.";
    }
  }
  return null;
}
