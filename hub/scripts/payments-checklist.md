# Brand Studio payments checklist (test mode first)

## Fly secrets (required for Checkout)

```bash
fly secrets set -a brand-studio-hub \
  STRIPE_SECRET_KEY=sk_test_... \
  STRIPE_PRICE_CREATOR=price_... \
  STRIPE_PRICE_STUDIO=price_... \
  STRIPE_WEBHOOK_SECRET=whsec_...
```

`APP_ORIGIN` is already in `fly.toml` (`https://app-bay-nu-40.vercel.app`).

## Stripe webhook

Endpoint: `https://brand-studio-hub.fly.dev/api/billing/webhook`  
Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`

## Manual E2E

1. Free → Creator Checkout → webhook sets `users.tier=creator`
2. Creator → Studio upgrade
3. Buy video credits pack → `video_credits` increments
4. Portal “Manage subscription” opens
5. With secrets **unset**, Setup uses mailto fallback (not Checkout)

## Verify from app

Signed-in Setup: `billing_configured: true` on `/api/auth/me` when secret + both price IDs are set.
