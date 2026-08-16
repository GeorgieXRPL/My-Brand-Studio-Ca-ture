/**
 * Deterministic on-screen text overlays (not AI-painted glyphs).
 * Stills: SVG → sharp PNG composite.
 * Video: PNG lower-third + ffmpeg overlay.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let sharp = null;
try {
  sharp = require("sharp");
} catch {
  sharp = null;
}

export function normalizeOnScreen(text, { maxWords = 8 } = {}) {
  let t = String(text || "")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/--+/g, " ")
    .replace(/[^\w\s'’!?.,%-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  const words = t.split(" ").filter(Boolean);
  if (words.length > maxWords) t = words.slice(0, maxWords).join(" ");
  return t.slice(0, 72);
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Wrap into 1–3 short lines for vertical social. */
export function wrapOverlayLines(text, maxChars = 18) {
  const words = normalizeOnScreen(text).split(" ").filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length >= 3) break;
    } else {
      cur = next;
    }
  }
  if (cur && lines.length < 3) lines.push(cur);
  return lines.slice(0, 3);
}

function overlaySvg(lines, width, height) {
  const fontSize = Math.round(Math.min(width, height) * 0.055);
  const lineH = Math.round(fontSize * 1.25);
  const padX = Math.round(width * 0.08);
  const blockH = lines.length * lineH + Math.round(fontSize * 0.9);
  const y0 = Math.round(height * 0.72);
  const scrimTop = y0 - Math.round(fontSize * 0.5);
  const textEls = lines
    .map((line, i) => {
      const y = y0 + i * lineH;
      return `<text x="50%" y="${y}" text-anchor="middle" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="700" letter-spacing="0.02em" style="paint-order:stroke fill;stroke:#0a0a12;stroke-width:${Math.max(4, Math.round(fontSize * 0.14))}px">${escapeXml(line)}</text>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.55"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${scrimTop}" width="${width}" height="${height - scrimTop}" fill="url(#scrim)"/>
  ${textEls}
</svg>`;
}

async function svgToPng(svg, width, height) {
  if (!sharp) throw new Error("sharp is required for text overlays");
  return sharp(Buffer.from(svg))
    .resize(width, height, { fit: "fill" })
    .png()
    .toBuffer();
}

export async function burnTextOntoImage(imageBuf, text) {
  const clean = normalizeOnScreen(text);
  if (!clean || !sharp) return imageBuf;
  const meta = await sharp(imageBuf).metadata();
  const width = meta.width || 1080;
  const height = meta.height || 1920;
  const lines = wrapOverlayLines(clean);
  if (!lines.length) return imageBuf;
  const overlay = await svgToPng(overlaySvg(lines, width, height), width, height);
  return sharp(imageBuf)
    .composite([{ input: overlay, top: 0, left: 0 }])
    .jpeg({ quality: 92 })
    .toBuffer();
}

/**
 * Stamp a logo/mark in a corner (default bottom-right).
 * watermarkBuf should be PNG/WebP with transparency when possible.
 * Sized relative to the actual frame (not a hardcoded 1080 assumption).
 */
export async function burnWatermarkOntoImage(
  imageBuf,
  watermarkBuf,
  { position = "br", scale = 0.16, opacity = 0.9, margin = 0.04 } = {}
) {
  if (!sharp || !watermarkBuf?.length) return imageBuf;
  const base = sharp(imageBuf);
  const meta = await base.metadata();
  const width = meta.width || 1080;
  const height = meta.height || 1920;
  // Allow enlarging small logos — tiny uploads were nearly invisible on 720p clips.
  const targetW = Math.max(72, Math.round(Math.min(width, height) * scale));
  const mark = await sharp(watermarkBuf)
    .ensureAlpha()
    .resize({ width: targetW, withoutEnlargement: false })
    .png()
    .toBuffer();
  const markMeta = await sharp(mark).metadata();
  const mw = markMeta.width || targetW;
  const mh = markMeta.height || targetW;
  const pad = Math.round(Math.min(width, height) * margin);
  let left = pad;
  let top = pad;
  if (position === "br" || position === "tr") left = Math.max(0, width - mw - pad);
  if (position === "br" || position === "bl") top = Math.max(0, height - mh - pad);

  let markInput = mark;
  if (opacity < 0.999) {
    const raw = await sharp(mark).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const data = Buffer.from(raw.data);
    const a = Math.max(0, Math.min(1, opacity));
    for (let i = 3; i < data.length; i += 4) data[i] = Math.round(data[i] * a);
    markInput = await sharp(data, {
      raw: { width: raw.info.width, height: raw.info.height, channels: 4 },
    })
      .png()
      .toBuffer();
  }

  return sharp(imageBuf)
    .composite([{ input: markInput, left, top }])
    .jpeg({ quality: 92 })
    .toBuffer();
}

/**
 * Mobile / WhatsApp / TikTok / IG Reels friendly H.264.
 * Grok Imagine often emits High 4:4:4 Predictive + yuv444p — plays in Chrome,
 * black screen or "won't load" on WhatsApp and many Android share targets.
 *
 * Note: do not mix `-vf` with `-filter_complex` (overlay paths). Use SOCIAL_VF
 * only on simple re-encodes; append `,format=yuv420p` inside filter_complex instead.
 */
const SOCIAL_VF =
  "scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos,setsar=1,format=yuv420p";

/** Codec/container flags shared by normalize + overlay encodes (no -vf). */
const SOCIAL_H264_CODEC = [
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-profile:v",
  "main",
  "-level",
  "4.0",
  "-preset",
  "veryfast",
  "-crf",
  "20",
  // Keep short social clips under common WhatsApp ~16MB caps.
  "-maxrate",
  "8M",
  "-bufsize",
  "16M",
  "-movflags",
  "+faststart",
  "-brand",
  "mp42",
];

const SOCIAL_H264 = ["-vf", SOCIAL_VF, ...SOCIAL_H264_CODEC];

const SOCIAL_AAC = ["-c:a", "aac", "-profile:a", "aac_low", "-b:a", "128k", "-ac", "2", "-ar", "44100"];

function probeVideoPath(path) {
  try {
    const out = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name,profile,pix_fmt,width,height:format=size",
        "-of",
        "json",
        path,
      ],
      { encoding: "utf8" }
    );
    if (out.status !== 0) return null;
    return JSON.parse(out.stdout || "{}");
  } catch {
    return null;
  }
}

/** True when the file will black-screen or reject on WhatsApp/TikTok/old Android. */
export function videoIsSocialHostile(path) {
  const probe = probeVideoPath(path);
  if (!probe) return true;
  const v = (probe.streams || []).find((s) => s.codec_type === "video");
  if (!v) return true;
  const pix = String(v.pix_fmt || "");
  const profile = String(v.profile || "");
  if (pix && pix !== "yuv420p" && pix !== "yuvj420p") return true;
  if (profile.includes("4:4:4")) return true;
  if (v.width % 2 !== 0 || v.height % 2 !== 0) return true;
  const size = Number(probe.format?.size || 0);
  // Oversized clips often fail mid-upload on WhatsApp.
  if (size > 15 * 1024 * 1024) return true;
  return false;
}

/**
 * Re-encode to social-safe MP4 (H.264 Main yuv420p + AAC-LC 44.1kHz + faststart).
 * Idempotent: skips when the source is already mobile-safe.
 */
export async function normalizeVideoForShare(videoBuf, { force = false } = {}) {
  if (!ffmpegAvailable() || !videoBuf?.length) return videoBuf;
  const dir = mkdtempSync(join(tmpdir(), "bs-social-"));
  const inPath = join(dir, "in.mp4");
  const outPath = join(dir, "out.mp4");
  try {
    writeFileSync(inPath, videoBuf);
    if (!force && !videoIsSocialHostile(inPath)) return videoBuf;
    try {
      await runFfmpeg(["-i", inPath, ...SOCIAL_H264, ...SOCIAL_AAC, outPath]);
    } catch {
      // No/odd audio — add a short silent AAC track (TikTok/Android share prefer A/V).
      try {
        await runFfmpeg([
          "-i",
          inPath,
          "-f",
          "lavfi",
          "-i",
          "anullsrc=channel_layout=stereo:sample_rate=44100",
          ...SOCIAL_H264,
          "-shortest",
          ...SOCIAL_AAC,
          outPath,
        ]);
      } catch {
        await runFfmpeg(["-i", inPath, ...SOCIAL_H264, "-an", outPath]);
      }
    }
    if (!existsSync(outPath)) throw new Error("ffmpeg social normalize produced no output");
    return readFileSync(outPath);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Burn brand mark onto video — default lower-right.
 * Uses scale2ref so the logo is ~16% of frame width on any resolution (720p/1080p).
 * Throws if ffmpeg/sharp are missing or the encode fails (callers must not treat as silent success).
 */
export async function burnWatermarkOntoVideo(
  videoBuf,
  watermarkBuf,
  { position = "br", scale = 0.16, opacity = 0.9, margin = 0.04 } = {}
) {
  if (!watermarkBuf?.length) throw new Error("Watermark image is missing.");
  if (!ffmpegAvailable()) throw new Error("ffmpeg is not available for watermarking.");
  if (!sharp) throw new Error("sharp is not available for watermarking.");
  const dir = mkdtempSync(join(tmpdir(), "bs-wm-"));
  const inPath = join(dir, "in.mp4");
  const markPath = join(dir, "mark.png");
  const outPath = join(dir, "out.mp4");
  try {
    writeFileSync(inPath, videoBuf);
    const mark = await sharp(watermarkBuf).ensureAlpha().png().toBuffer();
    writeFileSync(markPath, mark);

    const sc = Math.max(0.08, Math.min(0.35, Number(scale) || 0.16));
    const fade = Math.max(0.35, Math.min(1, Number(opacity) || 0.9));
    const marginPct = Math.max(0.02, Math.min(0.1, Number(margin) || 0.04));

    let overlayXY = `W-w-W*${marginPct}:H-h-H*${marginPct}`;
    if (position === "bl") overlayXY = `W*${marginPct}:H-h-H*${marginPct}`;
    else if (position === "tr") overlayXY = `W-w-W*${marginPct}:H*${marginPct}`;
    else if (position === "tl") overlayXY = `W*${marginPct}:H*${marginPct}`;

    await runFfmpeg([
      "-i",
      inPath,
      "-i",
      markPath,
      "-filter_complex",
      `[1:v]format=rgba,colorchannelmixer=aa=${fade}[wm0];` +
        `[wm0][0:v]scale2ref=w=iw*${sc}:h=ow/mdar[wm][base];` +
        `[base][wm]overlay=${overlayXY}:format=auto,format=yuv420p,setsar=1`,
      ...SOCIAL_H264_CODEC,
      ...SOCIAL_AAC,
      outPath,
    ]);
    if (!existsSync(outPath)) throw new Error("ffmpeg watermark produced no output");
    const out = readFileSync(outPath);
    if (!out.length) throw new Error("ffmpeg watermark produced an empty file");
    return out;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.slice(-800) || `ffmpeg exited ${code}`));
    });
  });
}

export function ffmpegAvailable() {
  try {
    const r = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
    return r.status === 0;
  } catch {
    return false;
  }
}

export async function burnTextOntoVideo(videoBuf, text) {
  const clean = normalizeOnScreen(text);
  if (!clean) return videoBuf;
  if (!ffmpegAvailable() || !sharp) return videoBuf;

  const dir = mkdtempSync(join(tmpdir(), "bs-overlay-"));
  const inPath = join(dir, "in.mp4");
  const overlayPath = join(dir, "overlay.png");
  const outPath = join(dir, "out.mp4");
  try {
    writeFileSync(inPath, videoBuf);
    // Probe size via sharp frame extract isn't trivial; use 1080x1920 default for 9:16
    // and let ffmpeg scale overlay to video size.
    const width = 1080;
    const height = 1920;
    const lines = wrapOverlayLines(clean);
    const png = await svgToPng(overlaySvg(lines, width, height), width, height);
    writeFileSync(overlayPath, png);

    await runFfmpeg([
      "-i",
      inPath,
      "-i",
      overlayPath,
      "-filter_complex",
      "[1:v][0:v]scale2ref=w=iw:h=ih[ovr][base];[base][ovr]overlay=0:0:format=auto,format=yuv420p,setsar=1",
      ...SOCIAL_H264_CODEC,
      ...SOCIAL_AAC,
      outPath,
    ]);
    if (!existsSync(outPath)) throw new Error("ffmpeg produced no output");
    return readFileSync(outPath);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Mux an mp3/aac narration under an existing video (replace or mix). */
export async function muxNarrationOntoVideo(videoBuf, audioBuf, { audioExt = "mp3" } = {}) {
  if (!ffmpegAvailable() || !audioBuf?.length) return videoBuf;
  const dir = mkdtempSync(join(tmpdir(), "bs-voice-"));
  const inPath = join(dir, "in.mp4");
  const audPath = join(dir, `voice.${audioExt}`);
  const outPath = join(dir, "out.mp4");
  try {
    writeFileSync(inPath, videoBuf);
    writeFileSync(audPath, audioBuf);
    await runFfmpeg([
      "-i",
      inPath,
      "-i",
      audPath,
      "-filter_complex",
      "[0:a]volume=0.15[a0];[1:a]volume=1.0[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=2[aout]",
      "-map",
      "0:v",
      "-map",
      "[aout]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-shortest",
      "-movflags",
      "+faststart",
      outPath,
    ]);
    // If source has no audio track, amix may fail — retry voice-only.
    if (!existsSync(outPath)) {
      await runFfmpeg([
        "-i",
        inPath,
        "-i",
        audPath,
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-shortest",
        "-movflags",
        "+faststart",
        outPath,
      ]);
    }
    return readFileSync(outPath);
  } catch {
    try {
      await runFfmpeg([
        "-i",
        inPath,
        "-i",
        audPath,
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-shortest",
        "-movflags",
        "+faststart",
        outPath,
      ]);
      return readFileSync(outPath);
    } catch {
      return videoBuf;
    }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
