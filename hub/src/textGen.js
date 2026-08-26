/**
 * Caption / tips / chat text generation — Anthropic Claude or xAI Grok.
 * Preference: profile.traits.text_provider = "claude" | "grok" (default grok).
 */
import Anthropic from "@anthropic-ai/sdk";
import { algoKnowledgeAsOf } from "./algoContext.js";
import { resolveOutputLanguage } from "./languages.js";
import { sanitizeCopy, sanitizeVariants } from "./sanitize.js";
import { voiceGuideBlocks } from "./voiceGuide.js";
import { PLATFORMS, platformGuidanceFor, resolveEnabledPlatforms } from "./platforms.js";

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
const XAI_TEXT_MODEL = process.env.XAI_TEXT_MODEL || "grok-4.3";
const XAI_BASE = (process.env.XAI_BASE_URL || "https://api.x.ai").replace(/\/$/, "");

export { PLATFORMS, resolveEnabledPlatforms } from "./platforms.js";

const TRAIT_LABELS = {
  content_style: "Content style",
  content_types: "Preferred content types",
  target_audience: "Target audience",
  vibe: "Vibe / identity",
  emoji_usage: "Emoji usage",
  cta_preference: "Call-to-action preference",
};

let anthropicClient = null;
function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it to hub/.env");
  }
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropicClient;
}

export function anthropicConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

export function grokTextConfigured() {
  return Boolean(process.env.XAI_API_KEY?.trim());
}

/** @returns {"claude"|"grok"} */
export function resolveTextProvider(preference) {
  const pref = String(preference || "").toLowerCase().trim();
  const want = pref === "claude" ? "claude" : pref === "grok" ? "grok" : "grok";
  if (want === "grok" && grokTextConfigured()) return "grok";
  if (want === "claude" && anthropicConfigured()) return "claude";
  if (grokTextConfigured()) return "grok";
  if (anthropicConfigured()) return "claude";
  throw new Error("No text AI configured. Set XAI_API_KEY or ANTHROPIC_API_KEY.");
}

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

export function buildSystemPrompt(profile) {
  const goals = profile?.goals?.trim() || "(not provided yet)";
  const projects = profile?.projects?.trim() || "(not provided yet)";
  const voice =
    profile?.brand_voice?.trim() ||
    "(not provided yet — match the creator's spoken wording; plain, specific, human — never generic influencer or corporate coach voice)";
  return [
    "You help creators who think better out loud than they write.",
    "Your job is to TRANSLATE their raw spoken idea into platform-native posts that still sound like THEM — not invent a new persona or viral template.",
    "",
    "VOICE FIDELITY (non-negotiable):",
    "- Treat the idea as the source of truth. Clean up clarity and structure; do NOT replace their meaning with trendy hooks or fake motivation.",
    "- Keep their concrete details, slang, opinions, and lived moments. Specificity beats polish.",
    "- If a line could belong to any creator on the internet, rewrite it until it could only be this person.",
    "- No corporate filler, no hashtag spam, no 'Here's the thing…' / 'Let's dive in' / empty hype.",
    "- Never use double hyphens (--). Use commas, periods, or a single spaced hyphen.",
    "- You are a translator of their voice, not a content factory.",
    "",
    "CREATOR GOALS:",
    goals,
    "",
    "CURRENT PROJECTS:",
    projects,
    "",
    "BRAND VOICE / AUDIENCE / RULES:",
    voice + traitLines(profile?.traits) + voiceGuideBlocks(profile?.traits),
    languageBlock(profile),
    "",
    "Always write in that voice. Be specific, human, and useful.",
  ].join("\n");
}

async function completeClaude({ system, userText, image, maxTokens }) {
  const content = image
    ? [
        { type: "image", source: { type: "base64", media_type: image.mime, data: image.data } },
        { type: "text", text: userText },
      ]
    : userText;
  const resp = await getAnthropic().messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content }],
  });
  return resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

async function completeGrok({ system, userText, image, maxTokens }) {
  const key = process.env.XAI_API_KEY?.trim();
  if (!key) throw new Error("XAI_API_KEY is not set.");
  const userContent = image
    ? [
        { type: "image_url", image_url: { url: `data:${image.mime};base64,${image.data}` } },
        { type: "text", text: userText },
      ]
    : userText;
  const res = await fetch(`${XAI_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: XAI_TEXT_MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || data?.error || `Grok text failed (${res.status})`);
  }
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("Grok returned no text content.");
  return text.trim();
}

async function completeText({ provider, system, userText, image, maxTokens }) {
  const ordered =
    provider === "claude"
      ? ["claude", "grok"]
      : provider === "grok"
        ? ["grok", "claude"]
        : ["grok", "claude"];
  let lastErr = null;
  for (const p of ordered) {
    try {
      if (p === "claude" && !anthropicConfigured()) continue;
      if (p === "grok" && !grokTextConfigured()) continue;
      const text =
        p === "claude"
          ? await completeClaude({ system, userText, image, maxTokens })
          : await completeGrok({ system, userText, image, maxTokens });
      return { text, provider: p };
    } catch (e) {
      lastErr = e;
      console.warn(`textGen ${p} failed:`, e.message);
    }
  }
  throw lastErr || new Error("No text AI provider available.");
}

export async function generateVariants({ topic, profile, image, isVideo, provider, platforms }) {
  const targets = resolveEnabledPlatforms(profile?.traits, platforms);
  const system = buildSystemPrompt(profile);
  const mediaNote = image
    ? "\n\nThe creator ATTACHED THE IMAGE ABOVE to this idea. Look at it carefully and weave what's actually in it into every post (describe/reference the visual, don't just caption blindly)."
    : isVideo
      ? "\n\nThe creator attached a VIDEO to this idea (you can't watch it). Write posts that pair with a video: strong hooks, watch-this energy, and captions that lead into it."
      : "";
  const userText = `RAW IDEA (spoken or typed by the creator — preserve their meaning and wording where it works):\n${topic}${mediaNote}\n\n${platformGuidanceFor(targets)}\n\nShape this into platform-ready posts that still feel like a cleanup of what they said — not a rewrite into influencer English.\n\nReturn ONLY a JSON object (no prose, no code fences) with exactly these string keys: ${targets.join(
    ", "
  )}. Each value is the finished post text for that platform. Omit platforms that were not requested.`;

  const resolved = resolveTextProvider(provider ?? profile?.traits?.text_provider);
  const { text } = await completeText({
    provider: resolved,
    system,
    userText,
    image: image || null,
    maxTokens: Math.min(4200, 800 + targets.length * 280),
  });

  const variants = parseJsonObject(text);
  const clean = {};
  for (const p of targets) {
    clean[p] = typeof variants[p] === "string" ? sanitizeCopy(variants[p]) : "";
  }
  return sanitizeVariants(clean);
}

export async function generateGrowthTips({ profile, stats, provider }) {
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

  const userText = [
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

  const resolved = resolveTextProvider(provider ?? profile?.traits?.text_provider);
  const { text } = await completeText({
    provider: resolved,
    system,
    userText,
    maxTokens: 1400,
  });

  const tips = parseJsonArray(text);
  return tips
    .filter((t) => t && typeof t.title === "string" && typeof t.body === "string")
    .slice(0, 3)
    .map((t) => ({
      platform: PLATFORMS.includes(t.platform) ? t.platform : "",
      title: sanitizeCopy(t.title.slice(0, 120)),
      body: sanitizeCopy(t.body.slice(0, 1200)),
    }));
}

export async function chat({ message, profile, provider }) {
  const resolved = resolveTextProvider(provider ?? profile?.traits?.text_provider);
  const { text } = await completeText({
    provider: resolved,
    system: buildSystemPrompt(profile),
    userText: message,
    maxTokens: 1500,
  });
  return text;
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
    throw new Error("Model did not return a valid JSON array. Raw: " + text.slice(0, 300));
  }
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
    throw new Error("Model did not return valid JSON. Raw: " + text.slice(0, 300));
  }
}
