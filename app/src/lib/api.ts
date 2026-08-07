import type {
  AgentStats,
  ApiKey,
  Connections,
  Draft,
  GrowthStatus,
  Idea,
  ImagineJob,
  Insight,
  Me,
  Post,
  Profile,
  ScheduleBlock,
  ScheduledPost,
  Variants,
  Workout,
} from "./types";

const URL_KEY = "hubUrl";
const TOKEN_KEY = "hubToken";
const AUTH_TOKEN_KEY = "authToken";
const AUTH_EMAIL_KEY = "authEmail";

// The hosted hub baked in at build time. A custom self-hosted hub
// (URL + shared token in localStorage) overrides it.
const HOSTED_HUB = (import.meta.env.VITE_HUB_URL || "").replace(/\/$/, "");

export function isSelfHost(): boolean {
  return Boolean(localStorage.getItem(URL_KEY));
}
export function getHubUrl(): string {
  return localStorage.getItem(URL_KEY) || HOSTED_HUB;
}
export function getHubToken(): string {
  return localStorage.getItem(TOKEN_KEY) || "";
}
export function setHubConfig(url: string, token: string) {
  localStorage.setItem(URL_KEY, url.replace(/\/$/, ""));
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearHubConfig() {
  localStorage.removeItem(URL_KEY);
  localStorage.removeItem(TOKEN_KEY);
}

export function getAuthEmail(): string {
  return localStorage.getItem(AUTH_EMAIL_KEY) || "";
}
export function setAuth(token: string, email: string) {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
  localStorage.setItem(AUTH_EMAIL_KEY, email);
}
export function clearAuth() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_EMAIL_KEY);
}

function getActiveToken(): string {
  if (isSelfHost()) return getHubToken();
  return localStorage.getItem(AUTH_TOKEN_KEY) || "";
}

export function isConfigured(): boolean {
  return Boolean(getHubUrl() && getActiveToken());
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const base = getHubUrl();
  if (!base) throw new Error("Hub not configured. Open Setup to connect.");
  const res = await fetch(base + path, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getActiveToken()}`,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  health: () => request<{ ok: boolean }>("/api/health"),

  signup: (email: string, password: string, ref?: string) =>
    request<{ token: string; email: string }>("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password, ref: ref || undefined }),
    }),
  login: (email: string, password: string) =>
    request<{ token: string; email: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  me: () => request<Me>("/api/auth/me"),
  authProviders: () => request<{ password: boolean; google: boolean }>("/api/auth/providers"),

  getProfile: () => request<Profile>("/api/profile"),
  saveProfile: (p: Profile) => request<Profile>("/api/profile", { method: "PUT", body: JSON.stringify(p) }),

  getIdeas: () => request<Idea[]>("/api/ideas"),
  addIdea: (text: string, mediaUrl?: string) =>
    request<Idea>("/api/ideas", { method: "POST", body: JSON.stringify({ text, media_url: mediaUrl || null }) }),
  updateIdea: (id: number, patch: Partial<Idea>) =>
    request<Idea>(`/api/ideas/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteIdea: (id: number) => request<{ ok: true }>(`/api/ideas/${id}`, { method: "DELETE" }),

  getDrafts: () => request<Draft[]>("/api/drafts"),
  generate: (payload: { topic?: string; idea_id?: number; media_url?: string }) =>
    request<Draft>("/api/generate", { method: "POST", body: JSON.stringify(payload) }),
  updateDraft: (id: number, patch: { status?: string; variants?: Variants; topic?: string; media_url?: string | null }) =>
    request<Draft>(`/api/drafts/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteDraft: (id: number) => request<{ ok: true }>(`/api/drafts/${id}`, { method: "DELETE" }),

  imagineStatus: () =>
    request<{ configured: boolean; used: number; limit: number; tier: string; studio: boolean }>(
      "/api/imagine/status"
    ),
  startImagineVideo: (payload: {
    draft_id: number;
    platform?: string;
    duration?: number;
    prompt?: string;
    image_url?: string;
  }) =>
    request<ImagineJob>("/api/imagine/video", { method: "POST", body: JSON.stringify(payload) }),
  startImagineStill: (payload: { draft_id: number; platform?: string; prompt?: string }) =>
    request<ImagineJob & { draft_media_url?: string }>("/api/imagine/still", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  getImagineJob: (id: number) => request<ImagineJob>(`/api/imagine/jobs/${id}`),
  getImagineJobs: (draftId?: number) =>
    request<ImagineJob[]>(draftId ? `/api/imagine/jobs?draft_id=${draftId}` : "/api/imagine/jobs"),

  getSchedule: () => request<ScheduleBlock[]>("/api/schedule"),
  addBlock: (block: { weekday: number; start_time: string; end_time: string; title: string; category: string }) =>
    request<ScheduleBlock>("/api/schedule", { method: "POST", body: JSON.stringify(block) }),
  toggleBlock: (id: number, done: boolean) =>
    request<ScheduleBlock>(`/api/schedule/${id}`, { method: "PATCH", body: JSON.stringify({ done }) }),
  updateBlock: (id: number, patch: Partial<ScheduleBlock>) =>
    request<ScheduleBlock>(`/api/schedule/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteBlock: (id: number) => request<{ ok: true }>(`/api/schedule/${id}`, { method: "DELETE" }),
  resetSchedule: () => request<{ ok: true }>("/api/schedule/reset", { method: "POST" }),
  clearSchedule: () => request<{ ok: true }>("/api/schedule/clear", { method: "POST" }),

  getWorkouts: () => request<Workout[]>("/api/workouts"),
  addWorkout: (description: string, date?: string) =>
    request<Workout>("/api/workouts", { method: "POST", body: JSON.stringify({ description, date }) }),
  updateWorkout: (id: number, patch: { description?: string; date?: string }) =>
    request<Workout>(`/api/workouts/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteWorkout: (id: number) => request<{ ok: true }>(`/api/workouts/${id}`, { method: "DELETE" }),

  getConnections: () => request<Connections>("/api/connections"),
  startConnectX: () => request<{ url: string }>("/api/connect/x/start", { method: "POST" }),
  connectAccounts: (connectKey: string, handle?: string, platforms?: string[]) =>
    request<{ platforms: string[]; handle: string }>("/api/connect/ayrshare", {
      method: "POST",
      body: JSON.stringify({ profile_key: connectKey, handle, platforms }),
    }),
  /** @deprecated use connectAccounts */
  connectAyrshare: (profileKey: string, handle?: string, platforms?: string[]) =>
    request<{ platforms: string[]; handle: string }>("/api/connect/ayrshare", {
      method: "POST",
      body: JSON.stringify({ profile_key: profileKey, handle, platforms }),
    }),
  disconnect: (platform: string) => request<{ ok: true }>(`/api/connections/${platform}`, { method: "DELETE" }),

  billingPlans: () =>
    request<{
      configured: boolean;
      plans: Record<string, { monthly: number; drafts: number; features: string[] }>;
    }>("/api/billing/plans"),
  billingCheckout: (tier: "creator" | "studio") =>
    request<{ url: string }>("/api/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ tier }),
    }),
  billingPortal: () => request<{ url: string }>("/api/billing/portal", { method: "POST", body: "{}" }),

  publish: (draftId: number, platform: string) =>
    request<Post>("/api/posts", { method: "POST", body: JSON.stringify({ draft_id: draftId, platform }) }),
  getPosts: (draftId?: number) => request<Post[]>(draftId ? `/api/posts?draft_id=${draftId}` : "/api/posts"),

  schedulePost: (draftId: number, platform: string, scheduledAt: string) =>
    request<ScheduledPost>("/api/posts/schedule", {
      method: "POST",
      body: JSON.stringify({ draft_id: draftId, platform, scheduled_at: scheduledAt }),
    }),
  getScheduledPosts: () => request<ScheduledPost[]>("/api/posts/scheduled"),
  cancelScheduledPost: (id: number) => request<{ ok: true }>(`/api/posts/scheduled/${id}`, { method: "DELETE" }),
  retryScheduledPost: (id: number, scheduledAt?: string) =>
    request<ScheduledPost>(`/api/posts/scheduled/${id}/retry`, {
      method: "POST",
      body: JSON.stringify(scheduledAt ? { scheduled_at: scheduledAt } : {}),
    }),

  getInsights: () => request<Insight[]>("/api/insights"),
  getGrowthStatus: () => request<GrowthStatus>("/api/growth/status"),
  refreshInsights: () => request<Insight[]>("/api/insights/refresh", { method: "POST", body: "{}" }),
  updateInsight: (id: number, status: "used" | "dismissed") =>
    request<Insight>(`/api/insights/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),

  agentStats: () => request<AgentStats>("/api/agent/stats"),

  uploadMedia: async (file: File): Promise<{ id: string; url: string; mime: string }> => {
    const res = await fetch(getHubUrl() + "/api/media", {
      method: "POST",
      headers: { "Content-Type": file.type, Authorization: `Bearer ${getActiveToken()}` },
      body: file,
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || `Upload failed (${res.status})`);
    return body;
  },

  getKeys: () => request<ApiKey[]>("/api/keys"),
  createKey: (name: string) =>
    request<{ id: number; name: string; key: string }>("/api/keys", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  deleteKey: (id: number) => request<{ ok: true }>(`/api/keys/${id}`, { method: "DELETE" }),

  exportData: () => request<unknown>("/api/export"),
};
