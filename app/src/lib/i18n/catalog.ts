/**
 * Phrase-based i18n: pass English UI copy to t("..."); locale packs map English → translation.
 * Legacy keys like "nav.capture" still resolve via LEGACY_KEYS.
 */

export const LEGACY_KEYS: Record<string, string> = {
  "nav.capture": "Capture",
  "nav.drafts": "Drafts",
  "nav.schedule": "Schedule",
  "nav.insights": "Insights",
  "nav.setup": "Setup",
  "capture.title": "Capture",
  "capture.sub": "talk it out",
  "capture.placeholder": "Say what you mean — or type it if that's easier.",
  "capture.draftNow": "Draft now",
  "capture.saveIdea": "Save idea",
  "capture.writing": "Shaping your words for each platform…",
  "capture.welcomeTitle": "You know what you mean. Say it out loud.",
  "capture.welcomeBody":
    "Talk instead of staring at a blank caption. We write a post for each app — then Share opens your phone's share sheet so you pick Instagram, TikTok, and the rest.",
  "capture.welcomeCta": "Create your free account",
  "capture.listening": "Listening… tap to stop",
  "capture.tapMic": "Tap the mic and talk",
  "capture.streak": "{n}-day streak",
  "drafts.title": "Drafts",
  "drafts.saved": "{n} saved",
  "drafts.signIn": "Sign in on Setup to see your drafts — then edit and Share.",
  "drafts.empty": "No drafts yet. Speak an idea on Capture and tap Draft now.",
  "drafts.share": "Share",
  "drafts.copy": "Copy",
  "drafts.edit": "Edit",
  "drafts.post": "Post",
  "schedule.title": "Schedule",
  "schedule.eyebrow": "Daily plan + Share reminders",
  "schedule.daily": "Daily",
  "schedule.content": "Content",
  "schedule.add": "Add",
  "schedule.queue": "Remind",
  "schedule.signIn": "Sign in on the Setup tab to manage your schedule.",
  "insights.title": "Insights",
  "insights.eyebrow": "Content gaps & algo plays",
  "insights.growthTitle": "Your weekly growth analysis",
  "setup.title": "Setup",
  "setup.appLanguage": "App language",
  "setup.appLanguageHint":
    "Changes the app interface and new drafts. Speak or type in any language — posts are written in your pick.",
  "setup.saveBrand": "Save brand",
  "setup.saved": "Saved — app & new drafts use this",
  "setup.signIn": "Sign in",
  "setup.createAccount": "Create account",
  "setup.yourBrand": "Your brand",
  "setup.goals": "Goals",
  "setup.projects": "Projects",
  "setup.voice": "Voice",
  "setup.neverUse": "Never use",
  "setup.neverUseHint": "Short list. Words or phrases drafts should skip.",
  "setup.alwaysUse": "Always prefer",
  "setup.alwaysUseHint": "Short list. Phrases that sound like you.",
  "setup.examplePosts": "Example posts",
  "setup.examplePostsHint": "Optional. Up to 3 posts you already like. We match the energy, not the wording.",
  "setup.examplePostN": "Example {n}",
  "setup.textAi": "Text AI",
  "setup.textAiHint": "Who writes your captions. Grok is the default. Claude is used if Grok is down.",
  "setup.textAiGrok": "Grok",
  "setup.textAiClaude": "Claude",
  "setup.unsaved": "You have unsaved brand changes.",
  "setup.discard": "Discard",
  "common.share": "Share",
  "common.copy": "Copy",
  "common.edit": "Edit",
  "common.cancel": "Cancel",
  "common.save": "Save",
};

const RTL = new Set(["ar"]);

export function isRtl(code: string): boolean {
  return RTL.has(code);
}

function applyVars(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  let out = text;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
  }
  return out;
}

export type Dict = Record<string, string>;

export function resolveEnglish(phraseOrKey: string): string {
  return LEGACY_KEYS[phraseOrKey] ?? phraseOrKey;
}

export function translate(locale: string, phraseOrKey: string, vars?: Record<string, string | number>, dicts?: Record<string, Dict>): string {
  const english = resolveEnglish(phraseOrKey);
  let text = english;
  if (locale && locale !== "en" && dicts?.[locale]) {
    const hit = dicts[locale][english] || dicts[locale][phraseOrKey];
    if (hit) text = hit;
  }
  return applyVars(text, vars);
}
