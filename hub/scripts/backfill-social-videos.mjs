#!/usr/bin/env node
/**
 * Re-encode existing Imagine videos that WhatsApp/TikTok reject (yuv444p / 4:4:4 / oversized).
 * Overwrites media files in place and updates size in the DB so draft URLs keep working.
 *
 * Usage (on hub VM): node scripts/backfill-social-videos.mjs
 * Dry run:           DRY_RUN=1 node scripts/backfill-social-videos.mjs
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const { normalizeVideoForShare, videoIsSocialHostile, ffmpegAvailable } = await import(
  "../src/overlay.js"
);

const dbPath = process.env.HUB_DB || "/data/hub.db";
const mediaDir = process.env.MEDIA_DIR || "/data/media";
const dry = Boolean(process.env.DRY_RUN);
const db = new Database(dbPath);

if (!ffmpegAvailable()) {
  console.error("ffmpeg not available");
  process.exit(1);
}

const rows = db
  .prepare(
    `SELECT DISTINCT m.id, m.size, m.mime, m.user_id
     FROM media m
     JOIN imagine_jobs j ON j.media_url LIKE '%' || m.id
     WHERE j.kind = 'video' AND j.status = 'done' AND m.mime LIKE 'video/%'
     ORDER BY m.created_at DESC`
  )
  .all();

console.log(`Scanning ${rows.length} video media rows (dry=${dry ? 1 : 0})`);
let fixed = 0;
let skipped = 0;
let failed = 0;

for (const row of rows) {
  const path = join(mediaDir, row.id);
  if (!existsSync(path)) {
    console.warn("missing", row.id);
    failed++;
    continue;
  }
  if (!videoIsSocialHostile(path)) {
    skipped++;
    continue;
  }
  try {
    const before = readFileSync(path);
    const after = await normalizeVideoForShare(before, { force: true });
    if (!after?.length) throw new Error("empty output");
    console.log(
      `${dry ? "WOULD FIX" : "FIXED"} ${row.id} ${row.size} -> ${after.length} (${(
        (after.length / Math.max(1, row.size)) *
        100
      ).toFixed(0)}%)`
    );
    if (!dry) {
      writeFileSync(path, after);
      db.prepare("UPDATE media SET size = ? WHERE id = ?").run(after.length, row.id);
    }
    fixed++;
  } catch (e) {
    console.error("fail", row.id, e.message || e);
    failed++;
  }
}

console.log(JSON.stringify({ fixed, skipped, failed, total: rows.length, dry }, null, 2));
