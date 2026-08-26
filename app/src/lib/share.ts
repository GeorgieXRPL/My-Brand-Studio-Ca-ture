import type { Platform } from "./types";
import { extractShareCaption, FILM_PLATFORMS } from "./filmHelper";
import { withBrandTag } from "./attribution";

export type ShareOptions = {
  /** Account tier — free posts get @MyBStudio attribution. */
  tier?: string | null;
};

export async function shareText(text: string): Promise<"shared" | "copied"> {
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ text });
      return "shared";
    } catch (err: any) {
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
 * drop the caption. We copy the caption while the sheet is open, then the
 * user pastes in the target app.
 */
const CAPTION_PASTE_PLATFORMS: Platform[] = [
  "instagram",
  "tiktok",
  "snapchat",
  "facebook",
  "x",
  "linkedin",
  "grok",
  "youtube",
  "reddit",
  "threads",
  "pinterest",
  "nextdoor",
];

/** Attach text+files last — TikTok often disappears from Android sheets when text is set. */
const FILES_FIRST_PLATFORMS: Platform[] = ["tiktok", "instagram", "snapchat", "youtube"];

export type ShareResult =
  | "shared"
  | "shared-caption-ready"
  | "shared-text-only"
  | "copied"
  | "media-not-ready";

/** In-flight fetches + settled Files so Share can run without network on tap. */
const mediaInflight = new Map<string, Promise<File | null>>();
const mediaReady = new Map<string, File | null>();

function sniffMediaMime(bytes: ArrayBuffer, hinted?: string | null): string {
  if (hinted && EXT[hinted]) return hinted;
  const u8 = new Uint8Array(bytes.slice(0, 12));
  if (u8.length >= 8 && u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) {
    return "video/mp4";
  }
  if (u8.length >= 4 && u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) {
    return "video/webm";
  }
  if (u8.length >= 3 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return "image/jpeg";
  if (u8.length >= 4 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
    return "image/png";
  }
  if (u8.length >= 6 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return "image/gif";
  if (
    u8.length >= 12 &&
    u8[0] === 0x52 &&
    u8[1] === 0x49 &&
    u8[2] === 0x46 &&
    u8[3] === 0x46 &&
    u8[8] === 0x57 &&
    u8[9] === 0x45 &&
    u8[10] === 0x42 &&
    u8[11] === 0x50
  ) {
    return "image/webp";
  }
  return hinted || "application/octet-stream";
}

async function fetchMediaFile(mediaUrl: string): Promise<File | null> {
  try {
    const res = await fetch(mediaUrl);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const headerType = (res.headers.get("content-type") || "").split(";")[0].trim();
    const mime = sniffMediaMime(buf, headerType);
    const ext = EXT[mime] || (mime.startsWith("video/") ? "mp4" : "bin");
    const base = mime.startsWith("video/") ? "clip" : "photo";
    return new File([buf], `${base}.${ext}`, { type: mime });
  } catch {
    return null;
  }
}

/** Warm the file cache before the user taps Share (required on iOS). */
export function prefetchShareMedia(mediaUrl?: string | null): Promise<File | null> {
  if (!mediaUrl) return Promise.resolve(null);
  if (mediaReady.has(mediaUrl)) return Promise.resolve(mediaReady.get(mediaUrl) ?? null);
  let pending = mediaInflight.get(mediaUrl);
  if (!pending) {
    pending = fetchMediaFile(mediaUrl).then((file) => {
      mediaReady.set(mediaUrl, file);
      mediaInflight.delete(mediaUrl);
      return file;
    });
    mediaInflight.set(mediaUrl, pending);
  }
  return pending;
}

/** Clear cache so a regenerated clip is re-fetched. */
export function clearPrefetchedShareMedia(mediaUrl?: string | null) {
  if (!mediaUrl) {
    mediaReady.clear();
    mediaInflight.clear();
    return;
  }
  mediaReady.delete(mediaUrl);
  mediaInflight.delete(mediaUrl);
}

/** Sync peek — File only if prefetch already finished. */
export function getPrefetchedShareMedia(mediaUrl?: string | null): File | null {
  if (!mediaUrl) return null;
  return mediaReady.get(mediaUrl) ?? null;
}

async function tryShareFiles(file: File, text: string, filesFirst: boolean): Promise<boolean> {
  if (typeof navigator.share !== "function") return false;
  const withText: ShareData[] = [
    { files: [file], text, title: text.slice(0, 80) },
    { files: [file], text },
  ];
  const filesOnly: ShareData = { files: [file] };
  const payloads: ShareData[] = filesFirst
    ? [filesOnly, ...withText]
    : [...withText, filesOnly];
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

/** Trigger a same-tab download of a prefetched File (TikTok upload fallback). */
export function downloadShareFile(file: File) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name || "clip.mp4";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Share for a specific platform. With media:
 * 1) open share sheet with the file (must stay in the tap gesture on iOS)
 * 2) copy caption while the sheet is up
 * 3) user pastes in the target app
 */
export async function shareForPlatform(
  platform: Platform,
  text: string,
  mediaUrl?: string | null,
  prefetchedFile?: File | null,
  options?: ShareOptions
): Promise<ShareResult> {
  const rawCaption = FILM_PLATFORMS.includes(platform)
    ? extractShareCaption(text, platform)
    : (text || "").trim();
  const caption = withBrandTag(rawCaption, options?.tier);
  const wantsCaptionPaste = CAPTION_PASTE_PLATFORMS.includes(platform);
  const filesFirst = FILES_FIRST_PLATFORMS.includes(platform);

  if (mediaUrl && typeof navigator.share === "function") {
    const file = prefetchedFile ?? getPrefetchedShareMedia(mediaUrl);
    if (!file) {
      void prefetchShareMedia(mediaUrl);
      return "media-not-ready";
    }

    if (caption && wantsCaptionPaste) {
      const sharePromise = tryShareFiles(file, caption, filesFirst);
      try {
        await copyText(caption);
      } catch {
        /* sheet still matters more than clipboard */
      }
      const ok = await sharePromise;
      if (ok) return "shared-caption-ready";
      return "copied";
    }
    const ok = await tryShareFiles(file, caption, filesFirst);
    if (ok) return "shared";
    return "copied";
  }

  if (!mediaUrl) {
    return shareText(caption);
  }

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
      return `Caption copied — paste it in ${where} after you pick the video or photo`;
    case "shared-text-only":
      return "Sharing text — attach the video in the app if it didn't attach";
    case "media-not-ready":
      return "Video still preparing — wait a moment, then open the share sheet again";
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
