import express from "express";
import cors from "cors";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { db, ensureOwnerUser, ensureRefCode, mediaDir } from "./db.js";
import {
  acceptTerms,
  assertUserActive,
  createSession,
  destroySession,
  findOrCreateGoogleUser,
  getUser,
  login,
  noteAuthEvent,
  resolveSession,
  setUserDisabled,
  signup,
} from "./auth.js";
import { findBlockedContent } from "./contentFilter.js";
import { generateVariants, chat, PLATFORMS, resolveTextProvider, anthropicConfigured, grokTextConfigured } from "./textGen.js";
import { exportProfilePayload, mergeProfileUpdate } from "./profile.js";
import {
  connectUnified,
  finishXConnect,
  providerStatus,
  publish,
  startXConnect,
  UNIFIED_PLATFORMS,
} from "./social.js";
import { generateTipsFor, getGrowthStatus, runWeeklyGrowthTips, tipsAreFresh } from "./growth.js";
import { agentAlgoBrief, algoKnowledgeAsOf } from "./algoContext.js";
import {
  billingStatus,
  consumeVideoCredit,
  createCheckoutSession,
  createCreditsCheckoutSession,
  createPortalSession,
  getVideoCredits,
  refundVideoCredit,
  handleStripeWebhook,
} from "./billing.js";
import { DRAFT_LIMITS, STILL_LIMITS, VIDEO_LIMITS, PLAN_PRICES, VIDEO_CREDIT_PACKS } from "./plans.js";
import {
  buildVideoPrompt,
  downloadBinary,
  editStill,
  generateStill,
  imagineConfigured,
  extractPostCaption,
  parseFilmLabels,
  pollVideo,
  sanitizeImaginePrompt,
  startVideoGeneration,
  STILL_EDIT_PRESETS,
} from "./imagine.js";
import { withBrandTag } from "./attribution.js";
import {
  burnTextOntoImage,
  burnTextOntoVideo,
  burnWatermarkOntoImage,
  burnWatermarkOntoVideo,
  muxNarrationOntoVideo,
  normalizeOnScreen,
  normalizeVideoForShare,
} from "./overlay.js";
import { safeParseVariants, sanitizeCopy, sanitizeVariants } from "./sanitize.js";
import {
  createCryptoInvoice,
  cryptoPayConfig,
  resolveCryptoMethod,
  registerAdminRoutes,
} from "./admin.js";
import { syncCryptoDeposits } from "./cryptoWatch.js";
import { getVoiceMeta, listTtsVoices, narrationFromLabels, synthesizeSpeech, ttsConfigured } from "./tts.js";

const app = express();
app.set("trust proxy", 1);

const allowed = (process.env.ALLOWED_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function originAllowed(origin) {
  if (!origin || allowed.includes(origin)) return true;
  try {
    const u = new URL(origin);
    const hostAlt = u.hostname === "localhost" ? "127.0.0.1" : u.hostname === "127.0.0.1" ? "localhost" : null;
    if (!hostAlt) return false;
    const port = u.port ? `:${u.port}` : "";
    return allowed.includes(`${u.protocol}//${hostAlt}${port}`);
  } catch {
    return false;
  }
}

app.use(
  cors({
    origin(origin, cb) {
      // Allow same-origin / curl (no origin) and any explicitly allowed origin.
      // localhost and 127.0.0.1 are treated as the same host for local dev.
      if (originAllowed(origin)) return cb(null, true);
      return cb(new Error("Origin not allowed: " + origin));
    },
    credentials: true,
  })
);

// Stripe webhooks need the raw body — register before JSON parser.
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const sig = req.headers["stripe-signature"];
    const result = await handleStripeWebhook(req.body, sig);
    res.json(result);
  } catch (err) {
    console.error("[billing webhook]", err.message);
    res.status(err.status || 400).json({ error: err.message || "Webhook error" });
  }
});

app.use(express.json({ limit: "1mb" }));
registerAdminRoutes(app);

const now = () => new Date().toISOString();
const wrap = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || "Server error" });
  }
};

// ---- Simple in-memory rate limit for auth endpoints ----

const attempts = new Map(); // ip -> { count, resetAt }
function rateLimit(req, res, next) {
  const ip = req.ip || "unknown";
  const nowMs = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < nowMs) {
    attempts.set(ip, { count: 1, resetAt: nowMs + 15 * 60_000 });
    return next();
  }
  if (entry.count >= 20) {
    return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
  }
  entry.count++;
  next();
}

// ---- Public routes ----

app.get("/api/health", (_req, res) => {
  try {
    db.prepare("SELECT 1 AS ok").get();
    res.json({
      ok: true,
      platforms: PLATFORMS,
      db: true,
      uptime_s: Math.round(process.uptime()),
    });
  } catch {
    res.status(503).json({ ok: false, db: false, error: "Database unavailable" });
  }
});

app.post("/api/auth/signup", rateLimit, wrap((req, res) => {
  const user = signup(req.body?.email, req.body?.password, req.body?.ref, {
    termsAccepted: Boolean(req.body?.terms_accepted),
  });
  const token = createSession(user.id);
  noteAuthEvent({ userId: user.id, email: user.email, method: "password", isNew: true });
  res.status(201).json({ token, email: user.email });
}));

app.post("/api/auth/login", rateLimit, wrap((req, res) => {
  const user = login(req.body?.email, req.body?.password);
  const token = createSession(user.id);
  noteAuthEvent({ userId: user.id, email: user.email, method: "password", isNew: false });
  res.json({ token, email: user.email });
}));

// Which sign-in methods this server supports (drives the app's UI).
app.get("/api/auth/providers", (_req, res) => {
  res.json({ password: true, google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) });
});

// ---- Google sign-in (OAuth 2.0 code flow) ----

const appUrl = () =>
  (process.env.APP_URL || allowed[0] || "").replace(/\/$/, "");
const hubUrl = () => (process.env.HUB_PUBLIC_URL || "").replace(/\/$/, "");

app.get("/api/auth/google/start", (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(501).json({ error: "Google sign-in isn't configured." });
  const state = randomBytes(24).toString("hex");
  const meta = JSON.stringify({
    ref: String(req.query.ref || "").trim().slice(0, 32),
  });
  db.prepare(
    "INSERT INTO oauth_states (state, user_id, platform, code_verifier, created_at) VALUES (?, 0, 'google', ?, ?)"
  ).run(state, meta, now());
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${hubUrl()}/api/auth/google/callback`,
    response_type: "code",
    scope: "openid email",
    state,
    prompt: "select_account",
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get("/api/auth/google/callback", async (req, res) => {
  try {
    const { state, code } = req.query;
    const pending = db.prepare("SELECT * FROM oauth_states WHERE state = ? AND platform = 'google'").get(state);
    if (!pending) throw new Error("Unknown or expired sign-in attempt.");
    db.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
    let refCode = "";
    try {
      refCode = JSON.parse(pending.code_verifier || "{}").ref || "";
    } catch {
      /* ignore */
    }

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${hubUrl()}/api/auth/google/callback`,
        grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokens.error_description || "Google token exchange failed.");

    // Prefer userinfo (token from Google's endpoint with client_secret) over
    // decoding the id_token without signature verification.
    const infoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const claims = await infoRes.json();
    if (!infoRes.ok || !claims.email) throw new Error(claims.error_description || "Could not read Google profile.");
    if (claims.email_verified !== true && claims.verified_email !== true && claims.email_verified !== "true") {
      throw new Error("Google account has no verified email.");
    }

    const user = findOrCreateGoogleUser(claims.email, { refCode });
    const session = createSession(user.id);
    noteAuthEvent({
      userId: user.id,
      email: user.email,
      method: "google",
      isNew: Boolean(user.created),
    });
    res.redirect(`${appUrl()}/setup#gtoken=${session}&gemail=${encodeURIComponent(user.email)}`);
  } catch (err) {
    console.error(err);
    res.redirect(`${appUrl()}/setup#gerror=${encodeURIComponent(err.message || "Google sign-in failed")}`);
  }
});

// OAuth callback (X redirects the user's browser here).
function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseCookie(header, name) {
  if (!header) return null;
  const parts = header.split(";");
  for (const part of parts) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("=") || "");
  }
  return null;
}

app.get("/api/connect/x/callback", async (req, res) => {
  const page = (title, body) =>
    res.send(
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;background:#06080f;color:#f0f4ff;display:flex;min-height:90vh;align-items:center;justify-content:center;text-align:center"><div><h2>${escapeHtml(title)}</h2><p style="color:#93a1c8">${escapeHtml(body)}</p></div></body>`
    );
  try {
    if (req.query.error) return page("Connection cancelled", "You can close this tab and try again from the app.");
    const cookieUser = parseCookie(req.headers.cookie, "x_oauth_user");
    const { handle } = await finishXConnect(req.query.state, req.query.code, cookieUser);
    res.setHeader(
      "Set-Cookie",
      "x_oauth_user=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
    );
    return page(`Connected ${handle || "to X"}`, "You can close this tab and return to Brand Studio.");
  } catch (err) {
    console.error(err);
    return page("Connection failed", err.message);
  }
});

// Public media serving (unguessable ids; required later for Meta/TikTok uploads).
app.get("/media/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM media WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).end();
  const file = join(mediaDir, row.id);
  if (!existsSync(file)) return res.status(404).end();
  res.type(row.mime);
  res.sendFile(file);
});

// ---- Auth middleware ----
// Three token kinds share the Authorization header:
//  1. Session tokens ("bs_...") from email/Google sign-in.
//  2. Agent API keys ("ak_...") - SCOPED: read + draft only, never publish/admin.
//  3. The legacy shared HUB_TOKEN (self-host mode) -> owner user (id 1).

const HUB_TOKEN = process.env.HUB_TOKEN || "";
if (HUB_TOKEN) ensureOwnerUser();

// Agent keys act on the user's CONTENT only. Everything not listed here is
// denied: no key management, no publishing, no connections, no export, no
// profile writes, no schedule/workout writes. See README "Agent security".
const AGENT_ALLOWED = [
  { method: "GET", re: /^\/api\/(profile|ideas|drafts|schedule|workouts|insights|algo)(\/|$|\?)/ },
  { method: "GET", re: /^\/api\/(profile|ideas|drafts|schedule|workouts|insights|algo\/context)$/ },
  { method: "POST", re: /^\/api\/(ideas|drafts|generate|chat|media|insights)$/ },
  { method: "PATCH", re: /^\/api\/(ideas|drafts)\/\d+$/ },
];

function agentMayAccess(req) {
  return AGENT_ALLOWED.some((rule) => rule.method === req.method && rule.re.test(req.path));
}

// Per-key rate limit so a runaway agent can't hammer the hub.
const agentHits = new Map(); // keyId -> { count, resetAt }
const AGENT_RATE_LIMIT = Number(process.env.AGENT_RATE_LIMIT || 60); // req/min

app.use((req, res, next) => {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  if (HUB_TOKEN && token === HUB_TOKEN) {
    req.userId = 1;
    req.tokenKind = "hub";
    return next();
  }
  if (token.startsWith("ak_")) {
    const keyHash = createHash("sha256").update(token).digest("hex");
    const key = db.prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(keyHash);
    if (!key) return res.status(401).json({ error: "Invalid API key." });

    if (!agentMayAccess(req)) {
      return res.status(403).json({
        error: "Agent keys can read content and submit drafts/insights only. This action needs the app.",
      });
    }
    const nowMs = Date.now();
    const hits = agentHits.get(key.id);
    if (!hits || hits.resetAt < nowMs) {
      agentHits.set(key.id, { count: 1, resetAt: nowMs + 60_000 });
    } else if (hits.count >= AGENT_RATE_LIMIT) {
      return res.status(429).json({ error: "Agent rate limit reached. Slow down and retry in a minute." });
    } else {
      hits.count++;
    }

    try {
      assertUserActive(key.user_id);
    } catch (e) {
      return res.status(e.status || 403).json({ error: e.message });
    }
    db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now(), key.id);
    db.prepare(
      "INSERT INTO agent_events (api_key_id, user_id, method, route, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(key.id, key.user_id, req.method, req.path, now());
    req.userId = key.user_id;
    req.tokenKind = "agent";
    req.agentKeyId = key.id;
    return next();
  }
  const userId = resolveSession(token);
  if (!userId) return res.status(401).json({ error: "Session expired. Sign in again." });
  try {
    assertUserActive(userId);
  } catch (e) {
    return res.status(e.status || 403).json({ error: e.message });
  }
  req.userId = userId;
  req.tokenKind = "session";
  next();
});

// ---- Tiers ----
// Stripe webhooks update users.tier; CLI set-tier remains for ops.
// Self-host owner (id 1 / owner@selfhost.local) is set to Studio in ensureOwnerUser.

function getTier(userId) {
  const row = db.prepare("SELECT tier FROM users WHERE id = ?").get(userId);
  return DRAFT_LIMITS[row?.tier] !== undefined ? row.tier : "free";
}

/** Lock capture/source media once so Imagine still/edit/video can be reverted. */
function lockOriginalMedia(draft) {
  if (!draft?.id || draft.original_media_url || !draft.media_url) return;
  // If Imagine already ran and we never stored a source, don't treat the AI result as original.
  const imagined = db.prepare("SELECT 1 AS n FROM imagine_jobs WHERE draft_id = ? LIMIT 1").get(draft.id);
  if (imagined) return;
  db.prepare(
    "UPDATE drafts SET original_media_url = ? WHERE id = ? AND user_id = ? AND (original_media_url IS NULL OR original_media_url = '')"
  ).run(draft.media_url, draft.id, draft.user_id);
}

/** Replace draft media, preserving the first non-AI attachment as original. */
function replaceDraftMedia(draft, newUrl) {
  lockOriginalMedia(draft);
  db.prepare("UPDATE drafts SET media_url = ? WHERE id = ? AND user_id = ?").run(newUrl, draft.id, draft.user_id);
}

function monthStartIso() {
  return now().slice(0, 7) + "-01";
}

function draftUsage(userId) {
  const used = db
    .prepare("SELECT COUNT(*) AS n FROM drafts WHERE user_id = ? AND created_at >= ?")
    .get(userId, monthStartIso()).n;
  const bonus = db.prepare("SELECT bonus_drafts FROM users WHERE id = ?").get(userId)?.bonus_drafts || 0;
  const tier = getTier(userId);
  return { tier, used, limit: DRAFT_LIMITS[tier] + bonus };
}

function mediaKindUsage(userId, kind) {
  // Failed jobs do not consume monthly included quota (hub/xAI errors shouldn't punish users).
  // Pending still counts so concurrent starts can't pile up free attempts.
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM imagine_jobs
       WHERE user_id = ? AND kind = ? AND status IN ('done', 'pending') AND created_at >= ?`
    )
    .get(userId, kind, monthStartIso()).n;
}

/** Stills + edits share the Creator monthly still allowance. */
function stillUsage(userId) {
  const tier = getTier(userId);
  const used = db
    .prepare(
      `SELECT COUNT(*) AS n FROM imagine_jobs
       WHERE user_id = ? AND kind IN ('still', 'edit') AND status IN ('done', 'pending') AND created_at >= ?`
    )
    .get(userId, monthStartIso()).n;
  const limit = STILL_LIMITS[tier] ?? 0;
  return { tier, used, limit, remaining: Math.max(0, limit - used) };
}

/**
 * Videos: Studio monthly included, then purchased video_credits.
 * Failed generations are excluded so OOM / xAI errors don't burn the allowance.
 */
function videoUsage(userId) {
  const tier = getTier(userId);
  const used = mediaKindUsage(userId, "video");
  const included = VIDEO_LIMITS[tier] ?? 0;
  const credits = getVideoCredits(userId);
  const includedRemaining = Math.max(0, included - used);
  const remaining = includedRemaining + credits;
  return {
    tier,
    used,
    included,
    included_remaining: includedRemaining,
    credits,
    remaining,
    limit: included,
  };
}

function assertDraftQuota(userId, res) {
  const usage = draftUsage(userId);
  if (usage.used >= usage.limit) {
    res.status(429).json({
      error:
        usage.tier === "free"
          ? `You've used all ${usage.limit} free drafts this month. Upgrade to Creator for ${DRAFT_LIMITS.creator}/month — or invite a friend for bonus drafts.`
          : `Monthly draft limit reached (${usage.limit}). It resets on the 1st.`,
      upgrade: usage.tier === "free" ? "creator" : undefined,
    });
    return null;
  }
  return usage;
}

function requireTier(req, res, minTier) {
  const order = ["free", "creator", "studio"];
  const tier = getTier(req.userId);
  if (order.indexOf(tier) >= order.indexOf(minTier)) return true;
  res.status(402).json({
    error:
      minTier === "studio"
        ? "AI video clips are a Studio feature. Upgrade for video, agents, and self-hosted hub — or buy clip credits on Setup."
        : "This is a Creator feature. Upgrade for more drafts, AI stills, and growth tips.",
    upgrade: minTier,
  });
  return false;
}

/** Unified vendor Post/schedule is Studio-only; X (direct OAuth) stays Creator+. */
function requirePublishTier(req, res, platform) {
  if (UNIFIED_PLATFORMS.includes(platform)) return requireTier(req, res, "studio");
  return requireTier(req, res, "creator");
}

app.get("/api/billing/plans", wrap((_req, res) => {
  res.json(billingStatus());
}));

app.get("/api/auth/me", wrap((req, res) => {
  const user = getUser(req.userId);
  const usage = draftUsage(req.userId);
  const stills = stillUsage(req.userId);
  const videos = videoUsage(req.userId);
  const referrals = db.prepare("SELECT COUNT(*) AS n FROM users WHERE referred_by = ?").get(req.userId).n;
  const billing = billingStatus();
  res.json({
    email: user?.email || "",
    kind: req.tokenKind,
    tier: usage.tier,
    ref_code: user?.ref_code || "",
    referrals,
    drafts_used: usage.used,
    drafts_limit: usage.limit,
    stills_used: stills.used,
    stills_limit: stills.limit,
    videos_used: videos.used,
    videos_included: videos.included,
    video_credits: videos.credits,
    videos_remaining: videos.remaining,
    billing_configured: billing.configured,
    credits_checkout: billing.credits_checkout,
    has_stripe_customer: Boolean(user?.stripe_customer_id),
    terms_accepted_at: user?.terms_accepted_at || null,
  });
}));

app.post("/api/auth/accept-terms", wrap((req, res) => {
  acceptTerms(req.userId);
  res.json({ ok: true, terms_accepted_at: getUser(req.userId)?.terms_accepted_at || null });
}));

app.post("/api/auth/logout", wrap((req, res) => {
  if (req.tokenKind === "session") {
    destroySession(req.get("authorization").slice(7));
  }
  res.json({ ok: true });
}));

app.post("/api/billing/checkout", wrap(async (req, res) => {
  if (req.tokenKind === "agent") return res.status(403).json({ error: "Agents can't manage billing." });
  try {
    const user = getUser(req.userId);
    const result = await createCheckoutSession({
      userId: req.userId,
      email: user?.email,
      tier: req.body?.tier,
      req,
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}));

app.post("/api/billing/credits/checkout", wrap(async (req, res) => {
  if (req.tokenKind === "agent") return res.status(403).json({ error: "Agents can't manage billing." });
  try {
    const user = getUser(req.userId);
    const result = await createCreditsCheckoutSession({
      userId: req.userId,
      email: user?.email,
      pack: req.body?.pack,
      req,
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}));

app.post("/api/billing/portal", wrap(async (req, res) => {
  if (req.tokenKind === "agent") return res.status(403).json({ error: "Agents can't manage billing." });
  try {
    const result = await createPortalSession({ userId: req.userId, req });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}));

app.get("/api/billing/crypto", wrap((req, res) => {
  res.json(cryptoPayConfig());
}));

app.post("/api/billing/crypto/invoice", wrap((req, res) => {
  if (req.tokenKind === "agent") return res.status(403).json({ error: "Agents can't manage billing." });
  const cfg = cryptoPayConfig();
  if (!cfg.enabled) {
    return res.status(503).json({ error: "Crypto payments are not enabled on this hub yet." });
  }
  const method = resolveCryptoMethod(req.body?.method || req.body?.asset);
  if (!method) {
    return res.status(503).json({ error: "No deposit addresses configured yet." });
  }
  const product = String(req.body?.product || "").trim();
  let amountUsd = 0;
  if (product === "creator") amountUsd = PLAN_PRICES.creator.monthly;
  else if (product === "studio") amountUsd = PLAN_PRICES.studio.monthly;
  else if (product.startsWith("credits_")) {
    const pack = product.replace("credits_", "");
    amountUsd = VIDEO_CREDIT_PACKS[pack]?.usd || 0;
  }
  if (!amountUsd) return res.status(400).json({ error: "Unknown product. Use creator, studio, or credits_5/15/40." });
  const user = getUser(req.userId);
  // Internal reference only — not shown to the payer (no memo required on-chain).
  const memo = `BS-${req.userId}-${Date.now().toString(36).slice(-6)}`.toUpperCase();
  const inv = createCryptoInvoice({
    userId: req.userId,
    email: user?.email || "",
    product,
    amountUsd,
    chain: method.chain,
    asset: method.asset,
    methodId: method.id,
    payTo: method.pay_to,
    memo,
    expectedRaw:
      method.asset === "USDC" || method.asset === "USDT"
        ? String(Math.round(amountUsd * 1e6))
        : null,
  });
  res.status(201).json({
    invoice: { id: inv.id, product: inv.product, amount_usd: amountUsd },
    method: method.id,
    pay_to: method.pay_to,
    chain: method.chain,
    asset: method.asset,
    label: method.label,
    token: method.token || null,
    note: cfg.note,
    amount_usd: amountUsd,
    auto_confirm: cfg.auto_confirm,
  });
}));

app.get("/api/imagine/voices", wrap((_req, res) => {
  res.json(listTtsVoices());
}));

/** Short sample so creators can hear a voice style before generating. */
app.post("/api/imagine/voices/preview", async (req, res) => {
  try {
    if (!requireTier(req, res, "studio")) return;
    if (!ttsConfigured()) {
      return res.status(503).json({ error: "Voice styles need XAI_API_KEY on the hub." });
    }
    const voiceId = String(req.body?.voice_id || "").trim().toLowerCase();
    const meta = getVoiceMeta(voiceId);
    if (!meta) {
      return res.status(400).json({ error: "Pick a voice style (eve, ara, rex, sal, or leo)." });
    }
    const text =
      String(req.body?.text || "").trim().slice(0, 220) ||
      meta.example ||
      `Hi — this is ${meta.label}, ${meta.vibe.toLowerCase()}.`;
    const { buf, mime } = await synthesizeSpeech(text, meta.id);
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(err.status && err.status < 600 ? err.status : 500).json({
      error: err.message || "Couldn't preview voice",
    });
  }
});

// ---- Profile (goals, projects, brand voice) ----

function readProfile(userId) {
  const row = db
    .prepare("SELECT goals, projects, brand_voice, traits, watermark_media_url FROM profiles WHERE user_id = ?")
    .get(userId) || { goals: "", projects: "", brand_voice: "", traits: "{}", watermark_media_url: null };
  let traits = {};
  try {
    traits = JSON.parse(row.traits || "{}");
  } catch {
    /* corrupted traits fall back to empty */
  }
  return {
    goals: row.goals,
    projects: row.projects,
    brand_voice: row.brand_voice,
    traits,
    watermark_media_url: row.watermark_media_url || null,
  };
}

/** Resolve a user's watermark image bytes from a /media/{id} URL they own. */
function loadWatermarkBuffer(userId, url) {
  if (!url) return null;
  const id = String(url).split("/").pop()?.split("?")[0];
  if (!id) return null;
  const row = db.prepare("SELECT * FROM media WHERE id = ? AND user_id = ?").get(id, userId);
  if (!row?.mime?.startsWith("image/")) return null;
  const file = join(mediaDir, row.id);
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}

function resolveWatermarkUrl(userId, requested) {
  const profileUrl = readProfile(userId).watermark_media_url;
  const url = requested === undefined || requested === null ? profileUrl : requested;
  if (!url) return null;
  // Must belong to this user.
  return loadWatermarkBuffer(userId, url) ? url : null;
}

app.get("/api/profile", wrap((req, res) => {
  res.json(readProfile(req.userId));
}));

app.put("/api/profile", wrap((req, res) => {
  if (req.tokenKind === "agent") {
    return res.status(403).json({ error: "Agents can't update the brand profile." });
  }
  const existing = readProfile(req.userId);
  const merged = mergeProfileUpdate(existing, req.body || {});
  const watermark_media_url = merged.watermark_media_url;
  let nextWm = existing.watermark_media_url;
  if (watermark_media_url !== undefined) {
    if (!watermark_media_url) {
      nextWm = null;
    } else if (loadWatermarkBuffer(req.userId, watermark_media_url)) {
      nextWm = watermark_media_url;
    } else {
      return res.status(400).json({ error: "Watermark must be an image you uploaded to this hub." });
    }
  }
  db.prepare(
    `INSERT INTO profiles (user_id, goals, projects, brand_voice, traits, watermark_media_url, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET goals = excluded.goals, projects = excluded.projects,
       brand_voice = excluded.brand_voice, traits = excluded.traits,
       watermark_media_url = excluded.watermark_media_url, updated_at = excluded.updated_at`
  ).run(
    req.userId,
    merged.goals,
    merged.projects,
    merged.brand_voice,
    JSON.stringify(merged.traits || {}),
    nextWm,
    now()
  );
  res.json(readProfile(req.userId));
}));

// ---- Ideas ----

app.get("/api/ideas", wrap((req, res) => {
  res.json(db.prepare("SELECT * FROM ideas WHERE user_id = ? ORDER BY created_at DESC").all(req.userId));
}));

app.post("/api/ideas", wrap((req, res) => {
  const text = (req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "text is required" });
  const info = db
    .prepare("INSERT INTO ideas (user_id, text, status, media_url, created_at) VALUES (?, ?, 'open', ?, ?)")
    .run(req.userId, text, req.body?.media_url || null, now());
  res.status(201).json(db.prepare("SELECT * FROM ideas WHERE id = ?").get(info.lastInsertRowid));
}));

app.patch("/api/ideas/:id", wrap((req, res) => {
  const { status, text } = req.body || {};
  const existing = db.prepare("SELECT * FROM ideas WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: "Not found" });
  db.prepare("UPDATE ideas SET status = ?, text = ? WHERE id = ?").run(
    status ?? existing.status,
    text ?? existing.text,
    existing.id
  );
  res.json(db.prepare("SELECT * FROM ideas WHERE id = ?").get(existing.id));
}));

app.delete("/api/ideas/:id", wrap((req, res) => {
  db.prepare("DELETE FROM ideas WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
  res.json({ ok: true });
}));

// ---- Drafts ----

function mediaMimeForUrl(url) {
  if (!url) return null;
  const id = String(url).split("/").pop()?.split("?")[0];
  if (!id) return null;
  return db.prepare("SELECT mime FROM media WHERE id = ?").get(id)?.mime || null;
}

function draftJson(row) {
  if (!row) return row;
  return {
    ...row,
    variants: safeParseVariants(row.variants),
    media_mime: mediaMimeForUrl(row.media_url),
    original_media_mime: mediaMimeForUrl(row.original_media_url),
  };
}

app.get("/api/drafts", wrap((req, res) => {
  const rows = db.prepare("SELECT * FROM drafts WHERE user_id = ? ORDER BY created_at DESC").all(req.userId);
  res.json(rows.map(draftJson));
}));

app.post("/api/drafts", wrap((req, res) => {
  if (!assertDraftQuota(req.userId, res)) return;
  const { idea_id = null, topic, variants, media_url = null } = req.body || {};
  const isAgent = req.tokenKind === "agent";
  // Agent drafts always enter the approval queue as plain drafts.
  const status = isAgent ? "draft" : req.body?.status || "draft";
  const source = isAgent ? "agent" : req.body?.source || "user";
  if (!topic || !variants) return res.status(400).json({ error: "topic and variants are required" });
  const info = db
    .prepare(
      "INSERT INTO drafts (user_id, idea_id, topic, variants, status, source, media_url, original_media_url, agent_key_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      req.userId,
      idea_id,
      topic,
      JSON.stringify(sanitizeVariants(variants)),
      status,
      source,
      media_url,
      media_url || null,
      req.agentKeyId || null,
      now()
    );
  const row = db.prepare("SELECT * FROM drafts WHERE id = ?").get(info.lastInsertRowid);
  res.status(201).json(draftJson(row));
}));

app.patch("/api/drafts/:id", wrap((req, res) => {
  const existing = db.prepare("SELECT * FROM drafts WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const { status, variants, topic, media_url } = req.body || {};
  // Agents may refine content but never approve it - only a human does that.
  if (req.tokenKind === "agent" && status && status !== "draft") {
    return res.status(403).json({ error: "Agents can't approve drafts. The user approves in the app." });
  }
  let nextMedia = media_url !== undefined ? media_url : existing.media_url;
  let nextOriginal = existing.original_media_url;
  if (media_url !== undefined && media_url && !existing.original_media_url) {
    // First attachment (or recovery): treat it as the restore point.
    nextOriginal = media_url;
  }
  db.prepare(
    "UPDATE drafts SET status = ?, variants = ?, topic = ?, media_url = ?, original_media_url = ? WHERE id = ?"
  ).run(
    status ?? existing.status,
    variants ? JSON.stringify(sanitizeVariants(variants)) : existing.variants,
    topic ?? existing.topic,
    nextMedia,
    nextOriginal,
    existing.id
  );
  const row = db.prepare("SELECT * FROM drafts WHERE id = ?").get(existing.id);
  res.json(draftJson(row));
}));

/** Restore draft media to the pre-Imagine capture/attachment. */
app.post("/api/drafts/:id/revert-media", wrap((req, res) => {
  const existing = db.prepare("SELECT * FROM drafts WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!existing.original_media_url) {
    return res.status(400).json({ error: "No original media to restore on this draft." });
  }
  if (existing.media_url === existing.original_media_url) {
    return res.json(draftJson(existing));
  }
  db.prepare("UPDATE drafts SET media_url = ? WHERE id = ? AND user_id = ?").run(
    existing.original_media_url,
    existing.id,
    req.userId
  );
  const row = db.prepare("SELECT * FROM drafts WHERE id = ?").get(existing.id);
  res.json(draftJson(row));
}));

app.delete("/api/drafts/:id", wrap((req, res) => {
  db.prepare("DELETE FROM drafts WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
  res.json({ ok: true });
}));

// ---- Generate: one idea -> platform variants, saved as a draft ----

const generateHits = new Map();
let generateInflight = 0;
const MAX_GENERATE_INFLIGHT = Math.max(4, Number(process.env.GENERATE_MAX_INFLIGHT || 16));

app.post("/api/generate", async (req, res) => {
  try {
    const wait = hitLimit(generateHits, req.userId, 12, 60_000);
    if (wait) {
      return res.status(429).json({ error: `Draft rate limit — try again in ${wait}s.` });
    }
    if (generateInflight >= MAX_GENERATE_INFLIGHT) {
      return res.status(429).json({
        error: "Lots of people are drafting right now — wait a few seconds and tap Draft now again.",
      });
    }
    if (!assertDraftQuota(req.userId, res)) return;

    const ideaId = req.body?.idea_id ?? null;
    let topic = (req.body?.topic || "").trim();
    let mediaUrl = req.body?.media_url || null;
    if (ideaId) {
      const idea = db.prepare("SELECT * FROM ideas WHERE id = ? AND user_id = ?").get(ideaId, req.userId);
      if (idea) {
        if (!topic) topic = idea.text;
        if (!mediaUrl) mediaUrl = idea.media_url;
      }
    }
    if (!topic) return res.status(400).json({ error: "topic or idea_id is required" });
    const blocked = findBlockedContent(topic);
    if (blocked) return res.status(400).json({ error: blocked });

    // If media is attached, hand images to vision so posts reflect
    // what's actually in the picture. (Videos can't be watched by the model.)
    let image = null;
    let isVideo = false;
    if (mediaUrl) {
      const mediaId = mediaUrl.split("/").pop();
      const media = db.prepare("SELECT * FROM media WHERE id = ? AND user_id = ?").get(mediaId, req.userId);
      const file = media && join(mediaDir, media.id);
      if (media && existsSync(file)) {
        if (media.mime.startsWith("image/") && statSync(file).size < 4.5 * 1024 * 1024) {
          image = { mime: media.mime, data: readFileSync(file).toString("base64") };
        } else if (media.mime.startsWith("video/")) {
          isVideo = true;
        }
      }
    }

    const profile = readProfile(req.userId);
    const providerPref = req.body?.text_provider || profile?.traits?.text_provider;
    generateInflight++;
    let variants;
    try {
      variants = await generateVariants({
        topic,
        profile,
        image,
        isVideo,
        provider: providerPref,
        platforms: req.body?.platforms,
      });
    } finally {
      generateInflight--;
    }

    const source = req.tokenKind === "agent" ? "agent" : "user";
    const info = db
      .prepare(
        "INSERT INTO drafts (user_id, idea_id, topic, variants, status, source, media_url, original_media_url, agent_key_id, created_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)"
      )
      .run(
        req.userId,
        ideaId,
        topic,
        JSON.stringify(sanitizeVariants(variants)),
        source,
        mediaUrl,
        mediaUrl || null,
        req.agentKeyId || null,
        now()
      );
    if (ideaId) db.prepare("UPDATE ideas SET status = 'drafted' WHERE id = ? AND user_id = ?").run(ideaId, req.userId);

    const row = db.prepare("SELECT * FROM drafts WHERE id = ?").get(info.lastInsertRowid);
    res.status(201).json(draftJson(row));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Generation failed" });
  }
});

// ---- Freeform chat with Claude (uses profile as context) ----

app.post("/api/chat", async (req, res) => {
  try {
    const message = (req.body?.message || "").trim();
    if (!message) return res.status(400).json({ error: "message is required" });
    const reply = await chat({ message, profile: readProfile(req.userId) });
    res.json({ reply: sanitizeCopy(reply) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Chat failed" });
  }
});

// ---- Schedule ----

app.get("/api/schedule", wrap((req, res) => {
  res.json(
    db.prepare("SELECT * FROM schedule_blocks WHERE user_id = ? ORDER BY weekday, start_time").all(req.userId)
  );
}));

app.post("/api/schedule", wrap((req, res) => {
  const { weekday, start_time, end_time, title, category = "light" } = req.body || {};
  const wd = Number(weekday);
  if (!wd || wd < 1 || wd > 7) return res.status(400).json({ error: "weekday must be 1 (Mon) to 7 (Sun)" });
  if (!start_time || !end_time || !title?.trim()) {
    return res.status(400).json({ error: "start_time, end_time and title are required" });
  }
  const info = db
    .prepare(
      "INSERT INTO schedule_blocks (user_id, weekday, start_time, end_time, title, category) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(req.userId, wd, start_time, end_time, title.trim(), category);
  res.status(201).json(db.prepare("SELECT * FROM schedule_blocks WHERE id = ?").get(info.lastInsertRowid));
}));

app.delete("/api/schedule/:id", wrap((req, res) => {
  db.prepare("DELETE FROM schedule_blocks WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
  res.json({ ok: true });
}));

app.patch("/api/schedule/:id", wrap((req, res) => {
  const existing = db
    .prepare("SELECT * FROM schedule_blocks WHERE id = ? AND user_id = ?")
    .get(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const { done, title, start_time, end_time, category, weekday } = req.body || {};
  let wd = existing.weekday;
  if (weekday !== undefined && weekday !== null && weekday !== "") {
    wd = Number(weekday);
    if (!wd || wd < 1 || wd > 7) return res.status(400).json({ error: "weekday must be 1 (Mon) to 7 (Sun)" });
  }
  db.prepare(
    "UPDATE schedule_blocks SET done = ?, title = ?, start_time = ?, end_time = ?, category = ?, weekday = ? WHERE id = ?"
  ).run(
    done === undefined ? existing.done : done ? 1 : 0,
    title ?? existing.title,
    start_time ?? existing.start_time,
    end_time ?? existing.end_time,
    category ?? existing.category,
    wd,
    existing.id
  );
  res.json(db.prepare("SELECT * FROM schedule_blocks WHERE id = ?").get(existing.id));
}));

app.post("/api/schedule/reset", wrap((req, res) => {
  db.prepare("UPDATE schedule_blocks SET done = 0 WHERE user_id = ?").run(req.userId);
  res.json({ ok: true });
}));

// Wipe every block so the user can rebuild their week from scratch.
app.post("/api/schedule/clear", wrap((req, res) => {
  db.prepare("DELETE FROM schedule_blocks WHERE user_id = ?").run(req.userId);
  res.json({ ok: true });
}));

// ---- Workouts ----

app.get("/api/workouts", wrap((req, res) => {
  res.json(db.prepare("SELECT * FROM workouts WHERE user_id = ? ORDER BY date DESC, id DESC").all(req.userId));
}));

app.post("/api/workouts", wrap((req, res) => {
  const { date, description, is_content_source = 1 } = req.body || {};
  if (!description) return res.status(400).json({ error: "description is required" });
  const info = db
    .prepare(
      "INSERT INTO workouts (user_id, date, description, is_content_source, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(req.userId, date || now().slice(0, 10), description, is_content_source ? 1 : 0, now());
  res.status(201).json(db.prepare("SELECT * FROM workouts WHERE id = ?").get(info.lastInsertRowid));
}));

app.patch("/api/workouts/:id", wrap((req, res) => {
  const existing = db.prepare("SELECT * FROM workouts WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const { draft_id, description, date } = req.body || {};
  db.prepare("UPDATE workouts SET draft_id = ?, description = ?, date = ? WHERE id = ?").run(
    draft_id ?? existing.draft_id,
    (description ?? existing.description) || existing.description,
    date ?? existing.date,
    existing.id
  );
  res.json(db.prepare("SELECT * FROM workouts WHERE id = ?").get(existing.id));
}));

app.delete("/api/workouts/:id", wrap((req, res) => {
  db.prepare("DELETE FROM workouts WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
  res.json({ ok: true });
}));

// ---- Social connections ----

app.get("/api/connections", wrap((req, res) => {
  const rows = db
    .prepare("SELECT platform, handle, created_at FROM connections WHERE user_id = ?")
    .all(req.userId);
  res.json({ providers: providerStatus(), connected: rows });
}));

app.post("/api/connect/x/start", wrap((req, res) => {
  const url = startXConnect(req.userId);
  // Bind this browser to the OAuth attempt so a stolen authorize URL can't
  // attach someone else's X account to the initiator (confused deputy).
  // Cross-site SPA (Vercel → Fly) needs SameSite=None; Secure for Set-Cookie.
  const secure = (process.env.HUB_PUBLIC_URL || "").startsWith("https");
  res.setHeader(
    "Set-Cookie",
    `x_oauth_user=${encodeURIComponent(String(req.userId))}; Path=/; HttpOnly; SameSite=${secure ? "None" : "Lax"}; Max-Age=${15 * 60}${secure ? "; Secure" : ""}`
  );
  res.json({ url });
}));

// Link connect key for Facebook / Instagram / TikTok / LinkedIn (unified publisher — Studio).
app.post("/api/connect/ayrshare", wrap((req, res) => {
  if (!requireTier(req, res, "studio")) return;
  const { profile_key, handle, platforms } = req.body || {};
  const result = connectUnified({
    userId: req.userId,
    profileKey: profile_key,
    handle,
    platforms,
  });
  res.status(201).json(result);
}));

app.delete("/api/connections/:platform", wrap((req, res) => {
  db.prepare("DELETE FROM connections WHERE user_id = ? AND platform = ?").run(req.userId, req.params.platform);
  res.json({ ok: true });
}));

// ---- Publish a draft variant to a connected platform ----

app.post("/api/posts", async (req, res) => {
  try {
    const { draft_id, platform } = req.body || {};
    if (!requirePublishTier(req, res, platform)) return;
    const draft = db.prepare("SELECT * FROM drafts WHERE id = ? AND user_id = ?").get(draft_id, req.userId);
    if (!draft) return res.status(404).json({ error: "Draft not found" });
    const variants = safeParseVariants(draft.variants);
    const raw = (variants[platform] || "").trim();
    if (!raw) return res.status(400).json({ error: `This draft has no ${platform} version.` });
    const text = withBrandTag(extractPostCaption(raw, platform), getTier(req.userId));

    const { externalId } = await publish({ userId: req.userId, platform, text });
    const info = db
      .prepare(
        "INSERT INTO posts (user_id, draft_id, platform, status, external_id, created_at) VALUES (?, ?, ?, 'posted', ?, ?)"
      )
      .run(req.userId, draft_id, platform, externalId || null, now());
    db.prepare("UPDATE drafts SET status = 'posted' WHERE id = ? AND user_id = ?").run(draft_id, req.userId);
    res.status(201).json(db.prepare("SELECT * FROM posts WHERE id = ?").get(info.lastInsertRowid));
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || "Posting failed" });
  }
});

// ---- Scheduled posts (queue published by the interval worker below) ----

app.post("/api/posts/schedule", wrap((req, res) => {
  const { draft_id, platform, scheduled_at } = req.body || {};
  if (!requirePublishTier(req, res, platform)) return;
  const draft = db.prepare("SELECT * FROM drafts WHERE id = ? AND user_id = ?").get(draft_id, req.userId);
  if (!draft) return res.status(404).json({ error: "Draft not found" });
  const when = new Date(scheduled_at || "");
  if (Number.isNaN(when.getTime()) || when.getTime() < Date.now() - 60_000) {
    return res.status(400).json({ error: "scheduled_at must be a valid future time" });
  }
  const variants = safeParseVariants(draft.variants);
  if (!(variants[platform] || "").trim()) {
    return res.status(400).json({ error: `This draft has no ${platform} version.` });
  }
  const info = db
    .prepare(
      "INSERT INTO scheduled_posts (user_id, draft_id, platform, scheduled_at, status, created_at) VALUES (?, ?, ?, ?, 'scheduled', ?)"
    )
    .run(req.userId, draft_id, platform, when.toISOString(), now());
  res.status(201).json(db.prepare("SELECT * FROM scheduled_posts WHERE id = ?").get(info.lastInsertRowid));
}));

app.get("/api/posts/scheduled", wrap((req, res) => {
  const rows = db
    .prepare(
      `SELECT sp.*,
              d.topic AS draft_topic,
              d.media_url AS draft_media_url,
              d.status AS draft_status,
              d.variants AS draft_variants
       FROM scheduled_posts sp
       LEFT JOIN drafts d ON d.id = sp.draft_id AND d.user_id = sp.user_id
       WHERE sp.user_id = ?
       ORDER BY
         CASE sp.status
           WHEN 'scheduled' THEN 0
           WHEN 'publishing' THEN 1
           WHEN 'failed' THEN 2
           ELSE 3
         END,
         sp.scheduled_at ASC
       LIMIT 200`
    )
    .all(req.userId);

  res.json(
    rows.map((row) => {
      let preview = "";
      try {
        const variants = safeParseVariants(row.draft_variants);
        preview = extractPostCaption(String(variants[row.platform] || "").trim(), row.platform);
      } catch {
        preview = "";
      }
      const { draft_variants, ...rest } = row;
      return {
        ...rest,
        draft_topic: row.draft_topic || `Draft #${row.draft_id}`,
        draft_preview: preview.slice(0, 160),
        draft_media_url: row.draft_media_url || null,
        draft_status: row.draft_status || null,
      };
    })
  );
}));

app.delete("/api/posts/scheduled/:id", wrap((req, res) => {
  db.prepare("DELETE FROM scheduled_posts WHERE id = ? AND user_id = ? AND status = 'scheduled'").run(
    req.params.id,
    req.userId
  );
  res.json({ ok: true });
}));

// Re-queue a failed scheduled post (optionally with a new time).
app.post("/api/posts/scheduled/:id/retry", wrap((req, res) => {
  if (!requireTier(req, res, "creator")) return;
  const existing = db
    .prepare("SELECT * FROM scheduled_posts WHERE id = ? AND user_id = ?")
    .get(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (existing.status !== "failed") {
    return res.status(400).json({ error: "Only failed posts can be retried." });
  }
  let when = existing.scheduled_at;
  if (req.body?.scheduled_at) {
    const t = new Date(req.body.scheduled_at);
    if (Number.isNaN(t.getTime()) || t.getTime() < Date.now() - 60_000) {
      return res.status(400).json({ error: "scheduled_at must be a valid future time" });
    }
    when = t.toISOString();
  } else if (new Date(when).getTime() < Date.now()) {
    // Past due — retry in 2 minutes.
    when = new Date(Date.now() + 120_000).toISOString();
  }
  db.prepare(
    "UPDATE scheduled_posts SET status = 'scheduled', scheduled_at = ?, error = NULL WHERE id = ?"
  ).run(when, existing.id);
  res.json(db.prepare("SELECT * FROM scheduled_posts WHERE id = ?").get(existing.id));
}));

app.get("/api/posts", wrap((req, res) => {
  const draftId = req.query.draft_id;
  const rows = draftId
    ? db.prepare("SELECT * FROM posts WHERE user_id = ? AND draft_id = ? ORDER BY id DESC").all(req.userId, draftId)
    : db.prepare("SELECT * FROM posts WHERE user_id = ? ORDER BY id DESC LIMIT 200").all(req.userId);
  res.json(rows);
}));

// ---- Media uploads (raw body; served publicly at /media/:id) ----

const MEDIA_TYPES = {
  "image/jpeg": true,
  "image/png": true,
  "image/webp": true,
  "image/gif": true,
  "image/heic": true, // iPhone camera stills
  "image/heif": true,
  "video/mp4": true,
  "video/webm": true,
  "video/quicktime": true, // iPhone camera video (.mov)
  "video/3gpp": true, // older Android camcorders
};

/** Per-user rate limits for upload / Imagine (abuse protection). */
const mediaHits = new Map();
const imagineHits = new Map();
function hitLimit(map, key, limit, windowMs) {
  const nowMs = Date.now();
  const entry = map.get(key);
  if (!entry || entry.resetAt < nowMs) {
    map.set(key, { count: 1, resetAt: nowMs + windowMs });
    return null;
  }
  if (entry.count >= limit) {
    return Math.ceil((entry.resetAt - nowMs) / 1000);
  }
  entry.count++;
  return null;
}

function pendingImagineCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM imagine_jobs WHERE status = 'pending'").get()?.n || 0;
}

function imagineQueueFull() {
  const max = Math.max(1, Number(process.env.IMAGINE_MAX_INFLIGHT || 6));
  return pendingImagineCount() >= max;
}

/** Magic-byte sniff so Content-Type alone can't smuggle executables. */
function sniffMediaKind(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image";
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image";
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "video";
  // ISO BMFF (mp4 / mov / heic): ....ftyp
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = buf.slice(8, 12).toString("ascii").toLowerCase();
    if (brand.includes("heic") || brand.includes("heif") || brand.includes("mif1") || brand.includes("msf1")) {
      return "image";
    }
    return "video";
  }
  // Reject PE / ELF / Mach-O / scripts that sometimes arrive as "video/mp4"
  if (buf[0] === 0x4d && buf[1] === 0x5a) return "reject"; // MZ
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return "reject"; // ELF
  if (buf[0] === 0x23 && buf[1] === 0x21) return "reject"; // #!
  return null;
}

app.post(
  "/api/media",
  express.raw({ type: () => true, limit: "25mb" }),
  wrap((req, res) => {
    const wait = hitLimit(mediaHits, req.userId, 40, 60_000);
    if (wait) {
      return res.status(429).json({ error: `Upload rate limit — try again in ${wait}s.` });
    }
    const mime = (req.get("content-type") || "").split(";")[0].trim();
    if (!MEDIA_TYPES[mime]) return res.status(415).json({ error: `Unsupported media type: ${mime}` });
    if (!req.body?.length) return res.status(400).json({ error: "Empty upload" });
    const kind = sniffMediaKind(req.body);
    if (kind === "reject" || !kind) {
      return res.status(415).json({ error: "File doesn't look like an image or video." });
    }
    if (kind === "image" && !mime.startsWith("image/")) {
      return res.status(415).json({ error: "Content-Type must match image upload." });
    }
    if (kind === "video" && !mime.startsWith("video/")) {
      return res.status(415).json({ error: "Content-Type must match video upload." });
    }
    const id = randomBytes(16).toString("hex");
    writeFileSync(join(mediaDir, id), req.body);
    db.prepare("INSERT INTO media (id, user_id, mime, size, created_at) VALUES (?, ?, ?, ?, ?)").run(
      id,
      req.userId,
      mime,
      req.body.length,
      now()
    );
    const base = (process.env.HUB_PUBLIC_URL || "").replace(/\/$/, "");
    res.status(201).json({ id, url: `${base}/media/${id}`, mime });
  })
);

// ---- Grok Imagine (Studio): AI clip / still for drafts ----

function imagineUsage(userId) {
  const stills = stillUsage(userId);
  const videos = videoUsage(userId);
  return {
    configured: imagineConfigured(),
    used: videos.used,
    limit: videos.included,
    stills,
    videos,
  };
}

function publicMediaUrl(mediaId) {
  const base = (process.env.HUB_PUBLIC_URL || "").replace(/\/$/, "");
  return `${base}/media/${mediaId}`;
}

function saveDownloadedMedia(userId, buf, mime) {
  const id = randomBytes(16).toString("hex");
  writeFileSync(join(mediaDir, id), buf);
  db.prepare("INSERT INTO media (id, user_id, mime, size, created_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    userId,
    mime,
    buf.length,
    now()
  );
  return { id, url: publicMediaUrl(id), mime };
}

/** Mark a job failed and refund a purchased credit if one was charged. */
function failImagineJob(job, error, { progress = 100 } = {}) {
  if (!job?.id) return;
  const ts = now();
  db.prepare(
    "UPDATE imagine_jobs SET status = 'failed', error = ?, progress = ?, updated_at = ? WHERE id = ? AND status = 'pending'"
  ).run(String(error || "Generation failed").slice(0, 400), progress, ts, job.id);
  if (job.credit_charged) {
    refundVideoCredit(job.user_id);
    db.prepare("UPDATE imagine_jobs SET credit_charged = 0 WHERE id = ?").run(job.id);
  }
}

async function syncImagineJob(job) {
  if (!job || job.status !== "pending" || !job.xai_request_id) return job;
  try {
    const poll = await pollVideo(job.xai_request_id);
    const ts = now();
    if (poll.status === "pending") {
      db.prepare("UPDATE imagine_jobs SET progress = ?, updated_at = ? WHERE id = ?").run(
        poll.progress ?? job.progress ?? 0,
        ts,
        job.id
      );
    } else if (poll.status === "done" && poll.url) {
      if (poll.respectModeration === false) {
        failImagineJob(job, "Generated clip did not pass moderation.");
      } else {
        let { buf, mime } = await downloadBinary(poll.url);
        mime = mime.startsWith("video/") ? mime : "video/mp4";
        // Cap in-memory processing — huge buffers OOMed the Fly VM.
        if (buf.length > 40 * 1024 * 1024) {
          failImagineJob(job, "Generated clip was too large to process. Try again without extra overlays.");
          return db.prepare("SELECT * FROM imagine_jobs WHERE id = ?").get(job.id);
        }

        // Save the raw clip while still pending so a hung overlay/TTS doesn't lose the xAI result.
        // Do NOT mark done yet — clients would load the URL, then it can swap after voice/overlay.
        let saved = saveDownloadedMedia(job.user_id, buf, mime);
        db.prepare(
          "UPDATE imagine_jobs SET progress = 96, media_url = ?, error = NULL, updated_at = ? WHERE id = ?"
        ).run(saved.url, ts, job.id);
        const draftRow = db
          .prepare("SELECT * FROM drafts WHERE id = ? AND user_id = ?")
          .get(job.draft_id, job.user_id);
        if (draftRow) replaceDraftMedia(draftRow, saved.url);

        const overlayText = normalizeOnScreen(job.overlay_text || "");
        let post = buf;
        let watermarkWarning = null;
        if (overlayText) {
          try {
            post = await burnTextOntoVideo(post, overlayText);
          } catch (e) {
            console.warn("overlay video", job.id, e.message);
          }
        }
        if (job.voice_id && job.voice_id !== "none") {
          try {
            let narr = String(job.narration_text || "").trim();
            if (!narr) {
              const draft = db.prepare("SELECT variants, topic FROM drafts WHERE id = ?").get(job.draft_id);
              const variants = safeParseVariants(draft?.variants);
              const script = Object.values(variants)[0] || "";
              const labels = parseFilmLabels(script);
              narr = narrationFromLabels(labels) || String(draft?.topic || "").slice(0, 200);
            }
            if (narr && ttsConfigured()) {
              const speech = await synthesizeSpeech(narr, job.voice_id);
              post = await muxNarrationOntoVideo(post, speech.buf, { audioExt: speech.ext });
            }
          } catch (e) {
            console.warn("voice mux", job.id, e.message);
          }
        }
        // Social-safe encode before watermark so the mark lands on the final shareable frames.
        let socialized = false;
        try {
          const social = await normalizeVideoForShare(post);
          if (social?.length && social !== post) {
            post = social;
            socialized = true;
          }
        } catch (e) {
          console.warn("social normalize", job.id, e.message);
        }
        if (job.watermark) {
          try {
            const profile = readProfile(job.user_id);
            const wmBuf = loadWatermarkBuffer(job.user_id, profile.watermark_media_url);
            if (!wmBuf) {
              watermarkWarning =
                "Clip ready — watermark missing from Brand Brain. Upload a logo in Setup and regenerate.";
              console.warn("watermark video", job.id, "no watermark media on profile");
            } else {
              post = await burnWatermarkOntoVideo(post, wmBuf, { position: "br" });
              socialized = true; // watermark re-encodes as social-safe H.264
            }
          } catch (e) {
            watermarkWarning = `Clip ready — watermark failed (${e.message || "encode error"}). Try again.`;
            console.warn("watermark video", job.id, e.message);
          }
        }

        // Prefer post-processed / social-safe bytes; fall back to the raw clip already on the draft.
        if ((socialized || post !== buf) && post?.length) {
          try {
            saved = saveDownloadedMedia(job.user_id, post, mime);
            if (draftRow) replaceDraftMedia(draftRow, saved.url);
          } catch (e) {
            console.warn("post-process save", job.id, e.message);
          }
        }
        db.prepare(
          "UPDATE imagine_jobs SET status = 'done', progress = 100, media_url = ?, error = ?, updated_at = ? WHERE id = ?"
        ).run(saved.url, watermarkWarning, now(), job.id);
      }
    } else if (poll.status === "failed" || poll.status === "expired") {
      failImagineJob(job, poll.error || `Generation ${poll.status}`, {
        progress: poll.progress ?? 0,
      });
    }
  } catch (err) {
    console.error("imagine sync", job.id, err.message);
  }
  return db.prepare("SELECT * FROM imagine_jobs WHERE id = ?").get(job.id);
}

function jobJson(row) {
  return {
    id: row.id,
    draft_id: row.draft_id,
    kind: row.kind,
    status: row.status,
    progress: row.progress ?? 0,
    prompt: row.prompt,
    error: row.error,
    media_url: row.media_url,
    watermark: Boolean(row.watermark),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

app.get("/api/imagine/status", wrap((req, res) => {
  const tier = getTier(req.userId);
  const usage = imagineUsage(req.userId);
  res.json({
    ...usage,
    tier,
    studio: tier === "studio" || req.userId === 1,
    creator: ["creator", "studio"].includes(tier) || req.userId === 1,
    voices: listTtsVoices(),
  });
}));

app.post("/api/imagine/video", async (req, res) => {
  try {
    const wait = hitLimit(imagineHits, req.userId, 20, 60_000);
    if (wait) {
      return res.status(429).json({ error: `AI generation rate limit — try again in ${wait}s.` });
    }
    const tier = getTier(req.userId);
    const isStudio = tier === "studio" || req.userId === 1;
    let usage = videoUsage(req.userId);
    if (!isStudio && usage.credits <= 0) {
      return res.status(402).json({
        error: "AI video is a Studio feature — upgrade, or buy video credits on Setup.",
        upgrade: "studio",
      });
    }
    if (!imagineConfigured()) {
      return res.status(503).json({
        error: "AI clip generation is not configured. Add XAI_API_KEY on the hub.",
      });
    }
    if (imagineQueueFull()) {
      return res.status(429).json({
        error: "AI clips are busy — wait a minute and try again. A few generate at a time so the server stays fast.",
      });
    }
    if (usage.remaining <= 0) {
      return res.status(429).json({
        error: isStudio
          ? `You've used your ${usage.included} included clips this month. Buy more credits on Setup, or wait until the 1st.`
          : "No video credits left. Buy a pack on Setup.",
        ...usage,
      });
    }

    const draftId = Number(req.body?.draft_id);
    if (!draftId) return res.status(400).json({ error: "draft_id is required" });
    const draft = db.prepare("SELECT * FROM drafts WHERE id = ? AND user_id = ?").get(draftId, req.userId);
    if (!draft) return res.status(404).json({ error: "Draft not found" });

    const platform = req.body?.platform || "tiktok";
    const variants = safeParseVariants(draft.variants);
    const script = (req.body?.script || variants[platform] || variants.tiktok || Object.values(variants)[0] || "").trim();
    const labels = parseFilmLabels(script);
    const profile = readProfile(req.userId);
    // Never let the model paint text — hub overlays exact ON_SCREEN after generation.
    const wantOverlay = req.body?.overlay !== false;
    let overlayText = normalizeOnScreen(
      req.body?.overlay_text || req.body?.on_screen || labels.onScreen || ""
    );
    const voiceId = String(req.body?.voice_id || "none").trim() || "none";
    const narrationText =
      voiceId !== "none"
        ? String(req.body?.narration || "")
            .trim()
            .slice(0, 900) ||
          narrationFromLabels(labels) ||
          String(draft.topic || "").slice(0, 200)
        : null;
    const rawPrompt =
      (req.body?.prompt || "").trim() ||
      labels.imagine ||
      buildVideoPrompt({
        topic: draft.topic,
        hook: labels.hook,
        beats: labels.beats,
        onScreen: labels.onScreen,
        keyword: labels.keyword,
        brandVoice: profile.brand_voice,
        vibe: profile.traits?.vibe,
        content_style: profile.traits?.content_style,
        target_audience: profile.traits?.target_audience,
      });
    const sanitized = sanitizeImaginePrompt(rawPrompt);
    const prompt = sanitized.prompt;
    const blockedPrompt = findBlockedContent(prompt) || findBlockedContent(draft.topic);
    if (blockedPrompt) return res.status(400).json({ error: blockedPrompt });
    if (!overlayText && sanitized.extractedOnScreen) {
      overlayText = normalizeOnScreen(sanitized.extractedOnScreen);
    }

    let imageUrl = null;
    if (draft.media_url) {
      const mediaId = draft.media_url.split("/").pop();
      const media = db.prepare("SELECT * FROM media WHERE id = ? AND user_id = ?").get(mediaId, req.userId);
      if (media?.mime?.startsWith("image/")) {
        imageUrl = draft.media_url.startsWith("http") ? draft.media_url : publicMediaUrl(media.id);
      }
    }
    if (req.body?.image_url) imageUrl = req.body.image_url;

    const wantWatermark = req.body?.watermark !== false && Boolean(resolveWatermarkUrl(req.userId));
    const duration = Math.min(8, Math.max(4, Number(req.body?.duration) || 6));

    let burnedCredit = false;
    if (usage.included_remaining <= 0) {
      if (!consumeVideoCredit(req.userId)) {
        return res.status(429).json({
          error: "No video credits left. Buy a pack on Setup.",
          ...videoUsage(req.userId),
        });
      }
      burnedCredit = true;
    }

    let requestId;
    try {
      ({ requestId } = await startVideoGeneration({
        prompt,
        imageUrl,
        duration,
        aspectRatio: req.body?.aspect_ratio || "9:16",
        // 720p is the durable default — 1080p OOMed the small Fly VM during overlay.
        resolution: req.body?.resolution || "720p",
      }));
    } catch (err) {
      if (burnedCredit) refundVideoCredit(req.userId);
      throw err;
    }

    const ts = now();
    const info = db
      .prepare(
        `INSERT INTO imagine_jobs (user_id, draft_id, kind, xai_request_id, status, progress, prompt, overlay_text, voice_id, narration_text, credit_charged, watermark, created_at, updated_at)
         VALUES (?, ?, 'video', ?, 'pending', 0, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        req.userId,
        draftId,
        requestId,
        prompt,
        wantOverlay ? overlayText : null,
        voiceId !== "none" ? voiceId : null,
        narrationText,
        burnedCredit ? 1 : 0,
        wantWatermark ? 1 : 0,
        ts,
        ts
      );

    const row = db.prepare("SELECT * FROM imagine_jobs WHERE id = ?").get(info.lastInsertRowid);
    res.status(201).json({ ...jobJson(row), usage: videoUsage(req.userId) });
  } catch (err) {
    console.error(err);
    res.status(err.status && err.status < 600 ? err.status : 500).json({
      error: err.message || "Failed to start AI clip",
    });
  }
});

app.post("/api/imagine/still", async (req, res) => {
  try {
    const wait = hitLimit(imagineHits, req.userId, 30, 60_000);
    if (wait) {
      return res.status(429).json({ error: `AI generation rate limit — try again in ${wait}s.` });
    }
    if (!requireTier(req, res, "creator")) return;
    if (!imagineConfigured()) {
      return res.status(503).json({
        error: "AI image generation is not configured. Add XAI_API_KEY on the hub.",
      });
    }
    if (imagineQueueFull()) {
      return res.status(429).json({
        error: "AI images are busy — wait a minute and try again.",
      });
    }
    const usage = stillUsage(req.userId);
    if (usage.remaining <= 0) {
      return res.status(429).json({
        error:
          usage.limit === 0
            ? "AI stills are on Creator+. Upgrade to unlock."
            : `You've used all ${usage.limit} AI stills this month. Limit resets on the 1st.`,
        upgrade: usage.limit === 0 ? "creator" : undefined,
        ...usage,
      });
    }

    const draftId = Number(req.body?.draft_id);
    if (!draftId) return res.status(400).json({ error: "draft_id is required" });
    const draft = db.prepare("SELECT * FROM drafts WHERE id = ? AND user_id = ?").get(draftId, req.userId);
    if (!draft) return res.status(404).json({ error: "Draft not found" });

    const platform = req.body?.platform || "tiktok";
    const variants = safeParseVariants(draft.variants);
    const script = (variants[platform] || variants.tiktok || "").trim();
    const labels = parseFilmLabels(script);
    const rawPrompt =
      (req.body?.prompt || "").trim() ||
      `Vertical 9:16 social still for TikTok/Reels. Topic: ${draft.topic}. Hook: ${labels.hook || draft.topic}. Visual focus (no text): ${labels.onScreen || labels.hook}. Clean, scroll-stopping.`;
    const sanitized = sanitizeImaginePrompt(rawPrompt, { forStill: true });
    const prompt = sanitized.prompt;
    const blockedPrompt = findBlockedContent(prompt) || findBlockedContent(draft.topic);
    if (blockedPrompt) return res.status(400).json({ error: blockedPrompt });

    const wantOverlay = req.body?.overlay !== false;
    let overlayText = normalizeOnScreen(
      req.body?.overlay_text || req.body?.on_screen || labels.onScreen || ""
    );
    if (!overlayText && sanitized.extractedOnScreen) {
      overlayText = normalizeOnScreen(sanitized.extractedOnScreen);
    }
    const wantWatermark = req.body?.watermark !== false && Boolean(resolveWatermarkUrl(req.userId));
    const { url } = await generateStill({ prompt, aspectRatio: "9:16" });
    let { buf, mime } = await downloadBinary(url);
    mime = mime.startsWith("image/") ? mime : "image/png";
    if (wantOverlay && overlayText) {
      try {
        buf = await burnTextOntoImage(buf, overlayText);
        mime = "image/jpeg";
      } catch (e) {
        console.warn("overlay still", e.message);
      }
    }
    if (wantWatermark) {
      try {
        const wmUrl = resolveWatermarkUrl(req.userId);
        const wmBuf = loadWatermarkBuffer(req.userId, wmUrl);
        if (wmBuf) {
          buf = await burnWatermarkOntoImage(buf, wmBuf);
          mime = "image/jpeg";
        }
      } catch (e) {
        console.warn("watermark still", e.message);
      }
    }
    const saved = saveDownloadedMedia(req.userId, buf, mime);
    replaceDraftMedia(draft, saved.url);

    const ts = now();
    const info = db
      .prepare(
        `INSERT INTO imagine_jobs (user_id, draft_id, kind, xai_request_id, status, progress, prompt, overlay_text, watermark, media_url, created_at, updated_at)
         VALUES (?, ?, 'still', NULL, 'done', 100, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        req.userId,
        draftId,
        prompt,
        wantOverlay ? overlayText : null,
        wantWatermark ? 1 : 0,
        saved.url,
        ts,
        ts
      );

    const row = db.prepare("SELECT * FROM imagine_jobs WHERE id = ?").get(info.lastInsertRowid);
    res.status(201).json({ ...jobJson(row), draft_media_url: saved.url, usage: stillUsage(req.userId) });
  } catch (err) {
    console.error(err);
    res.status(err.status && err.status < 600 ? err.status : 500).json({
      error: err.message || "Failed to generate still",
    });
  }
});

/** Edit an existing draft photo with Grok Imagine (counts toward still allowance). */
app.post("/api/imagine/edit", async (req, res) => {
  try {
    if (!requireTier(req, res, "creator")) return;
    if (!imagineConfigured()) {
      return res.status(503).json({
        error: "AI image editing is not configured. Add XAI_API_KEY on the hub.",
      });
    }
    const usage = stillUsage(req.userId);
    if (usage.remaining <= 0) {
      return res.status(429).json({
        error:
          usage.limit === 0
            ? "Photo edits are on Creator+. Upgrade to unlock."
            : `You've used all ${usage.limit} AI stills/edits this month. Limit resets on the 1st.`,
        upgrade: usage.limit === 0 ? "creator" : undefined,
        ...usage,
      });
    }

    const draftId = Number(req.body?.draft_id);
    if (!draftId) return res.status(400).json({ error: "draft_id is required" });
    const draft = db.prepare("SELECT * FROM drafts WHERE id = ? AND user_id = ?").get(draftId, req.userId);
    if (!draft) return res.status(404).json({ error: "Draft not found" });
    if (!draft.media_url) {
      return res.status(400).json({ error: "This draft has no photo to edit. Attach one first." });
    }

    const mediaId = String(draft.media_url).split("/").pop()?.split("?")[0];
    const media = mediaId
      ? db.prepare("SELECT * FROM media WHERE id = ? AND user_id = ?").get(mediaId, req.userId)
      : null;
    if (media && !media.mime?.startsWith("image/")) {
      return res.status(400).json({ error: "Only photos can be edited — not video clips." });
    }

    const presetKey = String(req.body?.preset || "").trim();
    const custom = String(req.body?.prompt || "").trim();
    const prompt = custom || STILL_EDIT_PRESETS[presetKey] || null;
    if (!prompt) {
      return res.status(400).json({
        error: "Pick a quick fix (brighten, clean background…) or describe the change.",
      });
    }

    let imageUrl = draft.media_url.startsWith("http")
      ? draft.media_url
      : media
        ? publicMediaUrl(media.id)
        : draft.media_url;
    if (media) {
      try {
        const filePath = join(mediaDir, media.id);
        if (existsSync(filePath)) {
          const buf = readFileSync(filePath);
          const b64 = buf.toString("base64");
          imageUrl = `data:${media.mime || "image/jpeg"};base64,${b64}`;
        }
      } catch {
        /* fall back to public URL */
      }
    }

    const { url } = await editStill({ imageUrl, prompt, aspectRatio: "9:16" });
    const { buf, mime } = await downloadBinary(url);
    const saved = saveDownloadedMedia(req.userId, buf, mime.startsWith("image/") ? mime : "image/png");
    replaceDraftMedia(draft, saved.url);

    const ts = now();
    const info = db
      .prepare(
        `INSERT INTO imagine_jobs (user_id, draft_id, kind, xai_request_id, status, progress, prompt, media_url, created_at, updated_at)
         VALUES (?, ?, 'edit', NULL, 'done', 100, ?, ?, ?, ?)`
      )
      .run(req.userId, draftId, prompt, saved.url, ts, ts);

    const row = db.prepare("SELECT * FROM imagine_jobs WHERE id = ?").get(info.lastInsertRowid);
    res.status(201).json({ ...jobJson(row), draft_media_url: saved.url, usage: stillUsage(req.userId) });
  } catch (err) {
    console.error(err);
    res.status(err.status && err.status < 600 ? err.status : 500).json({
      error: err.message || "Failed to edit photo",
    });
  }
});

app.get("/api/imagine/jobs/:id", async (req, res) => {
  try {
    let job = db
      .prepare("SELECT * FROM imagine_jobs WHERE id = ? AND user_id = ?")
      .get(req.params.id, req.userId);
    if (!job) return res.status(404).json({ error: "Not found" });
    if (job.status === "pending") job = await syncImagineJob(job);
    res.json(jobJson(job));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to load job" });
  }
});

app.get("/api/imagine/jobs", wrap((req, res) => {
  const draftId = req.query.draft_id ? Number(req.query.draft_id) : null;
  let rows;
  if (draftId) {
    rows = db
      .prepare(
        "SELECT * FROM imagine_jobs WHERE user_id = ? AND draft_id = ? ORDER BY created_at DESC LIMIT 20"
      )
      .all(req.userId, draftId);
  } else {
    rows = db
      .prepare("SELECT * FROM imagine_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50")
      .all(req.userId);
  }
  res.json(rows.map(jobJson));
}));

// ---- Agent / API keys ----

app.get("/api/keys", wrap((req, res) => {
  res.json(
    db.prepare("SELECT id, name, created_at, last_used_at FROM api_keys WHERE user_id = ?").all(req.userId)
  );
}));

app.post("/api/keys", wrap((req, res) => {
  if (!requireTier(req, res, "studio")) return;
  const name = (req.body?.name || "").trim() || "My agent";
  const key = "ak_" + randomBytes(24).toString("hex");
  const keyHash = createHash("sha256").update(key).digest("hex");
  const info = db
    .prepare("INSERT INTO api_keys (user_id, name, key_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(req.userId, name, keyHash, now());
  // The plaintext key is shown exactly once.
  res.status(201).json({ id: Number(info.lastInsertRowid), name, key });
}));

app.delete("/api/keys/:id", wrap((req, res) => {
  db.prepare("DELETE FROM api_keys WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
  res.json({ ok: true });
}));

// ---- Algorithm context (for agents + Insights refresh) ----

app.get("/api/algo/context", wrap((_req, res) => {
  const knowledge = algoKnowledgeAsOf();
  res.json({ ...knowledge, agent_brief: agentAlgoBrief() });
}));

// ---- Insights (content gaps / algo research pushed by agents) ----

app.get("/api/growth/status", wrap((req, res) => {
  res.json(getGrowthStatus(req.userId));
}));

app.get("/api/insights", wrap((req, res) => {
  res.json(
    db
      .prepare("SELECT * FROM insights WHERE user_id = ? AND status != 'dismissed' ORDER BY created_at DESC LIMIT 100")
      .all(req.userId)
  );
}));

app.post("/api/insights", wrap((req, res) => {
  if (!requireTier(req, res, "studio")) return;
  const { title, body, platform = "" } = req.body || {};
  if (!title?.trim() || !body?.trim()) return res.status(400).json({ error: "title and body are required" });
  const source = req.tokenKind === "agent" ? "agent" : "user";
  const info = db
    .prepare(
      "INSERT INTO insights (user_id, platform, title, body, source, api_key_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'new', ?)"
    )
    .run(req.userId, platform, title.trim(), body.trim(), source, req.agentKeyId || null, now());
  res.status(201).json(db.prepare("SELECT * FROM insights WHERE id = ?").get(info.lastInsertRowid));
}));

// On-demand weekly analysis: the user can pull fresh AI growth tips once
// per week (the worker also pushes them automatically).
app.post("/api/insights/refresh", async (req, res) => {
  try {
    if (req.tokenKind === "agent") return res.status(403).json({ error: "Only the user can refresh their tips." });
    if (!requireTier(req, res, "creator")) return;
    if (tipsAreFresh(req.userId)) {
      return res.status(429).json({ error: "Your weekly analysis is already fresh. New tips unlock 7 days after the last batch." });
    }
    const rows = await generateTipsFor(req.userId);
    res.status(201).json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Could not generate tips" });
  }
});

app.patch("/api/insights/:id", wrap((req, res) => {
  if (req.tokenKind === "agent") return res.status(403).json({ error: "Only the user can update insights." });
  const existing = db.prepare("SELECT * FROM insights WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const status = req.body?.status;
  if (!["new", "used", "dismissed"].includes(status)) return res.status(400).json({ error: "Invalid status" });
  db.prepare("UPDATE insights SET status = ? WHERE id = ?").run(status, existing.id);
  res.json(db.prepare("SELECT * FROM insights WHERE id = ?").get(existing.id));
}));

// ---- Agent analytics (session-only; not reachable with an agent key) ----

app.get("/api/agent/stats", wrap((req, res) => {
  const keys = db
    .prepare("SELECT id, name, created_at, last_used_at FROM api_keys WHERE user_id = ?")
    .all(req.userId);
  const stats = keys.map((k) => {
    const drafts = db
      .prepare("SELECT status, COUNT(*) AS n FROM drafts WHERE user_id = ? AND agent_key_id = ? GROUP BY status")
      .all(req.userId, k.id);
    const byStatus = Object.fromEntries(drafts.map((d) => [d.status, d.n]));
    const total = drafts.reduce((s, d) => s + d.n, 0);
    const requests = db
      .prepare("SELECT COUNT(*) AS n FROM agent_events WHERE api_key_id = ?")
      .get(k.id).n;
    const insightsCount = db
      .prepare("SELECT COUNT(*) AS n FROM insights WHERE api_key_id = ?")
      .get(k.id).n;
    return {
      ...k,
      drafts_total: total,
      drafts_draft: byStatus.draft || 0,
      drafts_approved: byStatus.approved || 0,
      drafts_posted: byStatus.posted || 0,
      approval_rate: total ? Math.round((((byStatus.approved || 0) + (byStatus.posted || 0)) / total) * 100) : null,
      requests,
      insights: insightsCount,
    };
  });
  const events = db
    .prepare(
      `SELECT e.method, e.route, e.created_at, k.name AS key_name
       FROM agent_events e JOIN api_keys k ON k.id = e.api_key_id
       WHERE e.user_id = ? ORDER BY e.id DESC LIMIT 30`
    )
    .all(req.userId);
  res.json({ keys: stats, events });
}));

// ---- Export all of a user's data ----

app.get("/api/export", wrap((req, res) => {
  const u = req.userId;
  res.json({
    exported_at: now(),
    profile: exportProfilePayload(readProfile(u)),
    ideas: db.prepare("SELECT * FROM ideas WHERE user_id = ?").all(u),
    drafts: db
      .prepare("SELECT * FROM drafts WHERE user_id = ?")
      .all(u)
      .map((r) => ({ ...r, variants: safeParseVariants(r.variants) })),
    schedule: db.prepare("SELECT * FROM schedule_blocks WHERE user_id = ?").all(u),
    workouts: db.prepare("SELECT * FROM workouts WHERE user_id = ?").all(u),
    posts: db.prepare("SELECT * FROM posts WHERE user_id = ?").all(u),
    scheduled_posts: db.prepare("SELECT * FROM scheduled_posts WHERE user_id = ?").all(u),
    insights: db.prepare("SELECT * FROM insights WHERE user_id = ?").all(u),
  });
}));

// ---- Scheduled-post worker: publishes due posts every minute ----

async function publishDuePosts() {
  // Reclaim rows stuck mid-publish (crash/restart) after 15 minutes.
  const stuckBefore = new Date(Date.now() - 15 * 60e3).toISOString();
  db.prepare(
    "UPDATE scheduled_posts SET status = 'scheduled', error = NULL WHERE status = 'publishing' AND scheduled_at < ?"
  ).run(stuckBefore);

  const due = db
    .prepare("SELECT * FROM scheduled_posts WHERE status = 'scheduled' AND scheduled_at <= ? LIMIT 20")
    .all(now());
  for (const sp of due) {
    // Claim first so a slow publish can't be picked up twice.
    const claimed = db
      .prepare("UPDATE scheduled_posts SET status = 'publishing' WHERE id = ? AND status = 'scheduled'")
      .run(sp.id);
    if (!claimed.changes) continue;
    try {
      const order = ["free", "creator", "studio"];
      const tier = getTier(sp.user_id);
      const needStudio = UNIFIED_PLATFORMS.includes(sp.platform);
      const minTier = needStudio ? "studio" : "creator";
      if (order.indexOf(tier) < order.indexOf(minTier)) {
        throw new Error(
          needStudio
            ? "Studio required to auto-post to this platform. Upgrade or use Share."
            : "Creator required to auto-post. Upgrade or use Share."
        );
      }
      const draft = db.prepare("SELECT * FROM drafts WHERE id = ? AND user_id = ?").get(sp.draft_id, sp.user_id);
      const raw = draft ? (safeParseVariants(draft.variants)[sp.platform] || "").trim() : "";
      if (!raw) throw new Error("Draft or platform version no longer exists.");
      const text = withBrandTag(extractPostCaption(raw, sp.platform), getTier(sp.user_id));
      const { externalId } = await publish({ userId: sp.user_id, platform: sp.platform, text });
      db.prepare("UPDATE scheduled_posts SET status = 'posted', external_id = ? WHERE id = ?").run(
        externalId || null,
        sp.id
      );
      db.prepare(
        "INSERT INTO posts (user_id, draft_id, platform, status, external_id, created_at) VALUES (?, ?, ?, 'posted', ?, ?)"
      ).run(sp.user_id, sp.draft_id, sp.platform, externalId || null, now());
      db.prepare("UPDATE drafts SET status = 'posted' WHERE id = ? AND user_id = ?").run(sp.draft_id, sp.user_id);
    } catch (err) {
      console.error(`Scheduled post ${sp.id} failed:`, err.message);
      db.prepare("UPDATE scheduled_posts SET status = 'failed', error = ? WHERE id = ?").run(
        String(err.message || err).slice(0, 500),
        sp.id
      );
    }
  }
}

setInterval(() => publishDuePosts().catch((e) => console.error(e)), 60_000);

async function syncPendingImagineJobs() {
  if (!imagineConfigured()) return;

  // Jobs abandoned after hub OOM / crash.
  // If we already saved a clip (progress ~96), finish the job instead of refunding.
  const stuck = db
    .prepare(
      `SELECT * FROM imagine_jobs
       WHERE status = 'pending'
         AND created_at < datetime('now', '-15 minutes')`
    )
    .all();
  for (const job of stuck) {
    if (job.media_url) {
      db.prepare(
        "UPDATE imagine_jobs SET status = 'done', progress = 100, error = NULL, updated_at = ? WHERE id = ? AND status = 'pending'"
      ).run(now(), job.id);
      continue;
    }
    failImagineJob(
      job,
      "Generation timed out or the hub restarted mid-job. Your credit was restored — try again."
    );
  }

  const pending = db
    .prepare(
      `SELECT * FROM imagine_jobs
       WHERE status = 'pending' AND xai_request_id IS NOT NULL
       ORDER BY created_at ASC LIMIT 5`
    )
    .all();
  for (const job of pending) {
    await syncImagineJob(job);
  }
}
setInterval(() => syncPendingImagineJobs().catch((e) => console.error("[imagine]", e)), 15_000);

// Auto-detect crypto deposits and credit after enough confirmations (admin mark-paid still works).
if (process.env.CRYPTO_WATCH_DISABLED !== "1") {
  const runCryptoWatch = () => syncCryptoDeposits().catch((e) => console.error("[crypto]", e));
  setTimeout(runCryptoWatch, 45_000);
  setInterval(runCryptoWatch, Number(process.env.CRYPTO_WATCH_INTERVAL_MS || 60_000));
}

// ---- Weekly growth-tips worker: refreshes each active user's AI analysis ----
// Checks every 6 hours; each user gets at most one batch per 7 days.
if (process.env.GROWTH_TIPS_DISABLED !== "1") {
  const runTips = () => runWeeklyGrowthTips().catch((e) => console.error("[growth]", e));
  setTimeout(runTips, 2 * 60_000); // first pass shortly after boot
  setInterval(runTips, 6 * 3600e3);
}

const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`Brand hub listening on http://${HOST}:${PORT}`);
  if (!anthropicConfigured() && !grokTextConfigured()) {
    console.warn("WARNING: neither ANTHROPIC_API_KEY nor XAI_API_KEY set — text generation will fail.");
  } else if (!anthropicConfigured()) {
    console.warn("NOTE: ANTHROPIC_API_KEY not set — Claude text provider unavailable (Grok OK).");
  } else if (!grokTextConfigured()) {
    console.warn("NOTE: XAI_API_KEY not set — Grok text/Imagine unavailable.");
  }
  if (!imagineConfigured()) console.warn("NOTE: XAI_API_KEY not set - Studio AI clips/stills disabled.");
});
