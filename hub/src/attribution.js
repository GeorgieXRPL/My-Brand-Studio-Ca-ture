/** Free-plan posts tag Brand Studio on X (and as text on other networks). */

export const BRAND_X_HANDLE = "@MyBStudio";

export function needsBrandTag(tier) {
  const t = String(tier || "free").toLowerCase();
  return t !== "creator" && t !== "studio";
}

/** Append @MyBStudio for free accounts unless already present. */
export function withBrandTag(text, tier) {
  const body = String(text || "").trim();
  if (!body) return body;
  if (!needsBrandTag(tier)) return body;
  if (new RegExp(`(^|[\\s])${BRAND_X_HANDLE}\\b`, "i").test(body)) return body;
  return `${body}\n\n${BRAND_X_HANDLE}`;
}
