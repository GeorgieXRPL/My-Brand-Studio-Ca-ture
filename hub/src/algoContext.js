// Living algorithm context injected into weekly growth tips and agent guidance.
// Refresh this file as platforms shift — agents should also POST fresh finds to /api/insights.

/** Bump this when algo knowledge materially changes so users can pull fresh tips immediately. */
export const ALGO_KNOWLEDGE_CUTOFF = "2026-08-08T00:00:00.000Z";

export function algoKnowledgeAsOf(date = new Date()) {
  const month = date.toLocaleString("en-US", { month: "long", year: "numeric" });
  return {
    as_of: month,
    summary: [
      "Interest graph > follow graph on every major platform: stranger reach depends on retention and forwards, not follower count.",
      "Dwell time, completion / rewatch, saves, and private shares (DMs) beat likes almost everywhere.",
      "Original, non-watermarked media is rewarded; heavy reposting is penalised (esp. Instagram / Facebook).",
    ],
    platforms: {
      x: "Grok-based For You ranking (open-sourced 2026). Prioritise reply quality, bookmarks, and early conversation depth over likes. Hook in the first line; threads that earn substantive replies expand.",
      instagram:
        "Separate rankers for Feed / Reels / Stories / Explore. Top signals: watch time, sends-per-reach (DM shares), likes-per-reach. Trial Reels for non-follower tests. Original content heavily favoured over reposts.",
      tiktok:
        "Seed test → expand. Completion ~70%+ and rewatches drive virality. Spoken audio + on-screen text are indexed for search. Hook in first 1–1.5s; niche consistency helps the interest graph.",
      facebook:
        "Meaningful interactions and Groups still matter. Original video / Reels preferred; fingerprinting reduces reach for pages that mostly repost. Crosspost from IG with FB-native captions.",
      linkedin:
        "LLM interest-graph hybrid (2026). Saves and substantive comments (3+ sentences) outweigh reactions. First lines must earn dwell; external links often suppress reach. Documents/carousels and expert POV perform well.",
      snapchat:
        "Ephemeral + Spotlight. Authenticity and early engagement; keep captions short and visual-first. Spotlight rewards watch-through on short vertical video.",
    },
  };
}

export function agentAlgoBrief() {
  const k = algoKnowledgeAsOf();
  return [
    `Current algorithm brief (${k.as_of}) — use this when researching weekly insights:`,
    ...k.summary.map((s) => `- ${s}`),
    ...Object.entries(k.platforms).map(([p, tip]) => `- ${p}: ${tip}`),
    "Each week: POST 1–3 insights to /api/insights with platform, title, body reflecting NEW shifts or content-gap finds tailored to this creator. Prefer fresh 2026+ signals over outdated 2023–2024 advice.",
  ].join("\n");
}
