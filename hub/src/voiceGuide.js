export const EXAMPLE_POST_CAP = 3;
export const LIST_TRAIT_CAP = 12;

export function asList(value, cap = LIST_TRAIT_CAP) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v || "").trim()).filter(Boolean).slice(0, cap);
  }
  if (typeof value === "string") {
    return value.split(/[\n,]+/).map((v) => v.trim()).filter(Boolean).slice(0, cap);
  }
  return [];
}

/** NEVER USE / ALWAYS PREFER / EXAMPLES blocks. Empty traits stay empty. */
export function voiceGuideBlocks(traits) {
  if (!traits || typeof traits !== "object") return "";
  const never = asList(traits.never_use, LIST_TRAIT_CAP);
  const always = asList(traits.always_use, LIST_TRAIT_CAP);
  const examples = asList(traits.example_posts, EXAMPLE_POST_CAP).map((e) => e.slice(0, 400));
  const parts = [];
  if (never.length) parts.push(`NEVER USE:\n${never.map((w) => `- ${w}`).join("\n")}`);
  if (always.length) parts.push(`ALWAYS PREFER:\n${always.map((w) => `- ${w}`).join("\n")}`);
  if (examples.length) {
    parts.push(
      `EXAMPLES (match this energy, do not copy verbatim):\n${examples.map((e, i) => `${i + 1}. ${e}`).join("\n")}`
    );
  }
  return parts.length ? `\n\n${parts.join("\n\n")}` : "";
}
