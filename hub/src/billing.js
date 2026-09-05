// Stripe Checkout + Customer Portal + webhooks.
// Graceful when STRIPE_SECRET_KEY / price IDs are missing (mailto fallback in app).

import Stripe from "stripe";
import { db } from "./db.js";
import { PLAN_PRICES, VIDEO_CREDIT_PACKS, planFeatures } from "./plans.js";

export { PLAN_PRICES };

const TIER_FROM_PRICE = new Map();

function priceEnv(tier) {
  return process.env[`STRIPE_PRICE_${tier.toUpperCase()}`] || "";
}

function buildPriceMap() {
  TIER_FROM_PRICE.clear();
  for (const tier of ["creator", "studio"]) {
    const id = priceEnv(tier);
    if (id) TIER_FROM_PRICE.set(id, tier);
  }
}

export function billingConfigured() {
  buildPriceMap();
  return Boolean(process.env.STRIPE_SECRET_KEY && priceEnv("creator") && priceEnv("studio"));
}

/** One-time credit packs only need the secret key (uses price_data). */
export function creditsCheckoutConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

function stripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    const err = new Error("Billing is not configured yet.");
    err.status = 503;
    throw err;
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

function appOrigin(req) {
  const fromEnv = (process.env.APP_ORIGIN || process.env.APP_URL || "").replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  const err = new Error("APP_ORIGIN is not configured on the hub.");
  err.status = 503;
  throw err;
}

async function ensureCustomer(userId, email) {
  const s = stripe();
  const row = db.prepare("SELECT stripe_customer_id FROM users WHERE id = ?").get(userId);
  let customerId = row?.stripe_customer_id || undefined;
  if (!customerId) {
    const customer = await s.customers.create({
      email: email || undefined,
      metadata: { brand_studio_user_id: String(userId) },
    });
    customerId = customer.id;
    db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(customerId, userId);
  }
  return customerId;
}

export async function createCheckoutSession({ userId, email, tier, req }) {
  if (!["creator", "studio"].includes(tier)) {
    const err = new Error("Pick Creator or Studio.");
    err.status = 400;
    throw err;
  }
  if (!billingConfigured()) {
    const err = new Error("Online checkout isn't live yet. Email hello@brand-studio.app to upgrade.");
    err.status = 503;
    throw err;
  }
  const priceId = priceEnv(tier);
  const s = stripe();
  const customerId = await ensureCustomer(userId, email);
  const origin = appOrigin(req);
  const session = await s.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${origin}/setup?billing=success`,
    cancel_url: `${origin}/setup?billing=cancel`,
    client_reference_id: String(userId),
    metadata: { user_id: String(userId), tier },
    subscription_data: { metadata: { user_id: String(userId), tier } },
    allow_promotion_codes: true,
  });
  return { url: session.url };
}

export async function createCreditsCheckoutSession({ userId, email, pack, req }) {
  const packKey = String(pack || "");
  const def = VIDEO_CREDIT_PACKS[packKey];
  if (!def) {
    const err = new Error("Pick a credit pack: 5, 15, or 40.");
    err.status = 400;
    throw err;
  }
  if (!creditsCheckoutConfigured()) {
    const err = new Error("Credit checkout isn't live yet. Email hello@brand-studio.app.");
    err.status = 503;
    throw err;
  }
  const s = stripe();
  const customerId = await ensureCustomer(userId, email);
  const origin = appOrigin(req);
  const session = await s.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: Math.round(def.usd * 100),
          product_data: {
            name: def.label,
            description: `${def.credits} Grok Imagine video credits for Brand Studio`,
          },
        },
      },
    ],
    success_url: `${origin}/setup?billing=credits_success`,
    cancel_url: `${origin}/setup?billing=cancel`,
    client_reference_id: String(userId),
    metadata: {
      user_id: String(userId),
      type: "video_credits",
      credits: String(def.credits),
      pack: packKey,
    },
  });
  return { url: session.url };
}

export function addVideoCredits(userId, credits) {
  const n = Math.max(0, Math.floor(Number(credits) || 0));
  if (!n) return getVideoCredits(userId);
  db.prepare("UPDATE users SET video_credits = COALESCE(video_credits, 0) + ? WHERE id = ?").run(n, userId);
  return getVideoCredits(userId);
}

export function getVideoCredits(userId) {
  return db.prepare("SELECT COALESCE(video_credits, 0) AS n FROM users WHERE id = ?").get(userId)?.n || 0;
}

/** Burn one purchased credit. Returns false if none left. */
export function consumeVideoCredit(userId) {
  const info = db
    .prepare("UPDATE users SET video_credits = video_credits - 1 WHERE id = ? AND video_credits > 0")
    .run(userId);
  return info.changes > 0;
}

/** Restore one purchased credit (failed / aborted generation). */
export function refundVideoCredit(userId) {
  db.prepare("UPDATE users SET video_credits = COALESCE(video_credits, 0) + 1 WHERE id = ?").run(userId);
}

export async function createPortalSession({ userId, req }) {
  if (!billingConfigured()) {
    const err = new Error("Billing portal isn't live yet.");
    err.status = 503;
    throw err;
  }
  const row = db.prepare("SELECT stripe_customer_id FROM users WHERE id = ?").get(userId);
  if (!row?.stripe_customer_id) {
    const err = new Error("No billing account yet — upgrade first.");
    err.status = 400;
    throw err;
  }
  const s = stripe();
  const session = await s.billingPortal.sessions.create({
    customer: row.stripe_customer_id,
    return_url: `${appOrigin(req)}/setup`,
  });
  return { url: session.url };
}

function setUserTier(userId, tier, subscriptionId = undefined) {
  if (!["free", "creator", "studio"].includes(tier)) return;
  if (subscriptionId === undefined) {
    db.prepare("UPDATE users SET tier = ? WHERE id = ?").run(tier, userId);
  } else {
    db.prepare("UPDATE users SET tier = ?, stripe_subscription_id = ? WHERE id = ?").run(
      tier,
      subscriptionId,
      userId
    );
  }
}

function claimStripeEvent(event) {
  const info = db
    .prepare("INSERT OR IGNORE INTO stripe_events (event_id, type, created_at) VALUES (?, ?, ?)")
    .run(event.id, event.type, new Date().toISOString());
  return info.changes > 0;
}

function releaseStripeEvent(eventId) {
  db.prepare("DELETE FROM stripe_events WHERE event_id = ?").run(eventId);
}

function grantCheckoutCredits(session, userId) {
  const paid = session.payment_status === "paid" || session.payment_status === "no_payment_required";
  if (!paid) return;
  const credits = Number(session.metadata?.credits || 0);
  if (credits <= 0) return;
  const sessionId = String(session.id || "");
  if (!sessionId) return;
  const claimed = db
    .prepare(
      "INSERT OR IGNORE INTO stripe_credit_sessions (session_id, user_id, credits, created_at) VALUES (?, ?, ?, ?)"
    )
    .run(sessionId, userId, credits, new Date().toISOString());
  if (!claimed.changes) return;
  addVideoCredits(userId, credits);
}

export async function handleStripeWebhook(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    const err = new Error("Webhook secret not configured.");
    err.status = 503;
    throw err;
  }
  const s = stripe();
  const event = s.webhooks.constructEvent(rawBody, signature, secret);
  if (!claimStripeEvent(event)) return { received: true, duplicate: true };

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const userId = Number(session.client_reference_id || session.metadata?.user_id);
        if (session.customer && userId) {
          db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(session.customer, userId);
        }
        if (session.mode === "payment" && session.metadata?.type === "video_credits" && userId) {
          grantCheckoutCredits(session, userId);
          break;
        }
        const paid = session.payment_status === "paid" || session.payment_status === "no_payment_required";
        const tier = session.metadata?.tier;
        if (paid && userId && (tier === "creator" || tier === "studio")) {
          setUserTier(userId, tier, session.subscription || null);
        }
        break;
      }
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object;
        const userId = Number(session.client_reference_id || session.metadata?.user_id);
        if (session.mode === "payment" && session.metadata?.type === "video_credits" && userId) {
          grantCheckoutCredits(session, userId);
        }
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.created": {
        const sub = event.data.object;
        const userId = Number(sub.metadata?.user_id);
        const tier = tierFromSubscription(sub);
        const entitled = ["active", "trialing"].includes(sub.status);
        if (userId) {
          if (sub.customer) {
            db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(sub.customer, userId);
          }
          if (entitled && tier) setUserTier(userId, tier, sub.id);
          else if (["canceled", "unpaid", "incomplete_expired", "past_due", "paused"].includes(sub.status)) {
            setUserTier(userId, "free", sub.status === "canceled" ? null : sub.id);
          }
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const userId = Number(sub.metadata?.user_id);
        if (userId) setUserTier(userId, "free", null);
        break;
      }
      default:
        break;
    }
  } catch (err) {
    releaseStripeEvent(event.id);
    throw err;
  }

  return { received: true };
}

function tierFromSubscription(sub) {
  buildPriceMap();
  const priceId = sub?.items?.data?.[0]?.price?.id;
  if (priceId && TIER_FROM_PRICE.has(priceId)) return TIER_FROM_PRICE.get(priceId);
  const meta = sub?.metadata?.tier;
  if (meta === "creator" || meta === "studio") return meta;
  return null;
}

export function billingStatus() {
  const plans = planFeatures();
  return {
    configured: billingConfigured(),
    credits_checkout: creditsCheckoutConfigured(),
    credit_packs: Object.fromEntries(
      Object.entries(VIDEO_CREDIT_PACKS).map(([k, v]) => [k, { credits: v.credits, usd: v.usd, label: v.label }])
    ),
    plans,
  };
}
