#!/usr/bin/env node
/** Probe recent Imagine videos for WhatsApp/TikTok-hostile codecs. */
import { execSync } from "node:child_process";
import Database from "better-sqlite3";

const db = new Database(process.env.HUB_DB || "/data/hub.db", { readonly: true });
const rows = db
  .prepare(
    `SELECT j.id, j.created_at, j.media_url, m.size, m.mime
     FROM imagine_jobs j
     LEFT JOIN media m ON m.id = replace(j.media_url, 'https://brand-studio-hub.fly.dev/media/', '')
     WHERE j.kind = 'video' AND j.status = 'done'
     ORDER BY j.id DESC LIMIT 20`
  )
  .all();

for (const r of rows) {
  const id = (r.media_url || "").split("/").pop();
  let probe = "missing";
  try {
    probe = execSync(
      `ffprobe -v error -show_entries stream=codec_type,codec_name,profile,pix_fmt,width,height,sample_rate,channels:format=duration,size -of json /data/media/${id}`,
      { encoding: "utf8" }
    ).trim();
  } catch {
    probe = "ffprobe-failed";
  }
  let summary = probe;
  try {
    const j = JSON.parse(probe);
    const v = (j.streams || []).find((s) => s.codec_type === "video") || {};
    const a = (j.streams || []).find((s) => s.codec_type === "audio") || {};
    const bad444 = v.pix_fmt && v.pix_fmt !== "yuv420p" && v.pix_fmt !== "yuvj420p";
    summary = {
      id: r.id,
      media: id,
      size: r.size,
      created: r.created_at,
      video: `${v.codec_name}/${v.profile}/${v.pix_fmt} ${v.width}x${v.height}`,
      audio: a.codec_name ? `${a.codec_name} ${a.sample_rate || "?"}Hz ch${a.channels || "?"}` : "none",
      duration: j.format?.duration,
      hostile: bad444 || String(v.profile || "").includes("4:4:4"),
    };
  } catch {
    /* keep raw */
  }
  console.log(typeof summary === "string" ? summary : JSON.stringify(summary));
}
