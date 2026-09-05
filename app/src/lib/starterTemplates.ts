import type { BrandTraits, Platform, Profile } from "./types";
import { PLATFORM_LABELS, PLATFORMS } from "./types";
import { normalizeEnabledPlatforms } from "./enabledPlatforms";
import smb from "../data/starter-templates/smb-owner-operator.json";
import network from "../data/starter-templates/network-marketer.json";
import creator from "../data/starter-templates/solo-creator.json";

type RawTemplate = {
  id: string;
  name: string;
  category: string;
  pitch: string;
  default_plan?: string;
  profile: {
    goals: string;
    projects: string;
    brand_voice: string;
    traits: {
      content_style?: string | string[];
      content_types?: string[];
      target_audience?: string;
      vibe?: string;
      emoji_usage?: string;
      cta_preference?: string;
      preferred_language?: string;
      text_provider?: string;
    };
  };
  capture_defaults: {
    apps: string[];
    never_use: string[];
    always_prefer: string[];
  };
};

export type StarterTemplate = RawTemplate;

export const STARTER_TEMPLATES: StarterTemplate[] = [smb, network, creator] as StarterTemplate[];

const STYLE_MAP: Array<[RegExp, string]> = [
  [/story/i, "Storytelling"],
  [/behind/i, "Behind-the-scenes"],
  [/entertain/i, "Entertaining"],
  [/educat|tip/i, "Educational"],
  [/inspir/i, "Inspirational"],
  [/contrar/i, "Contrarian"],
];

const TYPE_MAP: Record<string, string> = {
  Story: "Short video",
  Invite: "Threads",
  Product: "Photo posts",
  Promo: "Photo posts",
  Tip: "Short video",
  Update: "Photo posts",
  "Clip promo": "Short video",
};

const VIBE_MAP: Array<[RegExp, string]> = [
  [/fun|play|hype|energ/i, "Funny & playful"],
  [/premium|polish/i, "Premium & polished"],
  [/raw|unfilter/i, "Raw & unfiltered"],
  [/calm|authentic|trust|friendly|approach|practical/i, "Calm & authentic"],
];

function mapStyle(raw?: string | string[]): string | undefined {
  const parts = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const blob = parts.join(" ");
  for (const [re, value] of STYLE_MAP) {
    if (re.test(blob)) return value;
  }
  return parts[0];
}

function mapTypes(raw?: string[]): string[] {
  const out: string[] = [];
  for (const item of raw || []) {
    const mapped = TYPE_MAP[item] || item;
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

function mapVibe(raw?: string): string | undefined {
  if (!raw) return undefined;
  for (const [re, value] of VIBE_MAP) {
    if (re.test(raw)) return value;
  }
  return raw;
}

function mapEmoji(raw?: string): string | undefined {
  const v = (raw || "").toLowerCase();
  if (!v) return undefined;
  if (v.includes("none")) return "None";
  if (v.includes("light")) return "Light (1-2 per post)";
  if (v.includes("moderat") || v.includes("express")) return "Expressive";
  return raw;
}

function mapCta(raw?: string): string | undefined {
  const v = (raw || "").toLowerCase();
  if (!v) return undefined;
  if (/soft|stop by|book/.test(v)) return "Soft / none";
  if (/question|dm|call|conversation/.test(v)) return "Ask a question";
  if (/follow|watch/.test(v)) return "Follow for more";
  if (/link/.test(v)) return "Link in bio";
  return raw;
}

function mapApps(apps: string[]): Platform[] {
  const allowed = new Set<string>(PLATFORMS);
  const mapped = apps.map((a) => {
    const key = String(a || "").toLowerCase().trim();
    if (key === "youtube_shorts" || key === "youtube-shorts") return "youtube";
    return key;
  });
  return normalizeEnabledPlatforms(mapped.filter((p) => allowed.has(p)));
}

export function getStarterTemplate(id: string): StarterTemplate | undefined {
  return STARTER_TEMPLATES.find((t) => t.id === id);
}

export function starterAppLabels(tpl: StarterTemplate): string[] {
  return mapApps(tpl.capture_defaults.apps || []).map((p) => PLATFORM_LABELS[p]);
}

/** Apply fills Brand Brain + apps + never/always. Never touch billing or `default_plan`. */
export function profileFromStarter(tpl: StarterTemplate): Profile {
  const t = tpl.profile.traits || {};
  const traits: BrandTraits = {
    content_style: mapStyle(t.content_style),
    content_types: mapTypes(t.content_types),
    target_audience: t.target_audience || "",
    vibe: mapVibe(t.vibe),
    emoji_usage: mapEmoji(t.emoji_usage),
    cta_preference: mapCta(t.cta_preference),
    preferred_language: t.preferred_language || "en",
    text_provider: t.text_provider === "claude" ? "claude" : "grok",
    never_use: [...(tpl.capture_defaults.never_use || [])],
    always_use: [...(tpl.capture_defaults.always_prefer || [])],
    enabled_platforms: mapApps(tpl.capture_defaults.apps || []),
  };
  return {
    goals: tpl.profile.goals,
    projects: tpl.profile.projects,
    brand_voice: tpl.profile.brand_voice,
    traits,
  };
}

export function brandLooksEmpty(profile?: {
  goals?: string;
  projects?: string;
  brand_voice?: string;
} | null): boolean {
  return !String(profile?.goals || "").trim() && !String(profile?.brand_voice || "").trim() && !String(profile?.projects || "").trim();
}
