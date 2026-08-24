/**
 * Profile PUT is replace-not-merge at the SQL layer.
 * Merge omitted fields so a partial body cannot blank brand_voice / traits.
 */

export function mergeProfileUpdate(existing, body = {}) {
  const prev = existing && typeof existing === "object" ? existing : {};
  const src = body && typeof body === "object" ? body : {};

  const goals = src.goals !== undefined ? String(src.goals ?? "") : prev.goals || "";
  const projects = src.projects !== undefined ? String(src.projects ?? "") : prev.projects || "";
  const brand_voice =
    src.brand_voice !== undefined ? String(src.brand_voice ?? "") : prev.brand_voice || "";

  const prevTraits =
    prev.traits && typeof prev.traits === "object" && !Array.isArray(prev.traits) ? { ...prev.traits } : {};
  let traits = prevTraits;
  if (src.traits !== undefined) {
    if (src.traits && typeof src.traits === "object" && !Array.isArray(src.traits)) {
      traits = { ...prevTraits, ...src.traits };
    } else if (src.traits === null) {
      traits = prevTraits;
    }
  }

  return {
    goals,
    projects,
    brand_voice,
    traits,
    watermark_media_url: src.watermark_media_url,
  };
}

export function exportProfilePayload(profile) {
  const p = profile && typeof profile === "object" ? profile : {};
  return {
    goals: p.goals || "",
    projects: p.projects || "",
    brand_voice: p.brand_voice || "",
    traits: p.traits && typeof p.traits === "object" ? p.traits : {},
    watermark_media_url: p.watermark_media_url || null,
  };
}
