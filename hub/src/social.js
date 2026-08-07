// Social platform connections and publishing.
// X (Twitter) is fully implemented via OAuth 2.0 PKCE + the v2 API.
// Instagram/Facebook (Meta Graph) and TikTok slot into the same provider
// shape once their app-review credentials exist (see README).

import { createHash, randomBytes } from "node:crypto";
import { db } from "./db.js";

const now = () => new Date().toISOString();

const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
const X_API = "https://api.x.com/2";
const X_SCOPES = "tweet.read tweet.write users.read offline.access";

function xConfigured() {
  return Boolean(process.env.X_CLIENT_ID && process.env.X_CLIENT_SECRET);
}

// Unified posting API (Ayrshare-compatible shape). Setting UNIFIED_API_KEY
// turns on Instagram/Facebook/TikTok posting without waiting for Meta/TikTok
// app review. Swap to free direct APIs later by replacing this driver.
export const UNIFIED_PLATFORMS = ["facebook", "instagram", "tiktok", "linkedin"];

function unifiedConfigured() {
  return Boolean(process.env.UNIFIED_API_KEY);
}

export function providerStatus() {
  const viaUnified = unifiedConfigured() ? "available" : "coming_soon";
  return {
    x: xConfigured() ? "available" : "unconfigured",
    facebook: viaUnified,
    instagram: viaUnified,
    tiktok: viaUnified,
    linkedin: viaUnified,
    snapchat: "unsupported", // no public posting API - share sheet only
  };
}

async function publishViaUnified({ userId, platform, text }) {
  const base = (process.env.UNIFIED_API_URL || "https://api.ayrshare.com/api").replace(/\/$/, "");
  // Multi-tenant providers issue a per-user profile key; we keep it in the
  // connections row for the platform when present.
  const conn = db
    .prepare("SELECT * FROM connections WHERE user_id = ? AND platform = ?")
    .get(userId, platform);
  const body = { post: text, platforms: [platform] };
  if (conn?.access_token && conn.access_token !== "unified") body.profileKey = conn.access_token;

  const res = await fetch(`${base}/post`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.UNIFIED_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === "error") {
    const detail = data?.errors?.[0]?.message || data?.message || `HTTP ${res.status}`;
    const err = new Error(`${platform} rejected the post: ${detail}`);
    err.status = 502;
    throw err;
  }
  const externalId = data?.postIds?.[0]?.id || data?.id || null;
  return { externalId };
}

function publicUrl() {
  return (process.env.HUB_PUBLIC_URL || "").replace(/\/$/, "");
}

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---- OAuth flow (X) ----

export function startXConnect(userId) {
  if (!xConfigured()) {
    const err = new Error("X posting isn't configured on this server yet.");
    err.status = 501;
    throw err;
  }
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  db.prepare(
    "INSERT INTO oauth_states (state, user_id, platform, code_verifier, created_at) VALUES (?, ?, 'x', ?, ?)"
  ).run(state, userId, verifier, now());
  // Opportunistic cleanup of stale states (>1h).
  db.prepare("DELETE FROM oauth_states WHERE created_at < ?").run(new Date(Date.now() - 3600e3).toISOString());

  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.X_CLIENT_ID,
    redirect_uri: `${publicUrl()}/api/connect/x/callback`,
    scope: X_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${X_AUTHORIZE_URL}?${params}`;
}

async function xTokenRequest(bodyParams) {
  const basic = Buffer.from(`${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(X_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams(bodyParams),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`X token request failed (${res.status}): ${data.error_description || data.error || "unknown"}`);
  }
  return data;
}

export async function finishXConnect(state, code, cookieUserId) {
  const pending = db.prepare("SELECT * FROM oauth_states WHERE state = ? AND platform = 'x'").get(state);
  if (!pending) throw new Error("Unknown or expired connect attempt. Try connecting again from the app.");
  if (cookieUserId == null || String(cookieUserId) !== String(pending.user_id)) {
    throw new Error("Start Connect from Brand Studio on this device, then approve access in the same browser.");
  }
  db.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);

  const tokens = await xTokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: `${publicUrl()}/api/connect/x/callback`,
    code_verifier: pending.code_verifier,
    client_id: process.env.X_CLIENT_ID,
  });

  // Fetch the handle so the UI can show who's connected.
  let handle = "";
  try {
    const meRes = await fetch(`${X_API}/users/me`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const me = await meRes.json();
    handle = me?.data?.username ? `@${me.data.username}` : "";
  } catch {
    /* non-fatal */
  }

  const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null;
  db.prepare(
    `INSERT INTO connections (user_id, platform, handle, access_token, refresh_token, expires_at, created_at)
     VALUES (?, 'x', ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, platform) DO UPDATE SET handle = excluded.handle,
       access_token = excluded.access_token, refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at, created_at = excluded.created_at`
  ).run(pending.user_id, handle, tokens.access_token, tokens.refresh_token || null, expiresAt, now());

  return { userId: pending.user_id, handle };
}

async function freshXToken(conn) {
  const expired = conn.expires_at && new Date(conn.expires_at).getTime() < Date.now() + 60_000;
  if (!expired) return conn.access_token;
  if (!conn.refresh_token) throw new Error("X session expired. Reconnect your X account in Setup.");
  const tokens = await xTokenRequest({
    grant_type: "refresh_token",
    refresh_token: conn.refresh_token,
    client_id: process.env.X_CLIENT_ID,
  });
  const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null;
  db.prepare("UPDATE connections SET access_token = ?, refresh_token = ?, expires_at = ? WHERE id = ?").run(
    tokens.access_token,
    tokens.refresh_token || conn.refresh_token,
    expiresAt,
    conn.id
  );
  return tokens.access_token;
}

// ---- Publishing ----

/** Link a connect key to one or more platforms (unified publisher). */
export function connectUnified({ userId, profileKey, handle = "", platforms }) {
  if (!unifiedConfigured()) {
    const err = new Error("Direct posting for Instagram/Facebook/TikTok isn't configured on this server yet. Use Share for now.");
    err.status = 501;
    throw err;
  }
  const key = (profileKey || "").trim();
  if (!key) {
    const err = new Error("Paste the connect key from your Brand Studio email, then try again.");
    err.status = 400;
    throw err;
  }
  const list = (platforms?.length ? platforms : UNIFIED_PLATFORMS).filter((p) => UNIFIED_PLATFORMS.includes(p));
  if (!list.length) {
    const err = new Error("Pick at least one platform: facebook, instagram, tiktok, or linkedin.");
    err.status = 400;
    throw err;
  }
  const label = (handle || "Connected").trim().slice(0, 80);
  const insert = db.prepare(
    `INSERT INTO connections (user_id, platform, handle, access_token, refresh_token, expires_at, created_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?)
     ON CONFLICT (user_id, platform) DO UPDATE SET handle = excluded.handle,
       access_token = excluded.access_token, created_at = excluded.created_at`
  );
  for (const platform of list) {
    insert.run(userId, platform, label, key, now());
  }
  return { platforms: list, handle: label };
}

export async function publish({ userId, platform, text }) {
  const conn = db
    .prepare("SELECT * FROM connections WHERE user_id = ? AND platform = ?")
    .get(userId, platform);

  // IG / FB / TikTok / LinkedIn: require an explicit link, then post via unified API.
  // Users without a link keep using the Share button in Drafts.
  if (UNIFIED_PLATFORMS.includes(platform)) {
    if (!unifiedConfigured()) {
      const err = new Error(`Direct posting to ${platform} isn't available yet — use Share instead.`);
      err.status = 501;
      throw err;
    }
    if (!conn) {
      const err = new Error(`Link ${platform} in Setup to Post, or use Share.`);
      err.status = 400;
      throw err;
    }
    return publishViaUnified({ userId, platform, text });
  }

  if (!conn) {
    const err = new Error(`No connected ${platform} account. Connect it in Setup first, or use Share.`);
    err.status = 400;
    throw err;
  }

  if (platform === "x") {
    const token = await freshXToken(conn);
    // X threads: blank-line separated tweets, posted as replies.
    const parts = text
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    let firstId = null;
    let replyTo = null;
    for (const part of parts) {
      const body = replyTo ? { text: part, reply: { in_reply_to_tweet_id: replyTo } } : { text: part };
      const res = await fetch(`${X_API}/tweets`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(`X rejected the post (${res.status}): ${data.detail || data.title || "unknown error"}`);
      }
      replyTo = data.data.id;
      if (!firstId) firstId = data.data.id;
    }
    return { externalId: firstId };
  }

  const err = new Error(`Direct posting to ${platform} isn't available yet - use Share instead.`);
  err.status = 501;
  throw err;
}
