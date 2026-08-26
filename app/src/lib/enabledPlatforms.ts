import {
  DEFAULT_ENABLED_PLATFORMS,
  PLATFORMS,
  type Platform,
} from "./types";

const ALLOWED = new Set<string>(PLATFORMS);

export function normalizeEnabledPlatforms(list?: string[] | null): Platform[] {
  const picked = (Array.isArray(list) ? list : DEFAULT_ENABLED_PLATFORMS)
    .map((p) => String(p || "").toLowerCase().trim())
    .filter((p): p is Platform => ALLOWED.has(p));
  const unique = [...new Set(picked)];
  return unique.length ? unique : [...DEFAULT_ENABLED_PLATFORMS];
}

export function toggleEnabledPlatform(list: Platform[], platform: Platform): Platform[] {
  const cur = normalizeEnabledPlatforms(list);
  if (cur.includes(platform)) {
    const next = cur.filter((p) => p !== platform);
    return next.length ? next : cur;
  }
  return PLATFORMS.filter((p) => cur.includes(p) || p === platform);
}
