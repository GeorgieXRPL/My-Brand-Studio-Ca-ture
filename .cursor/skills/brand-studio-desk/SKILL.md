---
name: brand-studio-desk
description: >-
  Operate Brand Studio from a computer via Desk and the hub agent API.
  Use when drafting Brand Studio posts, reviewing agent drafts, running a
  Grok or Cursor bot against the hub, calling brand-studio-hub.fly.dev, or
  when the user mentions Desk, Queue, or agent keys.
---

# Brand Studio desk

Phone app stays at `/capture`. Desktop work lives at `/desk`.

- Desk: https://app.mybrandstudio.club/desk
- Hub: https://brand-studio-hub.fly.dev
- Same login as the phone app (email/password or Privy)

## What you do

1. **Write.** Type an idea. Ctrl+Enter (or Draft now) writes captions for the apps that are on.
2. **Queue.** Edit every platform on one screen. Copy a caption. Approve Grok drafts. You post; the bot does not.
3. **Grok bots.** Mint a Studio agent key. Copy the instruction block. Put the key in `BRAND_STUDIO_AGENT_KEY` on the machine that runs the bot. Never paste the key in chat.

Desk polls the hub every 15s, so bot drafts show up without a refresh.

## Agent API

Auth header: `Authorization: Bearer $BRAND_STUDIO_AGENT_KEY`

Agent keys can read profile/ideas/drafts/insights and submit drafts/insights. They cannot approve, publish, change settings, or manage keys.

```bash
HUB=https://brand-studio-hub.fly.dev
KEY=$BRAND_STUDIO_AGENT_KEY

curl -sS -H "Authorization: Bearer $KEY" $HUB/api/profile
curl -sS -H "Authorization: Bearer $KEY" $HUB/api/ideas
curl -sS -H "Authorization: Bearer $KEY" $HUB/api/algo/context

curl -sS -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"topic":"..."}' $HUB/api/generate

curl -sS -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"topic":"...","variants":{"x":"...","facebook":"...","tiktok":"...","instagram":"..."}}' \
  $HUB/api/drafts
```

Read `GET /api/profile` and `GET /api/algo/context` before writing. Match the brand voice. Submit drafts into the approval queue. Stop. The human approves on Desk.

If a call returns 403 about Studio, the account is not on the Studio plan or the key is missing.
