/** Shared plan copy for Setup upgrade UI — keep aligned with hub/src/plans.js */

export const PLAN_COPY = {
  free: {
    name: "Free",
    price: "$0",
    blurb: "Speak ideas into drafts and Share anywhere.",
    features: ["10 drafts / month", "Guided multi-Share", "Share reminders", "Daily plan"],
  },
  creator: {
    name: "Creator",
    price: "$19/mo",
    blurb: "More drafts, AI stills, and growth tips.",
    features: [
      "80 drafts / month",
      "40 AI stills / edits / month (Grok Imagine)",
      "Guided multi-Share",
      "Share reminders",
      "Growth tips",
      "X Post when connected",
    ],
  },
  studio: {
    name: "Studio",
    price: "$49/mo",
    blurb: "AI video, agents, and your own server.",
    features: [
      "200 drafts / month",
      "60 AI stills / month",
      "8 AI video clips / month",
      "Buy extra video credits anytime",
      "AI agents",
      "Self-hosted hub",
      "More platform Post & live metrics — coming soon",
    ],
  },
} as const;

export const VIDEO_CREDIT_PACKS = [
  { id: "5", credits: 5, price: "$6", blurb: "5 AI clips" },
  { id: "15", credits: 15, price: "$15", blurb: "15 AI clips" },
  { id: "40", credits: 40, price: "$35", blurb: "40 AI clips" },
] as const;

/** Platforms that publish via the unified vendor API — Studio-only for margin. */
export const UNIFIED_POST_PLATFORMS = ["facebook", "instagram", "tiktok", "linkedin"] as const;

export function tierAtLeast(tier: string | undefined, min: "free" | "creator" | "studio"): boolean {
  const order = ["free", "creator", "studio"];
  return order.indexOf(tier || "free") >= order.indexOf(min);
}
