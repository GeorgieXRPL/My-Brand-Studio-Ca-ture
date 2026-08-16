/**
 * One-shot: finish a pending imagine job by downloading xAI output
 * without overlay/TTS (those hung the small Fly VM).
 * Usage: node scripts/finish-stuck-job.mjs [jobId]
 */
import Database from "better-sqlite3";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

const jobId = Number(process.argv[2] || 23);
const dbPath = process.env.DB_PATH || "/data/hub.db";
const mediaDir = process.env.MEDIA_DIR || "/data/media";
const db = new Database(dbPath);

const job = db.prepare("SELECT * FROM imagine_jobs WHERE id = ?").get(jobId);
if (!job) {
  console.error("Job not found", jobId);
  process.exit(1);
}
if (job.status === "done" && job.media_url) {
  console.log(JSON.stringify({ alreadyDone: true, media_url: job.media_url }));
  process.exit(0);
}

const key = process.env.XAI_API_KEY?.trim();
if (!key) {
  console.error("XAI_API_KEY missing");
  process.exit(1);
}

const pollRes = await fetch(`https://api.x.ai/v1/videos/${encodeURIComponent(job.xai_request_id)}`, {
  headers: { Authorization: `Bearer ${key}` },
});
const poll = await pollRes.json().catch(() => ({}));
const url = poll.video?.url || poll.url || poll.data?.url;
console.log(
  JSON.stringify({
    http: pollRes.status,
    status: poll.status,
    progress: poll.progress,
    hasUrl: Boolean(url),
  })
);

if (!url || (poll.status !== "done" && poll.status !== "completed")) {
  console.error("NOT_READY", String(poll.error || poll.message || poll.status).slice(0, 300));
  process.exit(2);
}

const dl = await fetch(url);
if (!dl.ok) {
  console.error("download failed", dl.status);
  process.exit(3);
}
const buf = Buffer.from(await dl.arrayBuffer());
const mimeHdr = (dl.headers.get("content-type") || "video/mp4").split(";")[0].trim();
const mime = mimeHdr.startsWith("video/") ? mimeHdr : "video/mp4";
console.log("downloaded_bytes", buf.length);

mkdirSync(mediaDir, { recursive: true });
const id = randomBytes(16).toString("hex");
writeFileSync(join(mediaDir, id), buf);
const base = (process.env.HUB_PUBLIC_URL || "https://brand-studio-hub.fly.dev").replace(/\/$/, "");
const mediaUrl = `${base}/media/${id}`;
const ts = new Date().toISOString();

db.prepare("INSERT INTO media (id, user_id, mime, size, created_at) VALUES (?, ?, ?, ?, ?)").run(
  id,
  job.user_id,
  mime,
  buf.length,
  ts
);
db.prepare(
  "UPDATE imagine_jobs SET status = 'done', progress = 100, media_url = ?, error = NULL, updated_at = ? WHERE id = ?"
).run(mediaUrl, ts, job.id);
db.prepare("UPDATE drafts SET media_url = ? WHERE id = ? AND user_id = ?").run(
  mediaUrl,
  job.draft_id,
  job.user_id
);

console.log(
  JSON.stringify({
    ok: true,
    jobId: job.id,
    media_url: mediaUrl,
    note: "Saved raw clip; skipped overlay/TTS to avoid hub hang",
  })
);
