import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db, bootstrapUser, ensureRefCode } from "./db.js";
import { formatAuthMail, mailConfigured, notifyOwner, recordAuthEvent, shouldNotifyLogin } from "./mail.js";

const now = () => new Date().toISOString();

// ---- Password hashing (scrypt, no external deps) ----

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// ---- Sessions (opaque tokens; only a hash is stored) ----

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export function createSession(userId) {
  const token = "bs_" + randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)").run(
    sha256(token),
    userId,
    now(),
    now()
  );
  return token;
}

export function resolveSession(token) {
  const hash = sha256(token);
  const row = db.prepare("SELECT user_id, last_used_at FROM sessions WHERE token_hash = ?").get(hash);
  if (!row) return null;
  const last = Date.parse(row.last_used_at || "") || 0;
  const idleMs = Number(process.env.SESSION_IDLE_MS) || 90 * 24 * 60 * 60 * 1000;
  if (last && Date.now() - last > idleMs) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
    return null;
  }
  db.prepare("UPDATE sessions SET last_used_at = ? WHERE token_hash = ?").run(now(), hash);
  return row.user_id;
}

export function destroySession(token) {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

// ---- Signup / login ----

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_PASSWORD_LENGTH = 128;

export function signup(email, password, refCode, { termsAccepted } = {}) {
  email = (email || "").trim().toLowerCase();
  password = password || "";
  if (!EMAIL_RE.test(email)) throw httpError(400, "Enter a valid email address.");
  if (password.length < 8) throw httpError(400, "Password must be at least 8 characters.");
  if (password.length > MAX_PASSWORD_LENGTH) throw httpError(400, "Password is too long.");
  if (!termsAccepted) {
    throw httpError(400, "Please agree to the Terms of Service and Privacy Policy.");
  }
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) throw httpError(409, "An account with that email already exists. Sign in instead.");
  const ts = now();
  const info = db
    .prepare(
      "INSERT INTO users (email, password_hash, created_at, terms_accepted_at) VALUES (?, ?, ?, ?)"
    )
    .run(email, hashPassword(password), ts, ts);
  const userId = Number(info.lastInsertRowid);
  bootstrapUser(userId);
  applyReferral(userId, refCode);
  return { id: userId, email };
}

// Referral reward: both sides earn bonus drafts on top of their monthly cap.
export const REFERRAL_BONUS = 20;

export function applyReferral(newUserId, refCode) {
  const code = (refCode || "").trim().toUpperCase();
  if (!code) return;
  const referrer = db.prepare("SELECT id FROM users WHERE ref_code = ?").get(code);
  if (!referrer || referrer.id === newUserId) return;
  db.prepare("UPDATE users SET referred_by = ?, bonus_drafts = bonus_drafts + ? WHERE id = ?").run(
    referrer.id,
    REFERRAL_BONUS,
    newUserId
  );
  db.prepare("UPDATE users SET bonus_drafts = bonus_drafts + ? WHERE id = ?").run(REFERRAL_BONUS, referrer.id);
}

export function login(email, password) {
  email = (email || "").trim().toLowerCase();
  password = password || "";
  if (password.length > MAX_PASSWORD_LENGTH) throw httpError(401, "Wrong email or password.");
  const user = db
    .prepare("SELECT id, email, password_hash, privy_did, disabled_at FROM users WHERE email = ?")
    .get(email);
  if (user && user.id !== 1 && !user.password_hash) {
    if (user.privy_did) {
      throw httpError(400, "This account uses Privy sign-in — tap Continue with Privy.");
    }
    throw httpError(400, "This account uses Google sign-in - tap Continue with Google.");
  }
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw httpError(401, "Wrong email or password.");
  }
  if (user.disabled_at) throw httpError(403, "This account has been disabled.");
  return { id: user.id, email: user.email };
}

export function getUser(userId) {
  const user = db
    .prepare(
      `SELECT id, email, tier, bonus_drafts, COALESCE(video_credits, 0) AS video_credits,
              stripe_customer_id, stripe_subscription_id, created_at,
              terms_accepted_at, disabled_at
       FROM users WHERE id = ?`
    )
    .get(userId);
  if (user) user.ref_code = ensureRefCode(userId);
  return user;
}

export function assertUserActive(userId) {
  const row = db.prepare("SELECT disabled_at FROM users WHERE id = ?").get(userId);
  if (row?.disabled_at) {
    const err = new Error("This account has been disabled.");
    err.status = 403;
    throw err;
  }
}

export function acceptTerms(userId) {
  db.prepare("UPDATE users SET terms_accepted_at = COALESCE(terms_accepted_at, ?) WHERE id = ?").run(
    now(),
    userId
  );
}

export function setUserDisabled(userId, disabled) {
  if (disabled) {
    db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").run(now(), userId);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM api_keys WHERE user_id = ?").run(userId);
  } else {
    db.prepare("UPDATE users SET disabled_at = NULL WHERE id = ?").run(userId);
  }
}

// Google-verified email: link to the existing account or create a
// password-less one (they'll always sign in via Google).
export function findOrCreateGoogleUser(email, { refCode } = {}) {
  email = email.trim().toLowerCase();
  const existing = db
    .prepare("SELECT id, email, disabled_at, password_hash FROM users WHERE email = ?")
    .get(email);
  if (existing) {
    if (existing.disabled_at) throw httpError(403, "This account has been disabled.");
    // Unverified password signup must not inherit a later Google login.
    if (existing.password_hash) {
      throw httpError(409, "An account with that email already exists. Sign in with email and password.");
    }
    return { id: existing.id, email: existing.email, created: false };
  }
  const ts = now();
  const info = db
    .prepare(
      "INSERT INTO users (email, password_hash, created_at, terms_accepted_at) VALUES (?, NULL, ?, ?)"
    )
    .run(email, ts, ts);
  const userId = Number(info.lastInsertRowid);
  bootstrapUser(userId);
  applyReferral(userId, refCode);
  return { id: userId, email, created: true };
}

// Privy-verified identity: link by DID, then by email, else create
// a password-less account (they'll sign in via Privy after that).
export function findOrCreatePrivyUser(did, email, { refCode } = {}) {
  did = String(did || "").trim();
  if (!did.startsWith("did:privy:")) throw httpError(401, "Invalid Privy session.");
  email = (email || "").trim().toLowerCase();
  if (!email) throw httpError(400, "Privy account has no email or wallet to identify you.");

  const byDid = db
    .prepare("SELECT id, email, disabled_at FROM users WHERE privy_did = ?")
    .get(did);
  if (byDid) {
    if (byDid.disabled_at) throw httpError(403, "This account has been disabled.");
    return { id: byDid.id, email: byDid.email, created: false };
  }

  const existing = db
    .prepare("SELECT id, email, privy_did, disabled_at, password_hash FROM users WHERE email = ?")
    .get(email);
  if (existing) {
    if (existing.disabled_at) throw httpError(403, "This account has been disabled.");
    if (existing.privy_did && existing.privy_did !== did) {
      throw httpError(409, "That email is already linked to a different account.");
    }
    if (existing.password_hash && !existing.privy_did) {
      throw httpError(409, "An account with that email already exists. Sign in with email and password.");
    }
    if (!existing.privy_did) {
      db.prepare("UPDATE users SET privy_did = ? WHERE id = ?").run(did, existing.id);
    }
    return { id: existing.id, email: existing.email, created: false };
  }

  const ts = now();
  const info = db
    .prepare(
      "INSERT INTO users (email, password_hash, created_at, terms_accepted_at, privy_did) VALUES (?, NULL, ?, ?, ?)"
    )
    .run(email, ts, ts, did);
  const userId = Number(info.lastInsertRowid);
  bootstrapUser(userId);
  applyReferral(userId, refCode);
  return { id: userId, email, created: true };
}

/** Persist email list + last login, then ping ops inbox (non-blocking). */
export function noteAuthEvent({ userId, email, method, isNew }) {
  const payload = recordAuthEvent({ userId, email, method, isNew });
  if (!payload) return;
  const ts = payload.ts;
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(ts, userId);
  const existing = db.prepare("SELECT * FROM contacts WHERE email = ?").get(payload.email);
  if (!existing) {
    db.prepare(
      `INSERT INTO contacts (email, user_id, source, first_seen_at, last_login_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(payload.email, userId, payload.source, ts, ts);
  } else {
    db.prepare(
      "UPDATE contacts SET user_id = ?, last_login_at = ?, source = COALESCE(source, ?) WHERE email = ?"
    ).run(userId, ts, payload.source, payload.email);
  }
  const contact = db.prepare("SELECT last_notified_at FROM contacts WHERE email = ?").get(payload.email);
  if (!shouldNotifyLogin(contact?.last_notified_at, payload.isNew)) return;
  if (!mailConfigured()) return;
  const mail = formatAuthMail(payload);
  void notifyOwner(mail).then((ok) => {
    if (ok) {
      db.prepare("UPDATE contacts SET last_notified_at = ? WHERE email = ?").run(
        new Date().toISOString(),
        payload.email
      );
    }
  });
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
