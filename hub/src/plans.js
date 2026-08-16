/** Shared plan limits — keep in sync with app PLAN_COPY. */

export const PLAN_PRICES = {
  creator: { monthly: 19, label: "Creator" },
  studio: { monthly: 49, label: "Studio" },
};

/** Drafts per calendar month (plus referral bonus_drafts). */
export const DRAFT_LIMITS = { free: 10, creator: 80, studio: 200 };

/** Included Grok stills per month. Free: 0. */
export const STILL_LIMITS = { free: 0, creator: 40, studio: 60 };

/** Included Grok video clips per month. Studio only. */
export const VIDEO_LIMITS = { free: 0, creator: 0, studio: 8 };

/** One-time Stripe packs (price_data — no Stripe Price IDs required). */
export const VIDEO_CREDIT_PACKS = {
  "5": { credits: 5, usd: 6, label: "5 AI video clips" },
  "15": { credits: 15, usd: 15, label: "15 AI video clips" },
  "40": { credits: 40, usd: 35, label: "40 AI video clips" },
};

export function planFeatures() {
  return {
    free: {
      monthly: 0,
      drafts: DRAFT_LIMITS.free,
      stills: STILL_LIMITS.free,
      videos: VIDEO_LIMITS.free,
      features: ["Share to any app", `${DRAFT_LIMITS.free} drafts / month`, "Share reminders"],
    },
    creator: {
      monthly: PLAN_PRICES.creator.monthly,
      drafts: DRAFT_LIMITS.creator,
      stills: STILL_LIMITS.creator,
      videos: VIDEO_LIMITS.creator,
      features: [
        `${DRAFT_LIMITS.creator} drafts / month`,
        `${STILL_LIMITS.creator} AI stills / edits / month (Grok Imagine)`,
        "Guided Share",
        "Share reminders",
        "Growth tips",
        "X Post when connected",
      ],
    },
    studio: {
      monthly: PLAN_PRICES.studio.monthly,
      drafts: DRAFT_LIMITS.studio,
      stills: STILL_LIMITS.studio,
      videos: VIDEO_LIMITS.studio,
      features: [
        `Everything in Creator`,
        `${DRAFT_LIMITS.studio} drafts / month`,
        `${STILL_LIMITS.studio} AI stills / month`,
        `${VIDEO_LIMITS.studio} AI video clips / month`,
        "Buy extra video credits anytime",
        "AI agents",
        "Self-hosted hub",
        "More platform Post & live metrics — coming soon",
      ],
    },
  };
}
