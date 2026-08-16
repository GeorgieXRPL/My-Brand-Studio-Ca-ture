import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, isConfigured } from "../lib/api";
import { copyText, downloadShareFile, getPrefetchedShareMedia, prefetchShareMedia, shareForPlatform, shareToastMessage } from "../lib/share";
import { withBrandTag } from "../lib/attribution";
import { useToast } from "../lib/toast";
import { CheckIcon, ClockIcon, CopyIcon, ImageIcon, PenIcon, SendIcon, ShareIcon, SparkIcon, TrashIcon, VideoIcon } from "../lib/icons";
import Confetti, { takeCelebration } from "../lib/Confetti";
import Spark from "../lib/Spark";
import {
  PLATFORMS,
  PLATFORM_COLORS,
  PLATFORM_LABELS,
  type Connections,
  type Draft,
  type Me,
  type Platform,
} from "../lib/types";
import { tierAtLeast, UNIFIED_POST_PLATFORMS } from "../lib/plans";
import type { ImagineStatus } from "../lib/types";
import {
  buildDefaultImaginePrompt,
  buildFilmGuide,
  FILM_PLATFORMS,
  formatTalkTrackCopy,
  getVoiceStyle,
  mergeFilmEditsIntoScript,
  previewOverlayLines,
  resolveImaginePrompt,
  VOICE_STYLES,
  type FilmEdit,
} from "../lib/filmHelper";
import { useT } from "../lib/i18n";
import { addReminder, ensureNotifyPermission } from "../lib/postReminders";

type MultiShare = {
  draft: Draft;
  queue: Platform[];
  index: number;
  done: Platform[];
};

const STILL_EDIT_PRESETS = [
  { id: "brighten", label: "Brighten" },
  { id: "clean_bg", label: "Clean background" },
  { id: "pop", label: "Make it pop" },
  { id: "natural", label: "More natural" },
] as const;

function timeAgo(iso: string, t: (s: string, vars?: Record<string, string | number>) => string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return t("just now");
  if (mins < 60) return t("{n}m ago", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("{n}h ago", { n: hours });
  const days = Math.floor(hours / 24);
  return days === 1 ? t("yesterday") : t("{n}d ago", { n: days });
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg className={`caret ${open ? "open" : ""}`} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function mediaLooksVideo(url: string, mime?: string | null): boolean {
  if (mime?.startsWith("video/")) return true;
  if (mime?.startsWith("image/")) return false;
  if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(url)) return true;
  if (/\.(jpe?g|png|gif|webp|heic|heif)(\?|$)/i.test(url)) return false;
  // Hub serves extensionless /media/{id} — prefer video when mime unknown and URL matches.
  return /\/media\/[a-f0-9]+\/?$/i.test(url);
}

function DraftMedia({ url, mime }: { url: string; mime?: string | null }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [mode, setMode] = useState<"img" | "video">(() =>
    mediaLooksVideo(url, mime) ? "video" : "img"
  );

  useEffect(() => {
    setMode(mediaLooksVideo(url, mime) ? "video" : "img");
  }, [url, mime]);

  // Mobile browsers block unmuted autoplay and leave the clip stuck on pause.
  // Start muted + inline; native controls let the user turn sound on.
  useEffect(() => {
    if (mode !== "video") return;
    const el = videoRef.current;
    if (!el) return;
    el.defaultMuted = true;
    el.muted = true;
    el.setAttribute("muted", "");
    el.playsInline = true;
    const attempt = el.play();
    if (attempt) void attempt.catch(() => {});
  }, [mode, url]);

  if (mode === "video") {
    return (
      <video
        key={url}
        ref={videoRef}
        className="draft-media draft-media-video"
        src={url}
        controls
        playsInline
        muted
        autoPlay
        preload="auto"
        onError={() => {
          if (!mime?.startsWith("video/")) setMode("img");
        }}
      />
    );
  }
  return (
    <img
      key={url}
      className="draft-media"
      src={url}
      alt=""
      loading="lazy"
      onError={() => {
        if (!mime?.startsWith("image/")) setMode("video");
      }}
    />
  );
}

export default function Drafts() {
  const toast = useToast();
  const t = useT();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const focusId = Number(params.get("focus")) || null;
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<number | null>(focusId);
  const [activePlat, setActivePlat] = useState<Platform>(PLATFORMS[0]);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [connections, setConnections] = useState<Connections | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [postedMap, setPostedMap] = useState<Record<string, boolean>>({});
  const [posting, setPosting] = useState(false);
  const [scheduling, setScheduling] = useState<{ draft: Draft; platform: Platform } | null>(null);
  const [scheduleAt, setScheduleAt] = useState("");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [celebrating, setCelebrating] = useState(() => takeCelebration());
  const [multiShare, setMultiShare] = useState<MultiShare | null>(null);
  const [sharePick, setSharePick] = useState<Platform[]>([]);
  const [shareBusy, setShareBusy] = useState(false);
  /** iOS needs the media File ready before tap — otherwise the share sheet never opens. */
  const [shareMediaReady, setShareMediaReady] = useState(true);
  const [imagineInfo, setImagineInfo] = useState<ImagineStatus | null>(null);
  const [imagineBusy, setImagineBusy] = useState<
    Record<number, { jobId: number; progress: number; kind: string }>
  >({});
  const [photoEdit, setPhotoEdit] = useState<{ draft: Draft; custom: string } | null>(null);
  const [photoEditBusy, setPhotoEditBusy] = useState(false);
  /** Local Film this edits keyed by draftId:platform */
  const [filmEdits, setFilmEdits] = useState<Record<string, FilmEdit>>({});
  const [filmSaving, setFilmSaving] = useState(false);
  const [brandWatermarkUrl, setBrandWatermarkUrl] = useState<string | null>(null);
  /** Keys where the user explicitly turned watermark Off (don't auto-flip back on). */
  const [watermarkOptOut, setWatermarkOptOut] = useState<Record<string, true>>({});
  const [voicePreviewId, setVoicePreviewId] = useState<string | null>(null);
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null);
  const toastAnchorRef = useRef<Element | null>(null);
  const pollTimers = useRef<Record<number, ReturnType<typeof setInterval>>>({});
  const carouselRef = useRef<HTMLDivElement>(null);
  const skipCarouselSync = useRef(false);
  const configured = isConfigured();

  function snapCarouselTo(platform: Platform) {
    const root = carouselRef.current;
    if (!root) return;
    const slide = root.querySelector<HTMLElement>(`[data-platform="${platform}"]`);
    if (!slide) return;
    skipCarouselSync.current = true;
    slide.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    window.setTimeout(() => {
      skipCarouselSync.current = false;
    }, 420);
  }

  function onCarouselScroll(e: React.UIEvent<HTMLDivElement>) {
    if (skipCarouselSync.current) return;
    const root = e.currentTarget;
    const slides = [...root.querySelectorAll<HTMLElement>(".plat-slide")];
    if (!slides.length) return;
    const mid = root.scrollLeft + root.clientWidth / 2;
    let best = slides[0];
    let bestDist = Infinity;
    for (const slide of slides) {
      const center = slide.offsetLeft + slide.offsetWidth / 2;
      const dist = Math.abs(center - mid);
      if (dist < bestDist) {
        bestDist = dist;
        best = slide;
      }
    }
    const next = best.dataset.platform as Platform | undefined;
    if (next && next !== activePlat) setActivePlat(next);
  }

  function draftEl(id: number) {
    return document.getElementById(`draft-${id}`);
  }

  function noteAnchor(id: number) {
    toastAnchorRef.current = draftEl(id);
  }

  function toastAt(msg: string, draftId?: number) {
    const anchor = (draftId != null ? draftEl(draftId) : null) || toastAnchorRef.current || (openId != null ? draftEl(openId) : null);
    toast(msg, { anchor });
  }

  function openDraft(d: Draft) {
    setOpenId(d.id);
    noteAnchor(d.id);
    setActivePlat(PLATFORMS.find((p) => d.variants[p]) || PLATFORMS[0]);
  }

  useEffect(() => {
    if (openId == null) return;
    const timer = window.setTimeout(() => snapCarouselTo(activePlat), 40);
    return () => window.clearTimeout(timer);
    // Only snap when a draft is opened — not on every swipe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  function canDirectPost(platform: Platform): boolean {
    const linked = Boolean(connections?.connected.some((c) => c.platform === platform));
    if (!linked) return false;
    // Unified vendor Post is Studio-only; X (direct OAuth) stays Creator+.
    if ((UNIFIED_POST_PLATFORMS as readonly string[]).includes(platform)) {
      return tierAtLeast(me?.tier, "studio");
    }
    return tierAtLeast(me?.tier, "creator");
  }

  function canSchedulePlatform(_platform: Platform): boolean {
    // Share reminders are available to everyone; auto-post still needs a linked account later.
    return true;
  }

  function platformsForDraft(d: Draft): Platform[] {
    return PLATFORMS.filter((p) => (d.variants[p] || "").trim());
  }

  async function openMultiShare(d: Draft, preferred?: Platform) {
    noteAnchor(d.id);
    let draft = d;
    // Persist Film this caption/prompt edits so Share posts the caption, not the script.
    if (preferred && FILM_PLATFORMS.includes(preferred)) {
      const film = buildFilmGuide(d.variants[preferred] || "", preferred);
      if (film && filmEdits[filmKey(d.id, preferred)]) {
        draft = await saveFilmEdits(d, preferred, film);
      }
    }
    const available = platformsForDraft(draft);
    if (!available.length) {
      toastAt(t("No caption for this platform."), draft.id);
      return;
    }
    const initial = preferred && available.includes(preferred) ? [preferred] : [...available];
    setSharePick(initial);
    setMultiShare({ draft, queue: [], index: 0, done: [] });
    // Prefetch while the picker / step sheet is open so the Share tap can call
    // navigator.share() without awaiting network (iOS user-activation rule).
    if (draft.media_url) {
      if (getPrefetchedShareMedia(draft.media_url)) {
        setShareMediaReady(true);
      } else {
        setShareMediaReady(false);
        void prefetchShareMedia(draft.media_url).then(() => setShareMediaReady(true));
      }
    } else {
      setShareMediaReady(true);
    }
  }

  function toggleSharePick(p: Platform) {
    setSharePick((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
  }

  function beginMultiShare() {
    if (!multiShare || !sharePick.length) return;
    // Keep platform order from PLATFORMS for a predictable walk-through.
    const queue = PLATFORMS.filter((p) => sharePick.includes(p));
    setMultiShare({ ...multiShare, queue, index: 0, done: [] });
  }

  async function runMultiShareStep() {
    if (!multiShare || !multiShare.queue.length) return;
    const platform = multiShare.queue[multiShare.index];
    const text = (multiShare.draft.variants[platform] || "").trim();
    const mediaUrl = multiShare.draft.media_url;
    const file = getPrefetchedShareMedia(mediaUrl);
    setShareBusy(true);
    try {
      const result = await shareForPlatform(platform, text, mediaUrl, file, { tier: me?.tier });
      if (result === "media-not-ready") {
        toastAt(shareToastMessage(result, PLATFORM_LABELS[platform]), multiShare.draft.id);
        void prefetchShareMedia(mediaUrl).then(() => setShareMediaReady(true));
        return;
      }
      toastAt(shareToastMessage(result, PLATFORM_LABELS[platform]), multiShare.draft.id);
      setMultiShare((cur) =>
        cur
          ? {
              ...cur,
              done: cur.done.includes(platform) ? cur.done : [...cur.done, platform],
            }
          : cur
      );
    } finally {
      setShareBusy(false);
    }
  }

  function nextMultiShareStep() {
    if (!multiShare) return;
    if (multiShare.index + 1 >= multiShare.queue.length) {
      setMultiShare(null);
      setSharePick([]);
      toastAt(t("Shared — mark posted when you're done"), multiShare.draft.id);
      return;
    }
    setMultiShare({ ...multiShare, index: multiShare.index + 1 });
  }

  function skipMultiShareStep() {
    nextMultiShareStep();
  }

  async function postNow(d: Draft, platform: Platform) {
    noteAnchor(d.id);
    setPosting(true);
    try {
      await api.publish(d.id, platform);
      setPostedMap((m) => ({ ...m, [`${d.id}:${platform}`]: true }));
      setCelebrating(true);
      toastAt(t("Posted to {platform} — it's live!", { platform: PLATFORM_LABELS[platform] }), d.id);
    } catch (e: any) {
      toastAt(e.message, d.id);
    } finally {
      setPosting(false);
    }
  }

  function openScheduler(d: Draft, platform: Platform) {
    // Default to tomorrow morning, local time.
    const t = new Date(Date.now() + 24 * 3600e3);
    t.setHours(9, 0, 0, 0);
    const pad = (n: number) => String(n).padStart(2, "0");
    setScheduleAt(`${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`);
    setScheduling({ draft: d, platform });
  }

  async function confirmSchedule() {
    if (!scheduling || !scheduleAt) return;
    noteAnchor(scheduling.draft.id);
    setPosting(true);
    try {
      await ensureNotifyPermission();
      const preview = (scheduling.draft.variants[scheduling.platform] || "").trim().slice(0, 140);
      addReminder({
        draftId: scheduling.draft.id,
        platform: scheduling.platform,
        scheduledAt: scheduleAt,
        topic: scheduling.draft.topic || `Draft #${scheduling.draft.id}`,
        preview,
      });
      toastAt(t("Reminder set — we'll nudge you to Share at that time"), scheduling.draft.id);
      setScheduling(null);
      navigate("/schedule?view=content");
    } catch (e: any) {
      toastAt(e.message, scheduling.draft.id);
    } finally {
      setPosting(false);
    }
  }

  useEffect(() => {
    if (configured) load();
    else setLoading(false);
  }, []);

  useEffect(() => {
    if (focusId && drafts.length) {
      document.getElementById(`draft-${focusId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [drafts.length, focusId]);

  async function load() {
    try {
      const rows = await api.getDrafts();
      setDrafts(rows);
      setError("");
      // Auto-expand when there's a single draft or a focused one.
      if (focusId) setOpenId(focusId);
      else if (rows.length === 1) setOpenId(rows[0].id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
    // Best-effort extras; the drafts list works without them.
    try {
      const [conns, posts, account, imagine, profile] = await Promise.all([
        api.getConnections(),
        api.getPosts(),
        api.me(),
        api.imagineStatus().catch(() => null),
        api.getProfile().catch(() => null),
      ]);
      setConnections(conns);
      setMe(account);
      if (imagine) setImagineInfo(imagine);
      setBrandWatermarkUrl(profile?.watermark_media_url || null);
      const map: Record<string, boolean> = {};
      for (const p of posts) map[`${p.draft_id}:${p.platform}`] = true;
      setPostedMap(map);
    } catch {
      /* posting UI simply stays hidden */
    }
  }

  // When Brand Brain logo arrives, unstick film edits that froze watermark:false before load.
  useEffect(() => {
    if (!brandWatermarkUrl) return;
    setFilmEdits((m) => {
      let changed = false;
      const next = { ...m };
      for (const [key, edit] of Object.entries(m)) {
        if (edit.watermark === false && !watermarkOptOut[key]) {
          next[key] = { ...edit, watermark: true };
          changed = true;
        }
      }
      return changed ? next : m;
    });
  }, [brandWatermarkUrl, watermarkOptOut]);

  useEffect(() => {
    return () => {
      for (const t of Object.values(pollTimers.current)) clearInterval(t);
    };
  }, []);

  function stopImaginePoll(draftId: number) {
    if (pollTimers.current[draftId]) {
      clearInterval(pollTimers.current[draftId]);
      delete pollTimers.current[draftId];
    }
  }

  function pollImagineJob(draftId: number, jobId: number) {
    stopImaginePoll(draftId);
    pollTimers.current[draftId] = setInterval(() => {
      void (async () => {
        try {
          const job = await api.getImagineJob(jobId);
          setImagineBusy((m) => ({
            ...m,
            [draftId]: { jobId, progress: job.progress ?? 0, kind: job.kind },
          }));
          if (job.status === "done") {
            stopImaginePoll(draftId);
            setImagineBusy((m) => {
              const next = { ...m };
              delete next[draftId];
              return next;
            });
            toastAt(
              job.error
                ? job.error
                : job.kind === "still"
                  ? t("AI still ready — attached to this draft")
                  : t("AI clip ready — attached to this draft"),
              draftId
            );
            void load();
          } else if (job.status === "failed") {
            stopImaginePoll(draftId);
            setImagineBusy((m) => {
              const next = { ...m };
              delete next[draftId];
              return next;
            });
            toastAt(job.error || t("AI clip failed"), draftId);
          }
        } catch (e: any) {
          stopImaginePoll(draftId);
          setImagineBusy((m) => {
            const next = { ...m };
            delete next[draftId];
            return next;
          });
          toastAt(e.message || t("AI clip failed"), draftId);
        }
      })();
    }, 4000);
  }

  function filmKey(draftId: number, platform: Platform) {
    return `${draftId}:${platform}`;
  }

  function getFilmEdit(d: Draft, platform: Platform, film: NonNullable<ReturnType<typeof buildFilmGuide>>): FilmEdit {
    const key = filmKey(d.id, platform);
    if (filmEdits[key]) return filmEdits[key];
    const imagine =
      film.imagine ||
      buildDefaultImaginePrompt({
        topic: d.topic,
        hook: film.hook,
        beats: film.beats,
        onScreen: film.onScreen,
        keyword: film.keyword,
      });
    return {
      caption: film.caption,
      imagine,
      onScreen: film.onScreen,
      burnIn: true,
      watermark: Boolean(brandWatermarkUrl),
      voiceId: "none",
    };
  }

  function setFilmEditField(draftId: number, platform: Platform, patch: Partial<FilmEdit>, base: FilmEdit) {
    const key = filmKey(draftId, platform);
    if (patch.watermark === false) {
      setWatermarkOptOut((m) => ({ ...m, [key]: true }));
    } else if (patch.watermark === true) {
      setWatermarkOptOut((m) => {
        if (!m[key]) return m;
        const next = { ...m };
        delete next[key];
        return next;
      });
    }
    setFilmEdits((m) => ({ ...m, [key]: { ...base, ...(m[key] || {}), ...patch } }));
  }

  async function saveFilmEdits(d: Draft, platform: Platform, film: NonNullable<ReturnType<typeof buildFilmGuide>>) {
    const edit = getFilmEdit(d, platform, film);
    const raw = d.variants[platform] || "";
    const nextScript = mergeFilmEditsIntoScript(raw, edit, film);
    if (nextScript === raw.trim()) return d;
    setFilmSaving(true);
    try {
      const variants = { ...d.variants, [platform]: nextScript };
      const updated = await api.updateDraft(d.id, { variants });
      setDrafts((rows) => rows.map((r) => (r.id === d.id ? updated : r)));
      toastAt(t("Saved film caption & AI prompt"), d.id);
      return updated;
    } catch (e: any) {
      toastAt(e.message || t("Couldn't save"), d.id);
      return d;
    } finally {
      setFilmSaving(false);
    }
  }

  async function generateAiClip(d: Draft, platform: Platform, film: NonNullable<ReturnType<typeof buildFilmGuide>>) {
    noteAnchor(d.id);
    const canVideo =
      tierAtLeast(me?.tier, "studio") || (imagineInfo?.videos?.credits ?? me?.video_credits ?? 0) > 0;
    if (!canVideo) {
      toastAt(t("AI video is Studio — or buy clip credits on Setup"), d.id);
      return;
    }
    try {
      const edit = getFilmEdit(d, platform, film);
      if (edit.watermark !== false && !brandWatermarkUrl) {
        toastAt(t("Add a watermark in Brand Brain (Setup) before generating with watermark On"), d.id);
      }
      const saved = await saveFilmEdits(d, platform, film);
      const prompt = resolveImaginePrompt(edit, film, d.topic);
      setImagineBusy((m) => ({ ...m, [d.id]: { jobId: 0, progress: 0, kind: "video" } }));
      const job = await api.startImagineVideo({
        draft_id: saved.id,
        platform,
        duration: 6,
        prompt,
        overlay: edit.burnIn,
        overlay_text: edit.burnIn ? edit.onScreen : "",
        watermark: edit.watermark !== false,
        voice_id: edit.voiceId && edit.voiceId !== "none" ? edit.voiceId : undefined,
        narration:
          edit.voiceId && edit.voiceId !== "none"
            ? film.talkTrack.replace(/\n+/g, ". ").replace(/\s+/g, " ").trim().slice(0, 900)
            : undefined,
        resolution: "720p",
      });
      setImagineBusy((m) => ({ ...m, [d.id]: { jobId: job.id, progress: job.progress ?? 0, kind: "video" } }));
      toastAt(t("Generating AI clip… usually under a minute"), d.id);
      pollImagineJob(d.id, job.id);
      void api.imagineStatus().then((s) => setImagineInfo(s));
    } catch (e: any) {
      setImagineBusy((m) => {
        const next = { ...m };
        delete next[d.id];
        return next;
      });
      toastAt(e.message || t("AI clip failed"), d.id);
    }
  }

  function looksLikePhoto(d: Draft | string | null | undefined) {
    if (!d) return false;
    if (typeof d === "string") {
      if (/\.(mp4|webm|mov)(\?|$)/i.test(d)) return false;
      if (/\.(jpe?g|png|gif|webp|heic|heif)(\?|$)/i.test(d)) return true;
      return true;
    }
    if (d.media_mime?.startsWith("video/")) return false;
    if (d.media_mime?.startsWith("image/")) return true;
    const url = d.media_url || "";
    if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) return false;
    if (/\.(jpe?g|png|gif|webp|heic|heif)(\?|$)/i.test(url)) return true;
    // Extensionless /media/{id}: if AI already replaced the capture, don't offer photo edit.
    if (d.original_media_url && d.media_url && d.original_media_url !== d.media_url) return false;
    return true;
  }

  function canRevertMedia(d: Draft) {
    return Boolean(d.original_media_url && d.media_url && d.original_media_url !== d.media_url);
  }

  function revertLabel(d: Draft) {
    if (d.media_mime?.startsWith("video/") || d.original_media_mime?.startsWith("image/")) {
      return t("Revert to original photo");
    }
    return t("Revert to original");
  }

  async function runPhotoEdit(preset?: string) {
    if (!photoEdit) return;
    const d = photoEdit.draft;
    noteAnchor(d.id);
    if (!tierAtLeast(me?.tier, "creator")) {
      toastAt(t("Photo edits unlock on Creator"), d.id);
      return;
    }
    const custom = photoEdit.custom.trim();
    if (!preset && !custom) {
      toastAt(t("Pick a quick fix or describe the change"), d.id);
      return;
    }
    setPhotoEditBusy(true);
    try {
      await api.editImagineStill({
        draft_id: d.id,
        preset: custom ? undefined : preset,
        prompt: custom || undefined,
      });
      toastAt(t("Photo updated — Share when ready"), d.id);
      setPhotoEdit(null);
      void load();
      void api.imagineStatus().then((s) => setImagineInfo(s));
    } catch (e: any) {
      toastAt(e.message || t("Couldn't edit photo"), d.id);
    } finally {
      setPhotoEditBusy(false);
    }
  }

  async function revertDraftMedia(d: Draft) {
    noteAnchor(d.id);
    if (!d.original_media_url || d.original_media_url === d.media_url) return;
    try {
      await api.revertDraftMedia(d.id);
      toastAt(t("Restored original media"), d.id);
      setPhotoEdit(null);
      void load();
    } catch (e: any) {
      toastAt(e.message || t("Couldn't restore original"), d.id);
    }
  }

  function stopVoicePreview() {
    const audio = voiceAudioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      voiceAudioRef.current = null;
    }
    setVoicePreviewId(null);
  }

  async function playVoicePreview(voiceId: string, draftId: number, sampleText?: string) {
    noteAnchor(draftId);
    if (!tierAtLeast(me?.tier, "studio")) {
      toastAt(t("Voice samples unlock on Studio"), draftId);
      return;
    }
    if (voicePreviewId === voiceId) {
      stopVoicePreview();
      return;
    }
    stopVoicePreview();
    setVoicePreviewId(voiceId);
    try {
      const blob = await api.previewVoice(voiceId, sampleText);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      voiceAudioRef.current = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        if (voiceAudioRef.current === audio) voiceAudioRef.current = null;
        setVoicePreviewId(null);
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        stopVoicePreview();
        toastAt(t("Couldn't play voice sample"), draftId);
      };
      await audio.play();
    } catch (e: any) {
      stopVoicePreview();
      toastAt(e.message || t("Couldn't play voice sample"), draftId);
    }
  }

  function voiceStylesForUi() {
    const fromHub = imagineInfo?.voices?.voices;
    if (fromHub?.length) {
      return fromHub.map((v) => {
        const local = getVoiceStyle(v.id);
        return {
          id: v.id,
          label: v.label?.split(" (")[0] || v.id,
          vibe: v.vibe || local?.vibe || "",
          example: v.example || local?.example || "",
        };
      });
    }
    return VOICE_STYLES;
  }

  async function generateAiStill(d: Draft, platform: Platform, film: NonNullable<ReturnType<typeof buildFilmGuide>>) {
    noteAnchor(d.id);
    if (!tierAtLeast(me?.tier, "creator")) {
      toastAt(t("AI stills unlock on Creator"), d.id);
      return;
    }
    try {
      const edit = getFilmEdit(d, platform, film);
      await saveFilmEdits(d, platform, film);
      const prompt = resolveImaginePrompt(edit, film, d.topic);
      setImagineBusy((m) => ({ ...m, [d.id]: { jobId: 0, progress: 0, kind: "still" } }));
      await api.startImagineStill({
        draft_id: d.id,
        platform,
        prompt,
        overlay: edit.burnIn,
        overlay_text: edit.burnIn ? edit.onScreen : "",
        watermark: edit.watermark !== false,
      });
      setImagineBusy((m) => {
        const next = { ...m };
        delete next[d.id];
        return next;
      });
      toastAt(t("AI still ready — attached to this draft"), d.id);
      void load();
      void api.imagineStatus().then((s) => setImagineInfo(s));
    } catch (e: any) {
      setImagineBusy((m) => {
        const next = { ...m };
        delete next[d.id];
        return next;
      });
      toastAt(e.message || t("AI still failed"), d.id);
    }
  }

  async function copy(text: string, draftId: number) {
    noteAnchor(draftId);
    await copyText(withBrandTag(text, me?.tier));
    toastAt(t("Copied"), draftId);
  }
  async function setStatus(d: Draft, status: string) {
    noteAnchor(d.id);
    await api.updateDraft(d.id, { status });
    toastAt(status === "posted" ? t("Marked as posted") : t("Reopened"), d.id);
    load();
  }
  function startEdit(d: Draft, platform: Platform) {
    noteAnchor(d.id);
    setEditingKey(`${d.id}:${platform}`);
    setEditText(d.variants[platform] || "");
  }
  async function saveEdit(d: Draft, platform: Platform) {
    noteAnchor(d.id);
    setSavingEdit(true);
    try {
      const variants = { ...d.variants, [platform]: editText };
      await api.updateDraft(d.id, { variants });
      setDrafts((rows) => rows.map((r) => (r.id === d.id ? { ...r, variants } : r)));
      setEditingKey(null);
      toastAt(t("Saved your edit"), d.id);
    } catch (e: any) {
      toastAt(e.message, d.id);
    } finally {
      setSavingEdit(false);
    }
  }
  async function remove(id: number) {
    noteAnchor(id);
    if (confirmDelete !== id) {
      setConfirmDelete(id);
      window.setTimeout(() => setConfirmDelete((v) => (v === id ? null : v)), 3000);
      return;
    }
    setConfirmDelete(null);
    await api.deleteDraft(id);
    toastAt(t("Draft deleted"), id);
    load();
  }

  return (
    <div className="screen">
      {celebrating && <Confetti onDone={() => setCelebrating(false)} />}
      {photoEdit && (
        <div className="sheet-overlay" onClick={() => !photoEditBusy && setPhotoEdit(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{t("Edit photo")}</div>
            <p className="card-desc" style={{ marginTop: 0 }}>
              {t("Quick fixes keep your shot — no designer speak needed. Uses one still from your monthly allowance.")}
            </p>
            {photoEdit.draft.media_url && (
              <img className="draft-media" src={photoEdit.draft.media_url} alt="" style={{ marginBottom: 12 }} />
            )}
            <div className="chip-row">
              {STILL_EDIT_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="chip-btn"
                  disabled={photoEditBusy}
                  onClick={() => void runPhotoEdit(p.id)}
                >
                  {t(p.label)}
                </button>
              ))}
            </div>
            <label style={{ marginTop: 12 }}>{t("Or describe the change")}</label>
            <textarea
              rows={3}
              placeholder={t("e.g. warmer light, softer background blur")}
              value={photoEdit.custom}
              onChange={(e) => setPhotoEdit({ ...photoEdit, custom: e.target.value })}
              disabled={photoEditBusy}
            />
            <button
              type="button"
              className="btn primary block"
              style={{ marginTop: 12 }}
              disabled={photoEditBusy || !photoEdit.custom.trim()}
              onClick={() => void runPhotoEdit()}
            >
              <ImageIcon size={16} />
              {photoEditBusy ? t("Editing…") : t("Apply edit")}
            </button>
            {photoEdit.draft.original_media_url &&
              photoEdit.draft.media_url !== photoEdit.draft.original_media_url && (
                <button
                  type="button"
                  className="btn outline block"
                  style={{ marginTop: 8 }}
                  disabled={photoEditBusy}
                  onClick={() => void revertDraftMedia(photoEdit.draft)}
                >
                  {t("Revert to original")}
                </button>
              )}
            <button
              type="button"
              className="btn ghost block"
              style={{ marginTop: 8 }}
              disabled={photoEditBusy}
              onClick={() => setPhotoEdit(null)}
            >
              {t("Cancel")}
            </button>
          </div>
        </div>
      )}
      {scheduling && (
        <div className="sheet-overlay" onClick={() => setScheduling(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{t("Remind me to Share on {platform}", { platform: PLATFORM_LABELS[scheduling.platform] })}</div>
            <p className="card-desc" style={{ marginTop: 0 }}>
              {t("We'll pop up when it's time — auto-post lands after account linking.")}
            </p>
            <label>{t("Post at")}</label>
            <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
            <button className="btn primary block" style={{ marginTop: 14 }} onClick={confirmSchedule} disabled={posting}>
              <ClockIcon size={16} />
              {posting ? t("Saving…") : t("Set reminder")}
            </button>
          </div>
        </div>
      )}

      {multiShare && (
        <div
          className="sheet-overlay"
          onClick={() => {
            if (!shareBusy) {
              setMultiShare(null);
              setSharePick([]);
            }
          }}
        >
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            {!multiShare.queue.length ? (
              <>
                <div className="sheet-title">{t("Share everywhere")}</div>
                <ol className="share-steps">
                  <li>{t("Pick the apps below.")}</li>
                  <li>
                    {t("We'll open your phone's share sheet — tap Instagram, TikTok, or whatever you picked.")}
                  </li>
                  <li>
                    {t("Paste the caption if the app didn't keep it. We copy it for you.")}
                  </li>
                </ol>
                <div className="chip-row" style={{ marginBottom: 14 }}>
                  {platformsForDraft(multiShare.draft).map((p) => (
                    <button
                      key={p}
                      type="button"
                      className={`chip-btn ${sharePick.includes(p) ? "on" : ""}`}
                      onClick={() => toggleSharePick(p)}
                      style={{ borderColor: sharePick.includes(p) ? PLATFORM_COLORS[p] : undefined }}
                    >
                      {PLATFORM_LABELS[p]}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="btn primary block"
                  disabled={!sharePick.length}
                  onClick={beginMultiShare}
                >
                  <ShareIcon size={16} />
                  {t("Start sharing")}
                  {sharePick.length ? ` · ${sharePick.length}` : ""}
                </button>
                <button
                  type="button"
                  className="btn ghost block"
                  style={{ marginTop: 8 }}
                  onClick={() => {
                    setMultiShare(null);
                    setSharePick([]);
                  }}
                >
                  {t("Cancel")}
                </button>
              </>
            ) : (
              <>
                {(() => {
                  const plat = multiShare.queue[multiShare.index];
                  const label = PLATFORM_LABELS[plat];
                  const color = PLATFORM_COLORS[plat];
                  const initial = label.replace(/[^A-Za-z0-9]/g, "").slice(0, 1).toUpperCase() || "?";
                  return (
                    <>
                      <div className="multi-share-step-label">
                        {t("Step {n} of {total}", {
                          n: multiShare.index + 1,
                          total: multiShare.queue.length,
                        })}
                      </div>
                      <div className="multi-share-hero" style={{ ["--plat-color" as string]: color }}>
                        <span className="multi-share-badge" aria-hidden="true">
                          {initial}
                        </span>
                        <div className="multi-share-hero-copy">
                          <div className="multi-share-plat">{label}</div>
                          <p className="multi-share-find">
                            {t("In the share list, tap")} <b>{label}</b>
                          </p>
                        </div>
                      </div>
                      <ol className="share-steps">
                        <li>
                          {t("Tap")} <b>{t("Open share sheet for {platform}", { platform: label })}</b>
                        </li>
                        <li>
                          {t("In the share list, tap")} <b>{label}</b>
                        </li>
                        <li>
                          {multiShare.draft.media_url
                            ? t("Paste the caption into the description — we already copied it.")
                            : t("The caption goes with the share. Edit it in the app if you want.")}
                        </li>
                      </ol>
                      {plat === "tiktok" && multiShare.draft.media_url && (
                        <p className="card-desc multi-share-hint" style={{ marginTop: 0 }}>
                          {t("If TikTok isn’t listed, save the video and upload it in the TikTok app.")}
                        </p>
                      )}
                      <div className="multi-share-dots" aria-hidden="true">
                        {multiShare.queue.map((p, i) => (
                          <i
                            key={p}
                            className={
                              multiShare.done.includes(p) ? "done" : i === multiShare.index ? "on" : ""
                            }
                            style={
                              i === multiShare.index || multiShare.done.includes(p)
                                ? { background: PLATFORM_COLORS[p] }
                                : undefined
                            }
                          />
                        ))}
                      </div>
                      <button
                        type="button"
                        className="btn primary block multi-share-cta"
                        disabled={shareBusy || !shareMediaReady}
                        onClick={() => void runMultiShareStep()}
                        style={{ background: color, borderColor: color, color: "#0a0a0a" }}
                      >
                        <ShareIcon size={16} />
                        {shareBusy
                          ? t("Opening…")
                          : !shareMediaReady
                            ? t("Preparing video…")
                            : t("Open share sheet for {platform}", { platform: label })}
                      </button>
                      <div className="row" style={{ marginTop: 8, gap: 8 }}>
                        <button
                          type="button"
                          className="btn ghost block"
                          disabled={shareBusy}
                          onClick={skipMultiShareStep}
                        >
                          {t("Skip")}
                        </button>
                        {multiShare.draft.media_url && (
                          <button
                            type="button"
                            className="btn outline block"
                            disabled={shareBusy || !shareMediaReady}
                            onClick={() => {
                              const f = getPrefetchedShareMedia(multiShare.draft.media_url);
                              if (f) {
                                downloadShareFile(f);
                                toastAt(t("Video saved — open TikTok and upload it"), multiShare.draft.id);
                              } else {
                                void prefetchShareMedia(multiShare.draft.media_url).then((file) => {
                                  if (file) {
                                    downloadShareFile(file);
                                    setShareMediaReady(true);
                                    toastAt(t("Video saved — open TikTok and upload it"), multiShare.draft.id);
                                  }
                                });
                              }
                            }}
                          >
                            {t("Save video")}
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn outline block"
                          disabled={shareBusy}
                          onClick={nextMultiShareStep}
                        >
                          {multiShare.index + 1 >= multiShare.queue.length ? t("Done") : t("Next · {platform}", {
                            platform:
                              PLATFORM_LABELS[
                                multiShare.queue[
                                  Math.min(multiShare.index + 1, multiShare.queue.length - 1)
                                ]
                              ],
                          })}
                        </button>
                      </div>
                      <button
                        type="button"
                        className="btn ghost block"
                        style={{ marginTop: 8 }}
                        disabled={shareBusy}
                        onClick={() => {
                          setMultiShare(null);
                          setSharePick([]);
                        }}
                      >
                        {t("Cancel")}
                      </button>
                    </>
                  );
                })()}
              </>
            )}
          </div>
        </div>
      )}

      <div className="header">
        <h1>{t("drafts.title")}</h1>
        <span className="sub">{drafts.length > 0 ? t("drafts.saved", { n: drafts.length }) : ""}</span>
      </div>

      {!configured && <div className="banner warn">{t("drafts.signIn")}</div>}
      {error && <div className="banner error">{error}</div>}
      {configured && drafts.length > 0 && (
        <div className="banner ok">
          {t("Share opens your phone's share sheet. We copy the caption — paste it in Instagram, TikTok, or wherever you pick.")}
        </div>
      )}

      {loading && configured && (
        <>
          <div className="skeleton" style={{ height: 64 }} />
          <div className="skeleton" style={{ height: 64 }} />
          <div className="skeleton" style={{ height: 64 }} />
        </>
      )}

      {!loading && configured && drafts.length === 0 && !error && (
        <div className="empty-spark">
          <Spark size={72} mood="happy" />
          <b>{t("Nothing here yet — talk one out")}</b>
          <p>
            {t("Speak an idea on Capture and tap Draft now. Then Share — your phone's share sheet sends it to Instagram, TikTok, and the rest.")}
          </p>
        </div>
      )}

      {drafts.map((d) => {
        const open = openId === d.id;
        const platforms = PLATFORMS.filter((p) => d.variants[p]);
        const current: Platform = platforms.includes(activePlat) ? activePlat : platforms[0];
        const value = current ? d.variants[current] || "" : "";
        const film =
          current && FILM_PLATFORMS.includes(current)
            ? buildFilmGuide(editingKey === `${d.id}:${current}` ? editText : value, current)
            : null;
        return (
          <div
            className={`card draft-card ${focusId === d.id ? "focused" : ""}`}
            id={`draft-${d.id}`}
            key={d.id}
          >
            <button className="draft-head" onClick={() => (open ? setOpenId(null) : openDraft(d))} aria-expanded={open}>
              <span className="topic">{d.topic}</span>
              <span className="meta">
                <span className={`chip ${d.status === "posted" ? "posted" : "draft"}`}>
                  {d.source === "agent" && d.status === "draft" ? t("agent draft") : t(d.status)}
                </span>
                <span className="when">{timeAgo(d.created_at, t)}</span>
              </span>
              <Caret open={open} />
            </button>

            {open && current && (
              <div className="draft-body">
                {d.source === "agent" && d.status === "draft" && (
                  <div className="banner warn" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ flex: 1 }}>{t("Written by your agent — review before sharing.")}</span>
                    <button className="btn sm" onClick={() => setStatus(d, "approved")}>
                      <SparkIcon size={14} />
                      {t("Approve")}
                    </button>
                  </div>
                )}
                {d.topic?.trim() && (
                  <div className="you-said">
                    <span className="muted small">{t("You said")}</span>
                    <p className="you-said-text">{d.topic}</p>
                  </div>
                )}
                {d.media_url && (
                  <>
                    <DraftMedia url={d.media_url} mime={d.media_mime} />
                    <div className="row" style={{ margin: "8px 0 4px", gap: 8, flexWrap: "wrap" }}>
                      {canRevertMedia(d) && (
                        <button
                          type="button"
                          className="btn sm outline"
                          disabled={Boolean(imagineBusy[d.id]) || photoEditBusy}
                          onClick={() => void revertDraftMedia(d)}
                        >
                          {revertLabel(d)}
                        </button>
                      )}
                      {looksLikePhoto(d) &&
                        (tierAtLeast(me?.tier, "creator") ? (
                          <button
                            type="button"
                            className="btn sm"
                            disabled={Boolean(imagineBusy[d.id]) || photoEditBusy}
                            onClick={() => setPhotoEdit({ draft: d, custom: "" })}
                          >
                            <ImageIcon size={15} />
                            {t("Edit photo")}
                          </button>
                        ) : (
                          <Link className="btn sm" to="/setup" style={{ textDecoration: "none" }}>
                            {t("Creator · Edit photo")}
                          </Link>
                        ))}
                    </div>
                  </>
                )}
                <p className="plat-swipe-hint">{t("Swipe for each app — Instagram, TikTok, X…")}</p>
                <div
                  className="plat-carousel"
                  ref={carouselRef}
                  onScroll={onCarouselScroll}
                  role="region"
                  aria-label={t("Posts for each app")}
                >
                  {platforms.map((p) => {
                    const text = d.variants[p] || "";
                    const editing = editingKey === `${d.id}:${p}`;
                    const shown = editing ? editText : text;
                    const color = PLATFORM_COLORS[p];
                    const mark = PLATFORM_LABELS[p].replace(/[^A-Za-z0-9]/g, "").slice(0, 1) || "?";
                    return (
                      <article
                        key={p}
                        data-platform={p}
                        className={`plat-slide ${current === p ? "on" : ""}`}
                        style={{ ["--plat-color" as string]: color }}
                      >
                        <div className="plat-slide-head">
                          <span className="plat-badge" aria-hidden="true">
                            {mark}
                          </span>
                          <div className="plat-slide-title">
                            <b>{PLATFORM_LABELS[p]}</b>
                            <span>
                              {postedMap[`${d.id}:${p}`] ? t("posted") + " ✓ · " : ""}
                              {t("{n} chars", { n: shown.length })}
                            </span>
                          </div>
                        </div>
                        {editing ? (
                          <>
                            <textarea
                              className="variant-edit"
                              rows={Math.min(10, Math.max(4, editText.split("\n").length + 1))}
                              value={editText}
                              onChange={(e) => setEditText(e.target.value)}
                              autoFocus
                            />
                            <div className="row">
                              <button
                                className="btn primary sm block"
                                onClick={() => saveEdit(d, p)}
                                disabled={savingEdit}
                              >
                                <CheckIcon size={15} />
                                {savingEdit ? t("Saving…") : t("Save")}
                              </button>
                              <button
                                className="btn ghost sm block"
                                onClick={() => setEditingKey(null)}
                                disabled={savingEdit}
                              >
                                {t("Cancel")}
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
                            <pre
                              className="plat-slide-text"
                              onClick={() => startEdit(d, p)}
                              title={t("Tap to edit")}
                            >
                              {text}
                            </pre>
                            <div className="row plat-slide-actions">
                              <button className="btn sm" onClick={() => startEdit(d, p)}>
                                <PenIcon size={15} />
                                {t("drafts.edit")}
                              </button>
                              <button className="btn sm block" onClick={() => copy(text, d.id)}>
                                <CopyIcon size={15} />
                                {t("drafts.copy")}
                              </button>
                              <button
                                className="btn primary sm block"
                                onClick={() => void openMultiShare(d, p)}
                              >
                                <ShareIcon size={15} />
                                {t("Share")}
                              </button>
                              {canDirectPost(p) && (
                                <button
                                  className="btn sm block"
                                  onClick={() => postNow(d, p)}
                                  disabled={posting || postedMap[`${d.id}:${p}`]}
                                >
                                  <SendIcon size={15} />
                                  {postedMap[`${d.id}:${p}`] ? t("Posted") : t("drafts.post")}
                                </button>
                              )}
                              {canSchedulePlatform(p) && !postedMap[`${d.id}:${p}`] && (
                                <button
                                  className="btn sm icon-only"
                                  aria-label={t("Schedule this post")}
                                  onClick={() => openScheduler(d, p)}
                                  disabled={posting}
                                >
                                  <ClockIcon size={15} />
                                </button>
                              )}
                            </div>
                          </>
                        )}
                      </article>
                    );
                  })}
                </div>
                <div className="plat-dots" role="tablist" aria-label={t("Choose an app")}>
                  {platforms.map((p) => (
                    <button
                      key={p}
                      type="button"
                      role="tab"
                      aria-label={PLATFORM_LABELS[p]}
                      aria-selected={current === p}
                      className={`plat-dot ${current === p ? "on" : ""}`}
                      style={{ background: current === p ? PLATFORM_COLORS[p] : undefined }}
                      onClick={() => {
                        setActivePlat(p);
                        snapCarouselTo(p);
                      }}
                    />
                  ))}
                </div>
                {!canDirectPost(current) &&
                  current === "x" &&
                  connections?.providers?.x === "available" &&
                  !connections.connected.some((c) => c.platform === "x") && (
                    <p className="muted small" style={{ margin: "-6px 0 12px", textAlign: "center" }}>
                      <Link to="/setup">{t("Connect X in Setup")}</Link>
                    </p>
                  )}
                {!canDirectPost(current) &&
                  (UNIFIED_POST_PLATFORMS as readonly string[]).includes(current) && (
                    <p className="muted small" style={{ margin: "-6px 0 12px", textAlign: "center" }}>
                      {t("Share for now")}
                    </p>
                  )}

                {film && (() => {
                  const edit = getFilmEdit(d, current, film);
                  return (
                  <div className="film-guide" style={{ "--plat-color": PLATFORM_COLORS[current] } as CSSProperties}>
                    <div className="film-guide-head">
                      <VideoIcon size={16} />
                      <strong>{t("Film this")}</strong>
                      <span className="film-guide-sub">
                        {t("Edit caption, on-screen text, and AI prompt — Share uses the caption only")}
                      </span>
                    </div>

                    <div className="film-block">
                      <span className="film-label">{t("Post caption (Share / Post)")}</span>
                      <textarea
                        className="film-edit"
                        rows={3}
                        value={edit.caption}
                        onChange={(e) => setFilmEditField(d.id, current, { caption: e.target.value }, edit)}
                        placeholder={t("Short caption + hashtags for the app description")}
                      />
                    </div>

                    <div className="film-block">
                      <span className="film-label">{t("On-screen text")}</span>
                      <textarea
                        className="film-edit"
                        rows={2}
                        value={edit.onScreen}
                        onChange={(e) => setFilmEditField(d.id, current, { onScreen: e.target.value }, edit)}
                        placeholder={t("Short phrase · max ~8 words")}
                      />
                      {edit.burnIn && edit.onScreen.trim() ? (
                        <div className="film-overlay-preview" aria-hidden="true">
                          {previewOverlayLines(edit.onScreen).map((line, i) => (
                            <span key={i}>{line}</span>
                          ))}
                        </div>
                      ) : null}
                    </div>

                    <div className="film-block">
                      <span className="film-label">{t("On-screen text on clip")}</span>
                      <div className="film-burn-row" role="group" aria-label={t("On-screen text on clip")}>
                        <button
                          type="button"
                          className={`chip-btn ${edit.burnIn ? "on" : ""}`}
                          onClick={() => setFilmEditField(d.id, current, { burnIn: true }, edit)}
                        >
                          {t("On")}
                        </button>
                        <button
                          type="button"
                          className={`chip-btn ${!edit.burnIn ? "on" : ""}`}
                          onClick={() => setFilmEditField(d.id, current, { burnIn: false }, edit)}
                        >
                          {t("Off")}
                        </button>
                      </div>
                      <p className="film-imagine-meta" style={{ marginTop: 6 }}>
                        {edit.burnIn
                          ? t("We'll stamp exact text on the clip after generation")
                          : t("Clean clip — no on-screen text")}
                      </p>
                    </div>

                    <div className="film-block">
                      <span className="film-label">{t("Brand watermark")}</span>
                      {brandWatermarkUrl ? (
                        <>
                          <div className="film-burn-row" role="group" aria-label={t("Brand watermark")}>
                            <button
                              type="button"
                              className={`chip-btn ${edit.watermark !== false ? "on" : ""}`}
                              onClick={() => setFilmEditField(d.id, current, { watermark: true }, edit)}
                            >
                              {t("On")}
                            </button>
                            <button
                              type="button"
                              className={`chip-btn ${edit.watermark === false ? "on" : ""}`}
                              onClick={() => setFilmEditField(d.id, current, { watermark: false }, edit)}
                            >
                              {t("Off")}
                            </button>
                          </div>
                          <div className="watermark-draft-preview">
                            <img src={brandWatermarkUrl} alt="" />
                            <p className="film-imagine-meta" style={{ margin: 0 }}>
                              {edit.watermark !== false
                                ? t("Stamped in the lower-right corner after generation")
                                : t("No watermark on this generate")}
                            </p>
                          </div>
                        </>
                      ) : (
                        <p className="film-imagine-meta" style={{ marginTop: 0 }}>
                          <Link to="/setup">{t("Add a watermark in Brand Brain")}</Link>
                        </p>
                      )}
                    </div>

                    <div className="film-block">
                      <span className="film-label">{t("Voice style")}</span>
                      <p className="film-imagine-meta" style={{ marginTop: 0, marginBottom: 8 }}>
                        {tierAtLeast(me?.tier, "studio")
                          ? t("Pick how the talk track should sound — Studio AI clips narrate in this voice.")
                          : t("Pick a delivery style for your talk track. Studio can narrate AI clips in this voice.")}
                      </p>
                      <div className="voice-style-grid" role="radiogroup" aria-label={t("Voice style")}>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={(edit.voiceId || "none") === "none"}
                          className={`voice-style-card ${(edit.voiceId || "none") === "none" ? "on" : ""}`}
                          onClick={() => setFilmEditField(d.id, current, { voiceId: "none" }, edit)}
                        >
                          <span className="voice-style-name">{t("None")}</span>
                          <span className="voice-style-vibe">{t("You speak it — or silent clip")}</span>
                        </button>
                        {voiceStylesForUi().map((v) => {
                          const selected = (edit.voiceId || "none") === v.id;
                          return (
                            <div
                              key={v.id}
                              className={`voice-style-card ${selected ? "on" : ""}`}
                              role="radio"
                              aria-checked={selected}
                              tabIndex={0}
                              onClick={() => setFilmEditField(d.id, current, { voiceId: v.id }, edit)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  setFilmEditField(d.id, current, { voiceId: v.id }, edit);
                                }
                              }}
                            >
                              <span className="voice-style-name">{v.label}</span>
                              {v.vibe ? <span className="voice-style-vibe">{v.vibe}</span> : null}
                              {v.example ? <span className="voice-style-example">“{v.example}”</span> : null}
                              {tierAtLeast(me?.tier, "studio") && imagineInfo?.voices?.configured !== false ? (
                                <button
                                  type="button"
                                  className="voice-style-play"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void playVoicePreview(v.id, d.id, v.example);
                                  }}
                                >
                                  {voicePreviewId === v.id ? t("Stop") : t("Hear example")}
                                </button>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                      {tierAtLeast(me?.tier, "studio") && imagineInfo?.voices && !imagineInfo.voices.configured ? (
                        <p className="film-imagine-meta" style={{ marginTop: 6 }}>
                          {t("Voiceover needs XAI_API_KEY on the hub")}
                        </p>
                      ) : null}
                      {!tierAtLeast(me?.tier, "studio") ? (
                        <p className="film-imagine-meta" style={{ marginTop: 6 }}>
                          <Link to="/setup">{t("Upgrade to Studio")}</Link>
                          {" · "}
                          {t("for AI voiceover on clips")}
                        </p>
                      ) : null}
                    </div>

                    <div className="film-block">
                      <span className="film-label">{t("AI video prompt")}</span>
                      <textarea
                        className="film-edit"
                        rows={3}
                        value={edit.imagine}
                        onChange={(e) => setFilmEditField(d.id, current, { imagine: e.target.value }, edit)}
                        placeholder={t("Describe the visuals & motion for the AI clip")}
                      />
                    </div>

                    <details className="film-talk-details" open={Boolean(edit.voiceId && edit.voiceId !== "none")}>
                      <summary>{t("Talk track (optional)")}</summary>
                      <div className="film-block" style={{ marginTop: 10 }}>
                        <span className="film-label">{t("Hook")}</span>
                        <p>{film.hook}</p>
                      </div>
                      {film.beats.length > 0 && (
                        <div className="film-block">
                          <span className="film-label">{t("Beats")}</span>
                          <ol className="film-beats">
                            {film.beats.map((b, i) => (
                              <li key={i}>{b}</li>
                            ))}
                          </ol>
                        </div>
                      )}
                      {film.keyword ? (
                        <div className="film-block">
                          <span className="film-label">{t("Keyword")}</span>
                          <p>{film.keyword}</p>
                        </div>
                      ) : null}
                      {(() => {
                        const style = getVoiceStyle(edit.voiceId);
                        return style ? (
                          <div className="film-block">
                            <span className="film-label">{t("Delivery")}</span>
                            <p>
                              {style.label} — {style.vibe}
                            </p>
                          </div>
                        ) : null;
                      })()}
                      <button
                        type="button"
                        className="btn sm block"
                        style={{ marginTop: 8 }}
                        onClick={() => {
                          void copyText(formatTalkTrackCopy(film.talkTrack, edit.voiceId)).then(() =>
                            toastAt(t("Talk track copied"), d.id)
                          );
                        }}
                      >
                        <CopyIcon size={15} />
                        {t("Copy talk track")}
                      </button>
                    </details>

                    {imagineBusy[d.id] && (
                      <div className="film-imagine-progress">
                        {imagineBusy[d.id].kind === "still"
                          ? t("Generating still…")
                          : t("Generating AI clip… {n}%", { n: imagineBusy[d.id].progress || 0 })}
                      </div>
                    )}
                    <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        className="btn sm block"
                        disabled={filmSaving}
                        onClick={() => void saveFilmEdits(d, current, film)}
                      >
                        <CheckIcon size={15} />
                        {filmSaving ? t("Saving…") : t("Save")}
                      </button>
                      <button
                        type="button"
                        className="btn sm block"
                        onClick={() => {
                          void copyText(withBrandTag(edit.caption, me?.tier)).then(() =>
                            toastAt(t("Post caption copied"), d.id)
                          );
                        }}
                      >
                        <CopyIcon size={15} />
                        {t("Copy caption")}
                      </button>
                      {tierAtLeast(me?.tier, "creator") ? (
                        <>
                          {(tierAtLeast(me?.tier, "studio") ||
                            (imagineInfo?.videos?.credits ?? 0) > 0) && (
                            <button
                              type="button"
                              className="btn primary sm block"
                              disabled={Boolean(imagineBusy[d.id]) || imagineInfo?.configured === false || filmSaving}
                              onClick={() => void generateAiClip(d, current, film)}
                              title={
                                imagineInfo?.configured === false
                                  ? t("AI clip not configured on hub")
                                  : imagineInfo?.videos
                                    ? t("{remaining} video clips left", {
                                        remaining: imagineInfo.videos.remaining,
                                      })
                                    : undefined
                              }
                            >
                              <SparkIcon size={15} />
                              {imagineBusy[d.id]?.kind === "video"
                                ? t("Generating…")
                                : t("Generate AI clip")}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn sm block"
                            disabled={Boolean(imagineBusy[d.id]) || imagineInfo?.configured === false || filmSaving}
                            onClick={() => void generateAiStill(d, current, film)}
                          >
                            <SparkIcon size={15} />
                            {imagineBusy[d.id]?.kind === "still" ? t("Generating…") : t("Generate still")}
                          </button>
                          {!tierAtLeast(me?.tier, "studio") && (imagineInfo?.videos?.credits ?? 0) <= 0 && (
                            <Link className="btn sm block" to="/setup" style={{ textDecoration: "none" }}>
                              {t("Studio · AI video")}
                            </Link>
                          )}
                        </>
                      ) : (
                        <Link className="btn sm block" to="/setup" style={{ textDecoration: "none" }}>
                          {t("Creator · AI still")}
                        </Link>
                      )}
                    </div>
                    {tierAtLeast(me?.tier, "creator") && imagineInfo && (
                      <p className="film-imagine-meta">
                        {!imagineInfo.configured
                          ? t("Add XAI_API_KEY on the hub to enable AI media")
                          : [
                              t("{used}/{limit} stills", {
                                used: imagineInfo.stills?.used ?? 0,
                                limit: imagineInfo.stills?.limit ?? 0,
                              }),
                              tierAtLeast(me?.tier, "studio") || (imagineInfo.videos?.credits ?? 0) > 0
                                ? t("{remaining} videos left · ~6s", {
                                    remaining: imagineInfo.videos?.remaining ?? 0,
                                  })
                                : t("Video on Studio or with credits"),
                            ].join(" · ")}
                      </p>
                    )}
                  </div>
                  );
                })()}

                <div className="row between" style={{ marginTop: 14 }}>
                  {d.status !== "posted" ? (
                    <button className="btn sm" onClick={() => setStatus(d, "posted")}>
                      <CheckIcon size={15} />
                      {t("Mark posted")}
                    </button>
                  ) : (
                    <button className="btn ghost sm" onClick={() => setStatus(d, "draft")}>
                      {t("Reopen")}
                    </button>
                  )}
                  <button className={`btn sm ${confirmDelete === d.id ? "danger outline" : "ghost danger"}`} onClick={() => remove(d.id)}>
                    <TrashIcon size={15} />
                    {confirmDelete === d.id ? t("Tap again to delete") : t("Delete")}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
