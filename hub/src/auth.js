import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db, bootstrapUser, ensureRefCode } from "./db.js";

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
  const row = db.prepare("SELECT user_id FROM sessions WHERE token_hash = ?").get(sha256(token));
  if (!row) return null;
  db.prepare("UPDATE sessions SET last_used_at = ? WHERE token_hash = ?").run(now(), sha256(token));
  return row.user_id;
}

export function destroySession(token) {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

// ---- Signup / login ----

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function signup(email, password, refCode) {
  email = (email || "").trim().toLowerCase();
  password = password || "";
  if (!EMAIL_RE.test(email)) throw httpError(400, "Enter a valid email address.");
  if (password.length < 8) throw httpError(400, "Password must be at least 8 characters.");
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) throw httpError(409, "An account with that email already exists. Sign in instead.");
  const info = db
    .prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)")
    .run(email, hashPassword(password), now());
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
  const user = db.prepare("SELECT id, email, password_hash FROM users WHERE email = ?").get(email);
  if (user && user.id !== 1 && !user.password_hash) {
    throw httpError(400, "This account uses Google sign-in - tap Continue with Google.");
  }
  if (!user || !verifyPassword(password || "", user.password_hash)) {
    throw httpError(401, "Wrong email or password.");
  }
  return { id: user.id, email: user.email };
}

export function getUser(userId) {
  const user = db
    .prepare(
      "SELECT id, email, tier, bonus_drafts, stripe_customer_id, stripe_subscription_id, created_at FROM users WHERE id = ?"
    )
    .get(userId);
  if (user) user.ref_code = ensureRefCode(userId);
  return user;
}

// Google-verified email: link to the existing account or create a
// password-less one (they'll always sign in via Google).
export function findOrCreateGoogleUser(email) {
  email = email.trim().toLowerCase();
  const existing = db.prepare("SELECT id, email FROM users WHERE email = ?").get(email);
  if (existing) return existing;
  const info = db
    .prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, NULL, ?)")
    .run(email, now());
  const userId = Number(info.lastInsertRowid);
  bootstrapUser(userId);
  return { id: userId, email };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
