export const PLATFORMS = ["x", "facebook", "tiktok", "snapchat", "instagram", "linkedin"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  x: "X",
  facebook: "Facebook",
  tiktok: "TikTok",
  snapchat: "Snapchat",
  instagram: "Instagram",
  linkedin: "LinkedIn",
};

export const PLATFORM_COLORS: Record<Platform, string> = {
  x: "#e7e9ea",
  facebook: "#5b8def",
  tiktok: "#22d3ee",
  snapchat: "#fbbf24",
  instagram: "#f472b6",
  linkedin: "#5b9bd5",
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
}

export interface Profile {
  goals: string;
  projects: string;
  brand_voice: string;
  traits?: BrandTraits;
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
  billing_configured?: boolean;
  has_stripe_customer?: boolean;
}

export interface Idea {
  id: number;
  text: string;
  status: string;
  media_url: string | null;
  created_at: string;
}

export type Variants = Record<Platform, string>;

export interface Draft {
  id: number;
  idea_id: number | null;
  topic: string;
  variants: Variants;
  status: "draft" | "approved" | "posted";
  source: "user" | "agent";
  media_url: string | null;
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
  weekday: number; // 1 = Mon .. 7 = Sun
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
  /** Enriched by GET /api/posts/scheduled */
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
