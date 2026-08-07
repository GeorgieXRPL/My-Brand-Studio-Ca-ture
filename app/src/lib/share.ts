import type { Platform } from "./types";
import { extractShareCaption, FILM_PLATFORMS } from "./filmHelper";

export async function shareText(text: string): Promise<"shared" | "copied"> {
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return "shared";
    } catch (err: any) {
      // User cancelled the share sheet - treat as no-op, don't fall through to copy.
      if (err?.name === "AbortError") return "shared";
    }
  }
  await copyText(text);
  return "copied";
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

/**
 * Platforms whose native share targets usually accept the PHOTO/VIDEO but
 * drop the caption. We always copy the caption first, then hand over media.
 * (X/Web Share often does the same when files are present — not an API quota issue.)
 */
const CAPTION_PASTE_PLATFORMS: Platform[] = [
  "instagram",
  "tiktok",
  "snapchat",
  "facebook",
  "x",
  "linkedin",
];

export type ShareResult =
  | "shared"
  | "shared-caption-ready"
  | "shared-text-only"
  | "copied";

async function fetchMediaFile(mediaUrl: string): Promise<File | null> {
  try {
    const res = await fetch(mediaUrl);
    if (!res.ok) return null;
    const blob = await res.blob();
    const mime = blob.type || "image/jpeg";
    return new File([blob], `brand-studio.${EXT[mime] || "bin"}`, { type: mime });
  } catch {
    return null;
  }
}

async function tryShareFiles(file: File, text: string): Promise<boolean> {
  if (!navigator.share) return false;
  const payloads: ShareData[] = [
    { files: [file], text, title: text.slice(0, 80) },
    { files: [file], text },
    { files: [file] },
  ];
  for (const payload of payloads) {
    try {
      if (navigator.canShare && !navigator.canShare(payload)) continue;
      await navigator.share(payload);
      return true;
    } catch (err: any) {
      if (err?.name === "AbortError") return true;
    }
  }
  return false;
}

/**
 * Share for a specific platform. With media we use a caption-first flow so
 * Instagram / TikTok / Snapchat / X don't leave the user without their text:
 * 1) copy caption to clipboard  2) open share sheet with the file  3) user pastes.
 */
export async function shareForPlatform(
  platform: Platform,
  text: string,
  mediaUrl?: string | null
): Promise<ShareResult> {
  // Video platforms: share the post caption, never the full HOOK/BEAT script.
  const caption = FILM_PLATFORMS.includes(platform)
    ? extractShareCaption(text, platform)
    : (text || "").trim();
  const wantsCaptionPaste = CAPTION_PASTE_PLATFORMS.includes(platform);

  if (mediaUrl && typeof navigator.share === "function") {
    const file = await fetchMediaFile(mediaUrl);
    if (file) {
      if (caption && wantsCaptionPaste) {
        await copyText(caption);
        await tryShareFiles(file, caption);
        // Caption is on the clipboard either way — paste after picking the app.
        return "shared-caption-ready";
      }
      const ok = await tryShareFiles(file, caption);
      if (ok) return "shared";
    }
    // Media couldn't attach — fall through to text.
    const result = await shareText(caption);
    return result === "shared" ? "shared-text-only" : "copied";
  }

  if (!mediaUrl) {
    return shareText(caption);
  }

  // No Web Share API: copy caption so they can paste after picking the photo manually.
  if (caption) await copyText(caption);
  return "copied";
}

/** @deprecated prefer shareForPlatform — kept for generic callers */
export async function shareContent(
  text: string,
  mediaUrl?: string | null
): Promise<ShareResult> {
  return shareForPlatform("instagram", text, mediaUrl);
}

export function shareToastMessage(result: ShareResult, platformLabel?: string): string {
  const where = platformLabel || "the app";
  switch (result) {
    case "shared-caption-ready":
      return `Caption copied — paste it in ${where} after you pick the photo`;
    case "shared-text-only":
      return "Sharing text — attach the media in the app";
    case "copied":
      return `Caption copied — open ${where} and paste it`;
    default:
      return "Opening share sheet…";
  }
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const el = document.createElement("textarea");
  el.value = text;
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.select();
  document.execCommand("copy");
  document.body.removeChild(el);
}
