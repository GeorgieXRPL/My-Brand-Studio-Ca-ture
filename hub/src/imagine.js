/**
 * xAI Grok Imagine — video (and optional still) generation.
 * Docs: https://docs.x.ai/developers/model-capabilities/imagine
 */

const XAI_BASE = "https://api.x.ai/v1";

export function imagineConfigured() {
  return Boolean(process.env.XAI_API_KEY?.trim());
}

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.XAI_API_KEY}`,
    "Content-Type": "application/json",
  };
}

export function videoModel() {
  return process.env.XAI_VIDEO_MODEL || "grok-imagine-video-1.5";
}

export function imageModel() {
  return process.env.XAI_IMAGE_MODEL || "grok-imagine-image";
}

/** Monthly Studio clip allowance (completed + in-flight starts). */
export function imagineMonthlyLimit() {
  const n = Number(process.env.IMAGINE_MONTHLY_LIMIT);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

const FILM_POST_PLATFORMS = new Set(["tiktok", "instagram", "snapchat"]);

/** Lightweight parse of HOOK:/BEAT:/ON_SCREEN:/CAPTION:/IMAGINE: labeled scripts. */
export function parseFilmLabels(raw) {
  const text = (raw || "").trim();
  if (!text) return { hook: "", beats: [], onScreen: "", keyword: "", caption: "", imagine: "", labeled: false };
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  let hook = "";
  let onScreen = "";
  let keyword = "";
  let caption = "";
  let imagine = "";
  const beats = [];
  const labeled = /^(hook|beat\s*\d*|on[-\s]?screen|caption|imagine)\s*[:\-–]/im.test(text);
  for (const line of lines) {
    const m = line.match(
      /^(hook|beat\s*\d*|on[-\s]?screen|keyword|search|caption|imagine|prompt)\s*[:\-–]\s*(.+)$/i
    );
    if (!m) continue;
    const label = m[1].toLowerCase();
    const body = m[2].trim();
    if (label.startsWith("hook")) hook = body;
    else if (label.startsWith("beat")) beats.push(body);
    else if (label.includes("screen")) onScreen = body;
    else if (label.startsWith("keyword") || label.startsWith("search")) keyword = body;
    else if (label.startsWith("caption")) caption = body;
    else if (label.startsWith("imagine") || label.startsWith("prompt")) imagine = body;
  }
  if (!hook) {
    const first = lines.find((l) => !/^#/.test(l) && !/^caption\b/i.test(l) && !/^imagine\b/i.test(l));
    hook = (first || text).slice(0, 160);
  }
  if (!caption && labeled) {
    caption = hook.split(/[.!?]/)[0].trim();
  }
  return { hook, beats, onScreen, keyword, caption, imagine, labeled };
}

/** Caption for Share/Post — never the full talk-track script on video platforms. */
export function extractPostCaption(raw, platform) {
  const text = (raw || "").trim();
  if (!text) return "";
  if (!FILM_POST_PLATFORMS.has(platform)) return text;
  const labels = parseFilmLabels(text);
  if (labels.labeled || /^caption\s*[:\-–]/im.test(text)) {
    return (labels.caption || labels.hook || text).trim();
  }
  return text;
}

/**
 * Build a vertical short-form video prompt from draft topic + film beats.
 */
export function buildVideoPrompt({ topic, hook, beats, onScreen, keyword, brandVoice, burnIn = true }) {
  const beatLine = (beats || []).filter(Boolean).slice(0, 4).join("; ");
  const textLine =
    burnIn && onScreen
      ? `Burn this exact text clearly onto the video (large, readable, lower-third or center, high contrast): "${onScreen}".`
      : "Do not burn any captions, titles, or watermarks onto the video.";
  const parts = [
    "Vertical 9:16 short-form social video for TikTok/Reels.",
    "Energetic, mobile-first, natural motion.",
    textLine,
    topic ? `Topic: ${topic}.` : "",
    hook ? `Opening hook energy: ${hook}.` : "",
    beatLine ? `Story beats: ${beatLine}.` : "",
    !burnIn && onScreen ? `Visual focus (no text overlay): ${onScreen}.` : "",
    keyword ? `Subtle theme keyword: ${keyword}.` : "",
    brandVoice ? `Brand vibe: ${String(brandVoice).slice(0, 200)}.` : "",
  ];
  return parts.filter(Boolean).join(" ").slice(0, 1800);
}

export async function startVideoGeneration({
  prompt,
  imageUrl,
  duration = 8,
  aspectRatio = "9:16",
  resolution = "720p",
}) {
  if (!imagineConfigured()) {
    const err = new Error("AI clip generation is not configured on this hub.");
    err.status = 503;
    throw err;
  }

  const body = {
    model: videoModel(),
    prompt,
    duration: Math.min(15, Math.max(1, Number(duration) || 8)),
    aspect_ratio: aspectRatio,
    resolution,
  };
  if (imageUrl) {
    body.image = { url: imageUrl };
  }

  const res = await fetch(`${XAI_BASE}/videos/generations`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || data?.error || `xAI video start failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  if (!data.request_id) {
    throw new Error("xAI did not return a request_id");
  }
  return { requestId: data.request_id };
}

export async function pollVideo(requestId) {
  const res = await fetch(`${XAI_BASE}/videos/${encodeURIComponent(requestId)}`, {
    headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || data?.error || `xAI poll failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return {
    status: data.status, // pending | done | failed | expired
    progress: data.progress ?? null,
    url: data.video?.url || data.video?.file_output?.public_url || null,
    duration: data.video?.duration ?? null,
    error: data.error?.message || null,
    respectModeration: data.video?.respect_moderation,
  };
}

export async function downloadBinary(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download generated media (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = (res.headers.get("content-type") || "video/mp4").split(";")[0].trim();
  return { buf, mime };
}

/** Sync still image — useful for thumbnails / carousels. */
export async function generateStill({ prompt, aspectRatio = "9:16" }) {
  if (!imagineConfigured()) {
    const err = new Error("AI image generation is not configured on this hub.");
    err.status = 503;
    throw err;
  }
  const res = await fetch(`${XAI_BASE}/images/generations`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: imageModel(),
      prompt,
      n: 1,
      aspect_ratio: aspectRatio,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || data?.error || `xAI image failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const url = data.data?.[0]?.url || data.url;
  if (!url) throw new Error("xAI did not return an image URL");
  return { url };
}
