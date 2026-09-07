import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "./db.js";

function signingSecret() {
  const fromEnv = (process.env.MEDIA_SIGNING_SECRET || "").trim();
  if (fromEnv) return fromEnv;
  const row = db.prepare("SELECT value FROM hub_kv WHERE key = 'media_signing_secret'").get();
  if (row?.value) return row.value;
  const value = randomBytes(32).toString("hex");
  db.prepare("INSERT OR IGNORE INTO hub_kv (key, value) VALUES ('media_signing_secret', ?)").run(value);
  return db.prepare("SELECT value FROM hub_kv WHERE key = 'media_signing_secret'").get()?.value || value;
}

export function signMediaId(id, ttlSec = 7 * 24 * 3600) {
  const exp = Math.floor(Date.now() / 1000) + Math.max(60, Number(ttlSec) || 0);
  const sig = createHmac("sha256", signingSecret()).update(`${id}.${exp}`).digest("hex").slice(0, 32);
  return { exp, sig };
}

export function verifyMediaSig(id, exp, sig) {
  const e = Number(exp);
  if (!id || !sig || !Number.isFinite(e) || e < Date.now() / 1000) return false;
  const expected = createHmac("sha256", signingSecret()).update(`${id}.${e}`).digest("hex").slice(0, 32);
  const a = Buffer.from(String(sig), "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function appendMediaSig(url, id, ttlSec) {
  const { exp, sig } = signMediaId(id, ttlSec);
  const u = new URL(url, "http://local.invalid");
  u.searchParams.set("e", String(exp));
  u.searchParams.set("s", sig);
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return `${u.origin}${u.pathname}?${u.searchParams}`;
  }
  return `${u.pathname}?${u.searchParams}`;
}
