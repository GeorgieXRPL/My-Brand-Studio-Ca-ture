# Unit economics (internal)

Prices: **Free $0 · Creator $19/mo · Studio $49/mo**.

---

## Cost stack (order of magnitude)

| Cost | Notes |
|------|--------|
| LLM (Claude) per draft | Typically **pennies** per multi-platform generation (monitor Anthropic usage) |
| Unified social publish | ~**$1–6 / connected account / mo** at current partner pricing (internal COGS; never show vendor name in product UI) |
| X API | Pay-per-use (~$0.01–0.02 / post class costs — verify against current X pricing) |
| Hosting | Vercel (app) + Fly (hub) — low hundreds $/mo at early scale |
| Stripe fees | ~2.9% + $0.30 per successful charge |

---

## Contribution margin sketch (Creator $19)

Assume average paying Creator:

- 40 drafts / mo generated (well under 200 cap)  
- LLM: ~$0.40–1.20  
- Unified accounts: 2 platforms × $3 = $6 (if linked; many stay Share-only → $0)  
- Hosting allocation: ~$0.50  
- Stripe: ~$0.85  

**COGS range:** ~$2–9 → **gross margin ~50–90%** depending on connect intensity.

Studio $49 absorbs agent usage + higher draft caps; self-hosters may reduce our LLM COGS if they bring keys later (roadmap).

---

## Guardrails

1. Cap free drafts (10) — already enforced.  
2. Gate Insights refresh to Creator+ — shipped with billing work.  
3. Prefer Share on Free — no publish COGS.  
4. Track `$ LLM / draft` weekly; raise Free cap only when margin allows.  
5. Migrate off unified publisher when volume justifies Meta/TikTok direct apps.

---

## Target

- Gross margin **≥70%** blended by month 12  
- Payback on paid CAC **&lt; 2 months** (organic-heavy GTM)
