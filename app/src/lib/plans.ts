/** Shared plan copy for Setup upgrade UI */
export const PLAN_COPY = {
  free: {
    name: "Free",
    price: "$0",
    blurb: "Speak ideas into drafts and Share anywhere.",
    features: ["10 drafts / month", "Guided multi-Share", "Daily plan"],
  },
  creator: {
    name: "Creator",
    price: "$19/mo",
    blurb: "More drafts, content queue, and growth tips.",
    features: ["200 drafts / month", "Guided multi-Share", "Content queue", "Growth tips", "X Post when connected"],
  },
  studio: {
    name: "Studio",
    price: "$49/mo",
    blurb: "Agents, Imagine, and your own server.",
    features: [
      "1,000 drafts / month",
      "AI clip & still (Grok Imagine)",
      "AI agents",
      "Self-hosted hub",
      "More platform Post & live metrics — coming soon",
    ],
  },
} as const;

/** Platforms that publish via the unified vendor API — Studio-only for margin. */
export const UNIFIED_POST_PLATFORMS = ["facebook", "instagram", "tiktok", "linkedin"] as const;

export function tierAtLeast(tier: string | undefined, min: "free" | "creator" | "studio"): boolean {
  const order = ["free", "creator", "studio"];
  return order.indexOf(tier || "free") >= order.indexOf(min);
}
