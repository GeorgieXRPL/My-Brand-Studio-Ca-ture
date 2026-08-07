import express from "express";
import cors from "cors";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { db, ensureOwnerUser, ensureRefCode, mediaDir } from "./db.js";
import {
  createSession,
  destroySession,
  findOrCreateGoogleUser,
  getUser,
  login,
  resolveSession,
  signup,
} from "./auth.js";
import { generateVariants, chat, PLATFORMS } from "./claude.js";
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
  createCheckoutSession,
  createPortalSession,
  handleStripeWebhook,
} from "./billing.js";
import {
  buildVideoPrompt,
  downloadBinary,
  generateStill,
  imagineConfigured,
  imagineMonthlyLimit,
  extractPostCaption,
  parseFilmLabels,
  pollVideo,
  startVideoGeneration,
} from "./imagine.js";

const app = express();

const allowed = (process.env.ALLOWED_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      // Allow same-origin / curl (no origin) and any explicitly allowed origin.
      if (!origin || allowed.includes(origin)) return cb(null, true);
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

app.get("/api/health", (_req, res) => res.json({ ok: true, platforms: PLATFORMS }));

app.post("/api/auth/signup", rateLimit, wrap((req, res) => {
  const user = signup(req.body?.email, req.body?.password, req.body?.ref);
  const token = createSession(user.id);
  res.status(201).json({ token, email: user.email });
}));

app.post("/api/auth/login", rateLimit, wrap((req, res) => {
  const user = login(req.body?.email, req.body?.password);
  const token = createSession(user.id);
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
  db.prepare(
    "INSERT INTO oauth_states (state, user_id, platform, code_verifier, created_at) VALUES (?, 0, 'google', '', ?)"
  ).run(state, now());
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

    const user = findOrCreateGoogleUser(claims.email);
    const session = createSession(user.id);
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
  req.userId = userId;
  req.tokenKind = "session";
  next();
});

// ---- Tiers ----
// Stripe webhooks update users.tier; CLI set-tier remains for ops.
// Self-host owner (id 1 / owner@selfhost.local) is set to Studio in ensureOwnerUser.

const TIER_LIMITS = { free: 10, creator: 200, studio: 1000 }; // drafts per month

function getTier(userId) {
  const row = db.prepare("SELECT tier FROM users WHERE id = ?").get(userId);
  return TIER_LIMITS[row?.tier] !== undefined ? row.tier : "free";
}

function draftUsage(userId) {
  const monthStart = now().slice(0, 7) + "-01";
  const used = db
    .prepare("SELECT COUNT(*) AS n FROM drafts WHERE user_id = ? AND created_at >= ?")
    .get(userId, monthStart).n;
  const bonus = db.prepare("SELECT bonus_drafts FROM users WHERE id = ?").get(userId)?.bonus_drafts || 0;
  const tier = getTier(userId);
  return { tier, used, limit: TIER_LIMITS[tier] + bonus };
}

function assertDraftQuota(userId, res) {
  const usage = draftUsage(userId);
  if (usage.used >= usage.limit) {
    res.status(429).json({
      error:
        usage.tier === "free"
          ? `You've used all ${usage.limit} free drafts this month. Upgrade to Creator for 200/month - or invite a friend for bonus drafts.`
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
        ? "This is a Studio feature. Upgrade for AI clips, agents, and self-hosted hub. Until then, use guided Share from Drafts."
        : "This is a Creator feature. Upgrade for more drafts, the content queue, and growth tips.",
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
    billing_configured: billing.configured,
    has_stripe_customer: Boolean(user?.stripe_customer_id),
  });
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

app.post("/api/billing/portal", wrap(async (req, res) => {
  if (req.tokenKind === "agent") return res.status(403).json({ error: "Agents can't manage billing." });
  try {
    const result = await createPortalSession({ userId: req.userId, req });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}));

// ---- Profile (goals, projects, brand voice) ----

function readProfile(userId) {
  const row = db
    .prepare("SELECT goals, projects, brand_voice, traits FROM profiles WHERE user_id = ?")
    .get(userId) || { goals: "", projects: "", brand_voice: "", traits: "{}" };
  let traits = {};
  try {
    traits = JSON.parse(row.traits || "{}");
  } catch {
    /* corrupted traits fall back to empty */
  }
  return { goals: row.goals, projects: row.projects, brand_voice: row.brand_voice, traits };
}

app.get("/api/profile", wrap((req, res) => {
  res.json(readProfile(req.userId));
}));

app.put("/api/profile", wrap((req, res) => {
  const { goals = "", projects = "", brand_voice = "", traits = {} } = req.body || {};
  db.prepare(
    `INSERT INTO profiles (user_id, goals, projects, brand_voice, traits, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET goals = excluded.goals, projects = excluded.projects,
       brand_voice = excluded.brand_voice, traits = excluded.traits, updated_at = excluded.updated_at`
  ).run(req.userId, goals, projects, brand_voice, JSON.stringify(traits || {}), now());
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

app.get("/api/drafts", wrap((req, res) => {
  const rows = db.prepare("SELECT * FROM drafts WHERE user_id = ? ORDER BY created_at DESC").all(req.userId);
  res.json(rows.map((r) => ({ ...r, variants: JSON.parse(r.variants) })));
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
      "INSERT INTO drafts (user_id, idea_id, topic, variants, status, source, media_url, agent_key_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(req.userId, idea_id, topic, JSON.stringify(variants), status, source, media_url, req.agentKeyId || null, now());
  const row = db.prepare("SELECT * FROM drafts WHERE id = ?").get(info.lastInsertRowid);
  res.status(201).json({ ...row, variants: JSON.parse(row.variants) });
}));

app.patch("/api/drafts/:id", wrap((req, res) => {
  const existing = db.prepare("SELECT * FROM drafts WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const { status, variants, topic, media_url } = req.body || {};
  // Agents may refine content but never approve it - only a human does that.
  if (req.tokenKind === "agent" && status && status !== "draft") {
    return res.status(403).json({ error: "Agents can't approve drafts. The user approves in the app." });
  }
  db.prepare("UPDATE drafts SET status = ?, variants = ?, topic = ?, media_url = ? WHERE id = ?").run(
    status ?? existing.status,
    variants ? JSON.stringify(variants) : existing.variants,
    topic ?? existing.topic,
    media_url !== undefined ? media_url : existing.media_url,
    existing.id
  );
  const row = db.prepare("SELECT * FROM drafts WHERE id = ?").get(existing.id);
  res.json({ ...row, variants: JSON.parse(row.variants) });
}));

app.delete("/api/drafts/:id", wrap((req, res) => {
  db.prepare("DELETE FROM drafts WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
  res.json({ ok: true });
}));

// ---- Generate (Claude): one idea -> 5 platform variants, saved as a draft ----

app.post("/api/generate", async (req, res) => {
  try {
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

    // If media is attached, hand images to Claude's vision so posts reflect
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
    const variants = await generateVariants({ topic, profile, image, isVideo });

    const source = req.tokenKind === "agent" ? "agent" : "user";
    const info = db
      .prepare(
        "INSERT INTO drafts (user_id, idea_id, topic, variants, status, source, media_url, agent_key_id, created_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)"
      )
      .run(req.userId, ideaId, topic, JSON.stringify(variants), source, mediaUrl, req.agentKeyId || null, now());
    if (ideaId) db.prepare("UPDATE ideas SET status = 'drafted' WHERE id = ? AND user_id = ?").run(ideaId, req.userId);

    const row = db.prepare("SELECT * FROM drafts WHERE id = ?").get(info.lastInsertRowid);
    res.status(201).json({ ...row, variants: JSON.parse(row.variants) });
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
    res.json({ reply });
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
    const variants = JSON.parse(draft.variants);
    const raw = (variants[platform] || "").trim();
    if (!raw) return res.status(400).json({ error: `This draft has no ${platform} version.` });
    const text = extractPostCaption(raw, platform);

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
  const variants = JSON.parse(draft.variants);
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
        const variants = JSON.parse(row.draft_variants || "{}");
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

app.post(
  "/api/media",
  express.raw({ type: () => true, limit: "25mb" }),
  wrap((req, res) => {
    const mime = (req.get("content-type") || "").split(";")[0].trim();
    if (!MEDIA_TYPES[mime]) return res.status(415).json({ error: `Unsupported media type: ${mime}` });
    if (!req.body?.length) return res.status(400).json({ error: "Empty upload" });
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
  const monthStart = now().slice(0, 7) + "-01";
  const used = db
    .prepare(
      "SELECT COUNT(*) AS n FROM imagine_jobs WHERE user_id = ? AND created_at >= ? AND status != 'failed'"
    )
    .get(userId, monthStart).n;
  return { used, limit: imagineMonthlyLimit(), configured: imagineConfigured() };
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
        db.prepare(
          "UPDATE imagine_jobs SET status = 'failed', error = ?, progress = 100, updated_at = ? WHERE id = ?"
        ).run("Generated clip did not pass moderation.", ts, job.id);
      } else {
        const { buf, mime } = await downloadBinary(poll.url);
        const saved = saveDownloadedMedia(job.user_id, buf, mime.startsWith("video/") ? mime : "video/mp4");
        db.prepare(
          "UPDATE imagine_jobs SET status = 'done', progress = 100, media_url = ?, error = NULL, updated_at = ? WHERE id = ?"
        ).run(saved.url, ts, job.id);
        db.prepare("UPDATE drafts SET media_url = ? WHERE id = ? AND user_id = ?").run(
          saved.url,
          job.draft_id,
          job.user_id
        );
      }
    } else if (poll.status === "failed" || poll.status === "expired") {
      db.prepare(
        "UPDATE imagine_jobs SET status = 'failed', error = ?, progress = ?, updated_at = ? WHERE id = ?"
      ).run(poll.error || `Generation ${poll.status}`, poll.progress ?? 0, ts, job.id);
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
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

app.get("/api/imagine/status", wrap((req, res) => {
  const usage = imagineUsage(req.userId);
  res.json({
    ...usage,
    tier: getTier(req.userId),
    studio: getTier(req.userId) === "studio" || req.userId === 1,
  });
}));

app.post("/api/imagine/video", async (req, res) => {
  try {
    if (!requireTier(req, res, "studio")) return;
    if (!imagineConfigured()) {
      return res.status(503).json({
        error: "AI clip generation is not configured. Add XAI_API_KEY on the hub.",
      });
    }
    const usage = imagineUsage(req.userId);
    if (usage.used >= usage.limit) {
      return res.status(429).json({
        error: `You've used all ${usage.limit} AI clips this month. Limit resets on the 1st.`,
        used: usage.used,
        limit: usage.limit,
      });
    }

    const draftId = Number(req.body?.draft_id);
    if (!draftId) return res.status(400).json({ error: "draft_id is required" });
    const draft = db.prepare("SELECT * FROM drafts WHERE id = ? AND user_id = ?").get(draftId, req.userId);
    if (!draft) return res.status(404).json({ error: "Draft not found" });

    const platform = req.body?.platform || "tiktok";
    const variants = JSON.parse(draft.variants || "{}");
    const script = (req.body?.script || variants[platform] || variants.tiktok || Object.values(variants)[0] || "").trim();
    const labels = parseFilmLabels(script);
    const profile = readProfile(req.userId);
    const prompt =
      (req.body?.prompt || "").trim() ||
      labels.imagine ||
      buildVideoPrompt({
        topic: draft.topic,
        hook: labels.hook,
        beats: labels.beats,
        onScreen: labels.onScreen,
        keyword: labels.keyword,
        brandVoice: profile.brand_voice,
      });

    // Image-to-video when the draft already has a still attached.
    let imageUrl = null;
    if (draft.media_url) {
      const mediaId = draft.media_url.split("/").pop();
      const media = db.prepare("SELECT * FROM media WHERE id = ? AND user_id = ?").get(mediaId, req.userId);
      if (media?.mime?.startsWith("image/")) {
        imageUrl = draft.media_url.startsWith("http") ? draft.media_url : publicMediaUrl(media.id);
      }
    }
    if (req.body?.image_url) imageUrl = req.body.image_url;

    const duration = Math.min(12, Math.max(4, Number(req.body?.duration) || 8));
    const { requestId } = await startVideoGeneration({
      prompt,
      imageUrl,
      duration,
      aspectRatio: req.body?.aspect_ratio || "9:16",
      resolution: req.body?.resolution || "720p",
    });

    const ts = now();
    const info = db
      .prepare(
        `INSERT INTO imagine_jobs (user_id, draft_id, kind, xai_request_id, status, progress, prompt, created_at, updated_at)
         VALUES (?, ?, 'video', ?, 'pending', 0, ?, ?, ?)`
      )
      .run(req.userId, draftId, requestId, prompt, ts, ts);

    const row = db.prepare("SELECT * FROM imagine_jobs WHERE id = ?").get(info.lastInsertRowid);
    res.status(201).json(jobJson(row));
  } catch (err) {
    console.error(err);
    res.status(err.status && err.status < 600 ? err.status : 500).json({
      error: err.message || "Failed to start AI clip",
    });
  }
});

app.post("/api/imagine/still", async (req, res) => {
  try {
    if (!requireTier(req, res, "studio")) return;
    if (!imagineConfigured()) {
      return res.status(503).json({
        error: "AI image generation is not configured. Add XAI_API_KEY on the hub.",
      });
    }
    const usage = imagineUsage(req.userId);
    if (usage.used >= usage.limit) {
      return res.status(429).json({
        error: `You've used all ${usage.limit} AI media generations this month.`,
        used: usage.used,
        limit: usage.limit,
      });
    }

    const draftId = Number(req.body?.draft_id);
    if (!draftId) return res.status(400).json({ error: "draft_id is required" });
    const draft = db.prepare("SELECT * FROM drafts WHERE id = ? AND user_id = ?").get(draftId, req.userId);
    if (!draft) return res.status(404).json({ error: "Draft not found" });

    const platform = req.body?.platform || "tiktok";
    const variants = JSON.parse(draft.variants || "{}");
    const script = (variants[platform] || variants.tiktok || "").trim();
    const labels = parseFilmLabels(script);
    const prompt =
      (req.body?.prompt || "").trim() ||
      `Vertical 9:16 social still for TikTok/Reels. Topic: ${draft.topic}. Hook: ${labels.hook || draft.topic}. On-screen idea: ${labels.onScreen || labels.hook}. No text burned into the image. Clean, scroll-stopping.`;

    const { url } = await generateStill({ prompt, aspectRatio: "9:16" });
    const { buf, mime } = await downloadBinary(url);
    const saved = saveDownloadedMedia(req.userId, buf, mime.startsWith("image/") ? mime : "image/png");
    db.prepare("UPDATE drafts SET media_url = ? WHERE id = ? AND user_id = ?").run(saved.url, draftId, req.userId);

    const ts = now();
    const info = db
      .prepare(
        `INSERT INTO imagine_jobs (user_id, draft_id, kind, xai_request_id, status, progress, prompt, media_url, created_at, updated_at)
         VALUES (?, ?, 'still', NULL, 'done', 100, ?, ?, ?, ?)`
      )
      .run(req.userId, draftId, prompt, saved.url, ts, ts);

    const row = db.prepare("SELECT * FROM imagine_jobs WHERE id = ?").get(info.lastInsertRowid);
    res.status(201).json({ ...jobJson(row), draft_media_url: saved.url });
  } catch (err) {
    console.error(err);
    res.status(err.status && err.status < 600 ? err.status : 500).json({
      error: err.message || "Failed to generate still",
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
    profile: db.prepare("SELECT goals, projects, brand_voice FROM profiles WHERE user_id = ?").get(u) || {},
    ideas: db.prepare("SELECT * FROM ideas WHERE user_id = ?").all(u),
    drafts: db
      .prepare("SELECT * FROM drafts WHERE user_id = ?")
      .all(u)
      .map((r) => ({ ...r, variants: JSON.parse(r.variants) })),
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
      const raw = draft ? (JSON.parse(draft.variants)[sp.platform] || "").trim() : "";
      if (!raw) throw new Error("Draft or platform version no longer exists.");
      const text = extractPostCaption(raw, sp.platform);
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
  const pending = db
    .prepare("SELECT * FROM imagine_jobs WHERE status = 'pending' AND xai_request_id IS NOT NULL LIMIT 10")
    .all();
  for (const job of pending) {
    await syncImagineJob(job);
  }
}
setInterval(() => syncPendingImagineJobs().catch((e) => console.error("[imagine]", e)), 15_000);

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
  if (!process.env.ANTHROPIC_API_KEY) console.warn("WARNING: ANTHROPIC_API_KEY not set - content generation will fail.");
  if (!imagineConfigured()) console.warn("NOTE: XAI_API_KEY not set - Studio AI clips/stills disabled.");
});
