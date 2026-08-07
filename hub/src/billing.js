// Stripe Checkout + Customer Portal + webhooks.
// Graceful when STRIPE_SECRET_KEY / price IDs are missing (mailto fallback in app).

import Stripe from "stripe";
import { db } from "./db.js";

export const PLAN_PRICES = {
  creator: { monthly: 19, label: "Creator" },
  studio: { monthly: 49, label: "Studio" },
};

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
  // Never trust client Origin for Stripe return URLs.
  const err = new Error("APP_ORIGIN is not configured on the hub.");
  err.status = 503;
  throw err;
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
  // Pass subscriptionId explicitly (including null on cancel) so we clear stale ids.
  // Omit the arg (undefined) to leave stripe_subscription_id unchanged.
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

function tierFromSubscription(sub) {
  buildPriceMap();
  const priceId = sub?.items?.data?.[0]?.price?.id;
  if (priceId && TIER_FROM_PRICE.has(priceId)) return TIER_FROM_PRICE.get(priceId);
  const meta = sub?.metadata?.tier;
  if (meta === "creator" || meta === "studio") return meta;
  return null;
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

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const userId = Number(session.client_reference_id || session.metadata?.user_id);
      const tier = session.metadata?.tier;
      if (userId && (tier === "creator" || tier === "studio")) {
        if (session.customer) {
          db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(session.customer, userId);
        }
        setUserTier(userId, tier, session.subscription || null);
      }
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.created": {
      const sub = event.data.object;
      const userId = Number(sub.metadata?.user_id);
      const tier = tierFromSubscription(sub);
      const active = ["active", "trialing"].includes(sub.status);
      if (userId) {
        if (sub.customer) {
          db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(sub.customer, userId);
        }
        if (active && tier) setUserTier(userId, tier, sub.id);
        if (["canceled", "unpaid", "incomplete_expired"].includes(sub.status)) {
          setUserTier(userId, "free", null);
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

  return { received: true };
}

export function billingStatus() {
  return {
    configured: billingConfigured(),
    plans: {
      free: { monthly: 0, drafts: 10, features: ["Share to any app", "10 drafts / month"] },
      creator: {
        monthly: PLAN_PRICES.creator.monthly,
        drafts: 200,
        features: ["Guided Share", "Content schedule", "Growth tips", "200 drafts / month"],
      },
      studio: {
        monthly: PLAN_PRICES.studio.monthly,
        drafts: 1000,
        features: [
          "Everything in Creator",
          "AI clip & still (Grok Imagine)",
          "AI agents",
          "Self-hosted hub",
          "1000 drafts / month",
          "One-tap Post & live metrics — coming soon",
        ],
      },
    },
  };
}
