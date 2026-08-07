import Anthropic from "@anthropic-ai/sdk";
import { algoKnowledgeAsOf } from "./algoContext.js";
import { resolveOutputLanguage } from "./languages.js";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it to hub/.env");
  }
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

const PLATFORMS = ["x", "facebook", "tiktok", "snapchat", "instagram", "linkedin"];

const TRAIT_LABELS = {
  content_style: "Content style",
  content_types: "Preferred content types",
  target_audience: "Target audience",
  vibe: "Vibe / identity",
  emoji_usage: "Emoji usage",
  cta_preference: "Call-to-action preference",
};

function traitLines(traits) {
  if (!traits || typeof traits !== "object") return "";
  const lines = [];
  for (const [key, label] of Object.entries(TRAIT_LABELS)) {
    const value = traits[key];
    const text = Array.isArray(value) ? value.filter(Boolean).join(", ") : (value || "").toString().trim();
    if (text) lines.push(`- ${label}: ${text}`);
  }
  return lines.length ? `\n\nBRAND SETTINGS (follow strictly):\n${lines.join("\n")}` : "";
}

function languageBlock(profile) {
  const label = resolveOutputLanguage(profile?.traits);
  if (!label || label === "English") return "";
  return [
    "",
    "OUTPUT LANGUAGE (strict — override everything else):",
    `Write EVERY platform caption entirely in ${label}.`,
    `If the idea/topic is in another language, translate the meaning into ${label} first, then write native-feeling posts in ${label} (not stiff word-for-word translation).`,
    "Keep brand names, @handles, product names, and URLs unchanged.",
    `Prefer ${label} hashtags when the platform uses hashtags; mix in a few English discovery tags only if they clearly help reach.`,
  ].join("\n");
}

function buildSystemPrompt(profile) {
  const goals = profile?.goals?.trim() || "(not provided yet)";
  const projects = profile?.projects?.trim() || "(not provided yet)";
  const voice = profile?.brand_voice?.trim() || "(not provided yet - use a friendly, authentic, motivating creator voice)";
  return [
    "You are the content engine for a solo creator building a personal brand.",
    "Your job is to turn one raw idea into platform-native posts that sound like the creator, not like generic marketing.",
    "",
    "CREATOR GOALS:",
    goals,
    "",
    "CURRENT PROJECTS:",
    projects,
    "",
    "BRAND VOICE / AUDIENCE / RULES:",
    voice + traitLines(profile?.traits),
    languageBlock(profile),
    "",
    "Always write in that voice. Be specific, human, and useful. No hashtag spam. No corporate filler.",
  ].join("\n");
}

const PLATFORM_GUIDANCE = `Adapt the SAME idea natively for each platform:
- x: a punchy post OR a short thread (use line breaks). Max ~280 chars per tweet; if a thread, separate tweets with a blank line. Conversational, hook first — write for replies and bookmarks.
- facebook: a slightly longer, warmer post with a clear hook and a light call to engage. 1-3 short paragraphs. Sound native to FB, not a copy-paste of Instagram.
- tiktok: a short-form VIDEO script using this exact labeled format (one line each):
  HOOK: (spoken in first 1–1.5s)
  BEAT 1: …
  BEAT 2: …
  BEAT 3: …
  ON_SCREEN: (short text to put on the video)
  KEYWORD: (1–3 search-friendly spoken words)
  IMAGINE: (1–2 sentences describing visuals/motion for AI video — do not repeat the caption)
  CAPTION: (short post caption + a few hashtags — this is what gets pasted when sharing, NOT the script)
  Keep it energetic and filmable in ~15–30 seconds.
- snapchat: a casual, in-the-moment caption for a snap (1-2 lines) plus a suggested visual.
- instagram: prefer a Reels-ready block when the idea is visual — same HOOK / BEAT / ON_SCREEN / KEYWORD / CAPTION labels as TikTok when it fits; otherwise a caption with a hook line, 2-4 short lines of value, a CTA for saves/DMs, and 5-10 hashtags on a new line.
- linkedin: a professional but human post. Strong first line (dwell), short paragraphs, one clear insight or story, soft CTA for comments/saves. No hashtag spam; avoid leading with an external link.`;

export async function generateVariants({ topic, profile, image, isVideo }) {
  const system = buildSystemPrompt(profile);
  const mediaNote = image
    ? "\n\nThe creator ATTACHED THE IMAGE ABOVE to this idea. Look at it carefully and weave what's actually in it into every post (describe/reference the visual, don't just caption blindly)."
    : isVideo
      ? "\n\nThe creator attached a VIDEO to this idea (you can't watch it). Write posts that pair with a video: strong hooks, watch-this energy, and captions that lead into it."
      : "";
  const userMsg = `IDEA / TOPIC:\n${topic}${mediaNote}\n\n${PLATFORM_GUIDANCE}\n\nReturn ONLY a JSON object (no prose, no code fences) with exactly these string keys: ${PLATFORMS.join(
    ", "
  )}. Each value is the finished post text for that platform.`;

  // Attach the image so Claude can actually see it (vision).
  const content = image
    ? [
        { type: "image", source: { type: "base64", media_type: image.mime, data: image.data } },
        { type: "text", text: userMsg },
      ]
    : userMsg;

  const resp = await getClient().messages.create({
    model: MODEL,
    max_tokens: 2600,
    system,
    messages: [{ role: "user", content }],
  });

  const text = resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const variants = parseJsonObject(text);
  const clean = {};
  for (const p of PLATFORMS) clean[p] = typeof variants[p] === "string" ? variants[p] : "";
  return clean;
}

// Weekly growth analysis: turns the user's own activity data into 2-3
// platform-specific, algorithm-aware tips ("algo jacks"). Real engagement
// metrics are Coming soon — never tell users to link accounts for analytics yet.
export async function generateGrowthTips({ profile, stats }) {
  const algo = algoKnowledgeAsOf();
  const lang = resolveOutputLanguage(profile?.traits);
  const system = [
    "You are a social media growth strategist embedded in a creator app in 2026.",
    "You analyse a creator's brand profile and their recent activity, then produce concrete, platform-specific growth tips (algo jacks).",
    "IMPORTANT: Use ONLY current algorithm behaviour (2025–2026). Never cite outdated 2023–2024 playbooks (e.g. 'golden hour only', like-chasing, hashtag stuffing as primary strategy).",
    "Each tip must reference how the platform's algorithm CURRENTLY rewards content (dwell, completion, DM shares/saves, reply quality, interest-graph matching) and tie it to THIS creator's style and data.",
    "Be specific and actionable. No fluff, no generic advice, no disclaimers.",
    "CRITICAL — metrics are NOT live yet: do NOT tell the user to link, connect, or authorise Instagram/TikTok/X/Facebook/LinkedIn accounts to analyse performance, completion rates, saves, DM shares, or any live analytics. Live metrics are Coming soon. Base advice only on their Brand Brain, draft topics, cadence, and algorithm knowledge. Prefer Share / publish habits they can do today without account linking.",
    lang && lang !== "English" ? `Write every tip title and body entirely in ${lang}.` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const userMsg = [
    `TODAY / KNOWLEDGE AS OF: ${algo.as_of}`,
    "CURRENT ALGORITHM CONTEXT (authoritative — treat as ground truth unless activity data contradicts):",
    JSON.stringify(algo, null, 2),
    "",
    "CREATOR PROFILE:",
    `Goals: ${profile?.goals || "(not set)"}`,
    `Projects: ${profile?.projects || "(not set)"}`,
    `Voice: ${profile?.brand_voice || "(not set)"}`,
    `Traits: ${JSON.stringify(profile?.traits || {})}`,
    "",
    "ACTIVITY DATA (last 30 days — first-party app activity only; live platform metrics are Coming soon — do not ask them to connect accounts for analytics):",
    JSON.stringify(stats, null, 2),
    "",
    "Write exactly 3 growth tips tailored to this creator for THIS week. Return ONLY a JSON array (no prose, no code fences) of objects with string keys:",
    `- "platform": one of ${PLATFORMS.join(", ")} or "" for cross-platform`,
    '- "title": max 60 chars, punchy',
    '- "body": 2-4 sentences of concrete advice referencing their data and the 2026 platform algorithm. Never mention linking accounts for performance data.',
  ].join("\n");

  const resp = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1400,
    system,
    messages: [{ role: "user", content: userMsg }],
  });

  const text = resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const tips = parseJsonArray(text);
  return tips
    .filter((t) => t && typeof t.title === "string" && typeof t.body === "string")
    .slice(0, 3)
    .map((t) => ({
      platform: PLATFORMS.includes(t.platform) ? t.platform : "",
      title: t.title.slice(0, 120),
      body: t.body.slice(0, 1200),
    }));
}

function parseJsonArray(text) {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start !== -1 && end !== -1 && end > start) {
      try {
        const v = JSON.parse(text.slice(start, end + 1));
        return Array.isArray(v) ? v : [];
      } catch {
        /* fall through */
      }
    }
    throw new Error("Claude did not return a valid JSON array. Raw: " + text.slice(0, 300));
  }
}

export async function chat({ message, profile }) {
  const resp = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: buildSystemPrompt(profile),
    messages: [{ role: "user", content: message }],
  });
  return resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw new Error("Claude did not return valid JSON. Raw: " + text.slice(0, 300));
  }
}

export { PLATFORMS };
