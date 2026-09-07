import { db } from "./db.js";

let hits = 0;

function prune() {
  db.prepare("DELETE FROM rate_buckets WHERE reset_at < ?").run(Date.now());
}

/**
 * Shared SQLite limiter (survives process restart; one Fly volume = one counter).
 * Returns wait seconds if the bucket is full, otherwise 0.
 */
export function takeRateLimit(bucket, limit, windowMs) {
  const nowMs = Date.now();
  hits++;
  if (hits % 200 === 0) prune();
  return db.transaction(() => {
    const row = db.prepare("SELECT count, reset_at FROM rate_buckets WHERE bucket = ?").get(bucket);
    if (!row || row.reset_at <= nowMs) {
      db.prepare("INSERT OR REPLACE INTO rate_buckets (bucket, count, reset_at) VALUES (?, 1, ?)").run(
        bucket,
        nowMs + windowMs
      );
      return 0;
    }
    if (row.count >= limit) return Math.max(1, Math.ceil((row.reset_at - nowMs) / 1000));
    const upd = db
      .prepare("UPDATE rate_buckets SET count = count + 1 WHERE bucket = ? AND count < ? AND reset_at > ?")
      .run(bucket, limit, nowMs);
    if (!upd.changes) return Math.max(1, Math.ceil((row.reset_at - nowMs) / 1000));
    return 0;
  })();
}
