import {
  DEFAULT_ENABLED_PLATFORMS,
  LEGACY_DEFAULT_PLATFORMS,
  PLATFORMS,
  type Platform,
} from "./types";

const ALLOWED = new Set<string>(PLATFORMS);

function isLegacyDefault(list: Platform[]): boolean {
  if (list.length !== LEGACY_DEFAULT_PLATFORMS.length) return false;
  const set = new Set(list);
  return LEGACY_DEFAULT_PLATFORMS.every((p) => set.has(p));
}

export function normalizeEnabledPlatforms(list?: string[] | null): Platform[] {
  const picked = (Array.isArray(list) ? list : DEFAULT_ENABLED_PLATFORMS)
    .map((p) => String(p || "").toLowerCase().trim())
    .map((p) => (p === "youtube_shorts" || p === "youtube-shorts" ? "youtube" : p))
    .filter((p): p is Platform => ALLOWED.has(p));
  const unique = [...new Set(picked)];
  if (!unique.length || isLegacyDefault(unique)) return [...DEFAULT_ENABLED_PLATFORMS];
  return unique;
}

export function toggleEnabledPlatform(list: Platform[], platform: Platform): Platform[] {
  const cur = normalizeEnabledPlatforms(list);
  if (cur.includes(platform)) {
    const next = cur.filter((p) => p !== platform);
    return next.length ? next : cur;
  }
  return PLATFORMS.filter((p) => cur.includes(p) || p === platform);
}
