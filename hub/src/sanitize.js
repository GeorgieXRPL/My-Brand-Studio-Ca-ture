/**
 * Strip Claude/LLM tic of ASCII double hyphens and tidy dashes in copy.
 */

export function sanitizeCopy(text) {
  if (text == null) return text;
  if (typeof text !== "string") return text;
  return text
    .replace(/\u2014|\u2013/g, " - ") // em/en dash → spaced hyphen
    .replace(/--+/g, " - ") // double hyphen runs
    .replace(/\s+-\s+/g, " - ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Deep-sanitize string values in a variants object. */
export function sanitizeVariants(variants) {
  if (!variants || typeof variants !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(variants)) {
    out[k] = typeof v === "string" ? sanitizeCopy(v) : v;
  }
  return out;
}

export function safeParseVariants(raw) {
  if (raw == null || raw === "") return {};
  if (typeof raw === "object") return sanitizeVariants(raw);
  try {
    const parsed = JSON.parse(raw);
    return sanitizeVariants(parsed && typeof parsed === "object" ? parsed : {});
  } catch {
    return {};
  }
}
