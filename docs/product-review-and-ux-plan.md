# Brand Studio — Product Review & UI/UX Upgrade Plan

**Date:** 17 Jul 2026  
**Scope:** Full audit of `app/` + `hub/` after v2.3 (camera, tour, drafts edit, growth tips, SPA rewrites)  
**Goal:** Catalogue bugs, shipped features, missing functions; define a phased UI/UX upgrade focused on emotional intelligence, camera UX, and true cross-device scaling (incl. Samsung Ultra).

---

## 1. What you have built (snapshot)

Brand Studio is a **voice-first creator/SMB PWA**: speak an idea → AI drafts for X / Facebook / TikTok / Snapchat / Instagram → review, edit, share, post, or schedule.

| Layer | Stack | Live |
|-------|--------|------|
| App | React 18 + Vite PWA on Vercel | https://app-bay-nu-40.vercel.app |
| Hub | Express + SQLite + Claude on Fly | https://brand-studio-hub.fly.dev |

### Shipped product surface

| Area | Status |
|------|--------|
| Capture (voice + type + media) | Live |
| In-app camera (getUserMedia) | Live — **UX bugs** |
| Drafts (5 platforms, edit, copy, share, post, schedule) | Live |
| Schedule blocks + queued posts calendar | Live |
| Workouts log | Live |
| Setup / Brand Brain / tiers / referrals | Live |
| Agents (Studio keys + analytics) | Live |
| Insights + weekly AI growth tips | Live (activity-based; metrics stubbed) |
| X OAuth + direct post | Live when credentials set |
| FB / IG / TikTok via unified API | Env-gated stub (no connect UX) |
| Onboarding tour | Live — still fragile |
| SPA deep-link rewrites | Fixed (was causing 404s) |

---

## 2. Confirmed bugs (priority)

### P0 — User-facing / reported

| Bug | Evidence | Likely cause | Fix direction |
|-----|----------|--------------|---------------|
| **Camera shutter requires scroll** | User report | `.camera-overlay` is a column flex; `.camera-video { flex: 1 }` can grow past the viewport (intrinsic video size / no `min-height: 0` / no `100dvh` lock), pushing `.camera-controls` below the fold | Lock overlay to `100dvh` + `overflow: hidden`; pin controls with `position: absolute` or grid template `auto 1fr auto`; `min-height: 0` on video |
| **Samsung Ultra resolution / scale** | Test user | Shell uses `height: 100%` (not `dvh`); `max-width: 560px` column; sheets use `86vh`; no density / tall-screen breakpoints; `background-attachment: fixed`; `user-scalable=no`; portrait-only PWA | Adopt `100dvh`/`svh` layout tokens; fluid type/spacing; test matrix Ultra / Pixel / iPhone; optional allow zoom for a11y |
| **Deep-link 404s** | Was live | Missing Vercel SPA rewrite | **Fixed** (`vercel.json`) — confirm users on latest SW |

### P1 — High impact UX / reliability

| Bug | Notes |
|-----|-------|
| Tour can run before signup | `shouldShowTour()` ignores auth; welcome card + tour stack |
| Tour timing / spotlight miss | 600ms delay; no scroll-into-view; nav steps can collide with bottom card |
| Camera mode switch restarts stream | Photo↔video tears down getUserMedia (blink / re-prompt risk) |
| Camera `onstop` after unmount | Cleanup may fire capture callbacks after close |
| Ideal 1920×1080 constraints | Can fail or crop oddly on ultrawide / foldables |
| Soft keyboard crushes Capture | `%` height + no keyboard-aware layout |
| Share-into-app is text-only | Manifest GET share target — no photo share-in |
| Version drift | UI `v2.3` vs `package.json` `1.0.0` |

### P2 — Backend / product integrity

| Issue | Notes |
|-------|-------|
| Google ID token not signature-verified | Decode-only path |
| Sessions never expire | Stolen `bs_` token until logout |
| `/api/insights/refresh` not tier-gated | Free users can burn Claude credits |
| Publish does not set `drafts.status = posted` | Status / agent stats drift |
| Unified Meta/TikTok: no connect flows | Key alone ≠ per-user profiles |
| Publish is text-only | `media_url` unused at publish |
| Scheduled post failures have no retry | |
| Growth `metrics_connected: false` always | Placeholder until analytics APIs |

---

## 3. Features that work well

- End-to-end capture → generate → drafts → edit → share/post/schedule loop
- Multi-tenant auth, tiers, referrals, Brand Brain traits
- Agent key scoping (read + draft/insights only; no self-approve)
- Weekly growth tip worker + Insights playbook UI
- Confetti / Spark mascot / streak chip (foundation for Duolingo-style delight)
- HEIC / large image prep before upload
- PWA install path + iOS meta / apple-touch-icon

---

## 4. Missing or incomplete functions

### Product / growth

1. **Real platform metrics** — engagement, reach, retention signals → weekly tips + “algo jacks”
2. **FB / IG / TikTok connect UX** — OAuth or Ayrshare profile linking
3. **Media-aware publishing** — attach photo/video when posting
4. **Snapchat** — share-sheet only (acceptable if documented)
5. **Self-serve billing** — tiers are CLI (`set-tier`) only
6. **File share-target** — share photos from gallery into Capture
7. **Install prompt UI** — copy-only instructions today
8. **Failed scheduled post retry**

### UX / IA

1. Agents & Insights not in bottom nav (discoverability)
2. No post-signup checklist (Brand Brain → first capture → first draft)
3. Workout tab missing from tour
4. No landscape / fold / DeX layout strategy
5. No upload progress / cancel on media
6. No flip camera / torch / max video duration

---

## 5. Root cause: camera scroll + Ultra scaling

### Camera shutter below the fold

```
.camera-overlay { position: fixed; inset: 0; display: flex; flex-direction: column; }
.camera-video   { flex: 1; object-fit: cover; }   /* ← can expand past viewport */
.camera-controls{ padding: … safe-area … }       /* ← pushed off-screen → scroll */
```

On tall phones (S24 Ultra ~19.3:9), the `<video>` element’s layout contribution often exceeds remaining space because flex children default to `min-height: auto`. Result: controls sit under the visible area.

**Correct pattern:** treat the camera as a **fixed viewport shell** — never scrollable:

- `height: 100dvh; max-height: 100dvh; overflow: hidden`
- Grid: `auto / 1fr / auto` (top bar / preview / shutter)
- Preview: `min-height: 0; overflow: hidden`
- Controls: always visible above home indicator (`safe-area-inset-bottom`)

### Samsung Ultra “didn’t scale”

Not a single bug — a cluster:

| Factor | Effect on Ultra |
|--------|-----------------|
| `height: 100%` not `dvh` | Mismatch with browser chrome / gesture bar |
| `max-width: 560px` | Fine in phone width; odd in split-screen / DeX |
| Sheets `86vh` | Can overflow or leave gaps as chrome shows/hides |
| No fluid type scale | Tiny labels on high-DPI |
| `user-scalable=no` | Users cannot zoom to compensate |
| Camera `object-fit: cover` + 1920×1080 ideal | Preview framing ≠ sensor crop |

---

## 6. UI/UX upgrade plan — “Intelligent & fluid”

Design north star: **Duolingo clarity + coach energy**, without looking like a purple AI template. One job per screen, Spark as guide, progress always visible, zero dead-ends for first-timers.

### Phase A — Device shell & camera (1–2 days) — do first

1. **Viewport tokens**
   - `--app-height: 100dvh` (fallback `100vh`)
   - Replace sheet `86vh` with `86dvh`
   - `.app` / overlays use `min-height: var(--app-height)`
2. **Camera rebuild**
   - Non-scrollable shell; shutter always on-screen
   - Absolute/grid pin for controls
   - Mode switch without full stream restart when possible
   - Guard unmount races; soft-fail getUserMedia constraints
3. **Ultra / matrix QA**
   - S24 Ultra, mid Android, iPhone SE, iPhone 15 Pro Max
   - Portrait PWA + Safari + Chrome; keyboard open on Capture
4. **Safe-area audit**
   - Nav, toast, sheets, camera, tour — all use insets consistently

### Phase B — First-run intelligence (2–3 days)

1. Defer tour until signed in (or show 2-step welcome → tour)
2. Post-signup checklist: Brand Brain → Capture → Draft
3. Coach microcopy: short, encouraging, one CTA
4. Replay tour still in Setup; add Workout step
5. Surface Insights earlier (“Your weekly tips”) after first draft

### Phase C — Visual system refresh (2–3 days)

1. Keep dark base; lean into **lime success / sky info / warm celebration** (already started)
2. Fluid type: `clamp()` for titles and mic stage
3. Capture hero: mic as single composition; reduce clutter below fold
4. Motion: 2–3 intentional transitions (tour card, draft open, celebrate) — respect `prefers-reduced-motion`
5. Align version string + optional build stamp in Setup

### Phase D — Growth intelligence (when connectors ready)

1. Wire platform analytics into `collectStats()`
2. Weekly tips reference real reach / saves / watch time
3. Per-platform “algo jack” cards tied to Brand Brain style
4. Insights meter already scaffolded — flip `metrics_connected` when live

### Phase E — Publish completeness

1. Connect UX for Meta/TikTok (or document Ayrshare profile keys)
2. Attach media on publish
3. Retry failed scheduled posts
4. Optional: POST share-target for images

---

## 7. Recommended implementation order

```
1. Camera viewport lock (P0 bug)          ← unblock testers
2. dvh / fluid shell (Ultra scaling)      ← same PR if possible
3. Tour + first-run sequencing
4. Capture layout polish (keyboard-safe)
5. Insights discoverability
6. Backend hygiene (session TTL, refresh tier gate, draft status)
7. Metrics connectors → tip quality
```

---

## 8. Success criteria

| Check | Pass condition |
|-------|----------------|
| Camera | Shutter visible without scroll on Ultra, Pixel, iPhone SE |
| Scale | No clipped nav/controls; sheets fit; Capture usable with keyboard |
| First run | New user reaches first draft in ≤3 guided steps |
| Clarity | Tour text + Next always readable |
| Growth | Weekly tips refresh on schedule; metrics flag honest until APIs exist |

---

## 9. Decisions (locked 17 Jul 2026)

1. **Bottom nav:** Insights replaces Workouts
2. **Zoom:** pinch-zoom allowed
3. **Unified posting:** Ayrshare profile-key linking shipped; Share remains always available
4. **Workouts:** optional module under Setup → Optional modules

---

*Phase A + IA changes shipping as v2.4.*
