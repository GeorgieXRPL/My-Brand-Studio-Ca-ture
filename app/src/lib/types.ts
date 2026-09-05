export const PLATFORMS = [
  "x",
  "facebook",
  "tiktok",
  "snapchat",
  "instagram",
  "linkedin",
  "youtube",
  "reddit",
  "threads",
  "pinterest",
  "nextdoor",
] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Destinations we generate by default until the user picks others. */
export const DEFAULT_ENABLED_PLATFORMS: Platform[] = [
  "x",
  "facebook",
  "tiktok",
  "snapchat",
  "instagram",
  "linkedin",
  "youtube",
];

/** Pre-Shorts default. Exact match is upgraded to include YouTube. */
export const LEGACY_DEFAULT_PLATFORMS: Platform[] = [
  "x",
  "facebook",
  "tiktok",
  "snapchat",
  "instagram",
  "linkedin",
];

export const PLATFORM_LABELS: Record<Platform, string> = {
  x: "X",
  facebook: "Facebook",
  tiktok: "TikTok",
  snapchat: "Snapchat",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  youtube: "YouTube Shorts",
  reddit: "Reddit",
  threads: "Threads",
  pinterest: "Pinterest",
  nextdoor: "Nextdoor",
};

export const PLATFORM_COLORS: Record<Platform, string> = {
  x: "#e7e9ea",
  facebook: "#5b8def",
  tiktok: "#22d3ee",
  snapchat: "#fbbf24",
  instagram: "#f472b6",
  linkedin: "#5b9bd5",
  youtube: "#f87171",
  reddit: "#fb923c",
  threads: "#e7e9ea",
  pinterest: "#f43f5e",
  nextdoor: "#34d399",
};

export interface BrandTraits {
  content_style?: string;
  content_types?: string[];
  target_audience?: string;
  vibe?: string;
  emoji_usage?: string;
  cta_preference?: string;
  /** ISO-ish code from OUTPUT_LANGUAGES — drafts are generated in this language. */
  preferred_language?: string;
  /** Caption LLM: claude | grok (default grok). */
  text_provider?: "claude" | "grok";
  /** Short list of words/phrases the model must not use. */
  never_use?: string[];
  /** Short list of words/phrases the model should prefer. */
  always_use?: string[];
  /** Optional 2–3 example posts (capped server-side). */
  example_posts?: string[];
  /** Apps to write captions for. Missing = default set (includes YouTube Shorts). */
  enabled_platforms?: Platform[];
}

export interface Profile {
  goals: string;
  projects: string;
  brand_voice: string;
  traits?: BrandTraits;
  /** Custom logo/mark uploaded via Brand Brain (/media/…). */
  watermark_media_url?: string | null;
}

export type Tier = "free" | "creator" | "studio";

export interface Me {
  email: string;
  kind: string;
  tier: Tier;
  ref_code: string;
  referrals: number;
  drafts_used: number;
  drafts_limit: number;
  stills_used?: number;
  stills_limit?: number;
  videos_used?: number;
  videos_included?: number;
  video_credits?: number;
  videos_remaining?: number;
  billing_configured?: boolean;
  credits_checkout?: boolean;
  has_stripe_customer?: boolean;
  terms_accepted_at?: string | null;
}

export type ImagineStatus = {
  configured: boolean;
  tier: string;
  studio: boolean;
  creator?: boolean;
  used: number;
  limit: number;
  stills: { used: number; limit: number; remaining: number; tier: string };
  videos: {
    used: number;
    included: number;
    included_remaining: number;
    credits: number;
    remaining: number;
    limit: number;
    tier: string;
  };
  voices?: {
    configured: boolean;
    voices: { id: string; label: string; vibe?: string; example?: string }[];
  };
};

export interface Idea {
  id: number;
  text: string;
  status: string;
  media_url: string | null;
  created_at: string;
};

export type Variants = Partial<Record<Platform, string>>;

export interface Draft {
  id: number;
  idea_id: number | null;
  topic: string;
  variants: Variants;
  status: "draft" | "approved" | "posted";
  source: "user" | "agent";
  media_url: string | null;
  original_media_url?: string | null;
  media_mime?: string | null;
  original_media_mime?: string | null;
  thumbnail_url?: string | null;
  created_at: string;
}

export interface ImagineJob {
  id: number;
  draft_id: number;
  kind: "video" | "still" | string;
  status: "pending" | "done" | "failed" | string;
  progress: number;
  prompt: string;
  error: string | null;
  media_url: string | null;
  watermark?: boolean;
  created_at: string;
  updated_at: string;
}

export type ProviderStatus = "available" | "unconfigured" | "coming_soon" | "unsupported";

export interface Connections {
  providers: Record<Platform, ProviderStatus>;
  connected: { platform: Platform; handle: string; created_at: string }[];
}

export interface Post {
  id: number;
  draft_id: number;
  platform: Platform;
  status: string;
  external_id: string | null;
  created_at: string;
}

export interface ApiKey {
  id: number;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

export interface ScheduleBlock {
  id: number;
  weekday: number;
  start_time: string;
  end_time: string;
  title: string;
  category: string;
  done: number;
  created_at?: string;
}

export interface Workout {
  id: number;
  date: string;
  description: string;
  is_content_source: number;
  draft_id: number | null;
  created_at: string;
}

export interface Insight {
  id: number;
  platform: string;
  title: string;
  body: string;
  source: "agent" | "user" | "system";
  status: "new" | "used" | "dismissed";
  created_at: string;
}

export interface ScheduledPost {
  id: number;
  draft_id: number;
  platform: Platform;
  scheduled_at: string;
  status: "scheduled" | "publishing" | "posted" | "failed";
  error: string | null;
  created_at: string;
  draft_topic?: string;
  draft_preview?: string;
  draft_media_url?: string | null;
  draft_status?: string | null;
}

export interface AgentKeyStats extends ApiKey {
  drafts_total: number;
  drafts_draft: number;
  drafts_approved: number;
  drafts_posted: number;
  approval_rate: number | null;
  requests: number;
  insights: number;
}

export interface AgentStats {
  keys: AgentKeyStats[];
  events: { method: string; route: string; created_at: string; key_name: string }[];
}

export interface GrowthStatus {
  metrics_connected: boolean;
  connected_platforms: string[];
  drafts_created_30d: number;
  posts_by_platform: Record<string, number>;
  recent_topics: string[];
  last_tips_at: string | null;
  tips_fresh: boolean;
  next_refresh_at: string | null;
  weekly_worker: string;
}
