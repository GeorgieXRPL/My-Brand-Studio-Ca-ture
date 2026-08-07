import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, isConfigured } from "../lib/api";
import { copyText, shareForPlatform } from "../lib/share";
import { useToast } from "../lib/toast";
import { CheckIcon, ClockIcon, CopyIcon, PenIcon, SendIcon, ShareIcon, SparkIcon, TrashIcon, VideoIcon } from "../lib/icons";
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
import {
  buildDefaultImaginePrompt,
  buildFilmGuide,
  FILM_PLATFORMS,
  mergeFilmEditsIntoScript,
  resolveImaginePrompt,
  type FilmEdit,
} from "../lib/filmHelper";
import { useT } from "../lib/i18n";

type MultiShare = {
  draft: Draft;
  queue: Platform[];
  index: number;
  done: Platform[];
};

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

function DraftMedia({ url }: { url: string }) {
  const looksVideo = /\.(mp4|webm|mov)(\?|$)/i.test(url);
  const looksImage = /\.(jpe?g|png|gif|webp|heic|heif)(\?|$)/i.test(url);
  const [mode, setMode] = useState<"img" | "video">(looksVideo && !looksImage ? "video" : "img");
  if (mode === "video") {
    return (
      <video
        className="draft-media"
        src={url}
        controls
        playsInline
        preload="metadata"
        onError={() => setMode("img")}
      />
    );
  }
  return (
    <img
      className="draft-media"
      src={url}
      alt=""
      loading="lazy"
      onError={() => {
        if (!looksImage) setMode("video");
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
  const [imagineInfo, setImagineInfo] = useState<{
    configured: boolean;
    used: number;
    limit: number;
  } | null>(null);
  const [imagineBusy, setImagineBusy] = useState<
    Record<number, { jobId: number; progress: number; kind: string }>
  >({});
  /** Local Film this edits keyed by draftId:platform */
  const [filmEdits, setFilmEdits] = useState<Record<string, FilmEdit>>({});
  const [filmSaving, setFilmSaving] = useState(false);
  const toastAnchorRef = useRef<Element | null>(null);
  const pollTimers = useRef<Record<number, ReturnType<typeof setInterval>>>({});
  const configured = isConfigured();

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

  function canDirectPost(platform: Platform): boolean {
    const linked = Boolean(connections?.connected.some((c) => c.platform === platform));
    if (!linked) return false;
    // Unified vendor Post is Studio-only; X (direct OAuth) stays Creator+.
    if ((UNIFIED_POST_PLATFORMS as readonly string[]).includes(platform)) {
      return tierAtLeast(me?.tier, "studio");
    }
    return tierAtLeast(me?.tier, "creator");
  }

  function canSchedulePlatform(platform: Platform): boolean {
    return canDirectPost(platform);
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
    setShareBusy(true);
    try {
      await shareForPlatform(platform, text, multiShare.draft.media_url);
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
      await api.schedulePost(scheduling.draft.id, scheduling.platform, new Date(scheduleAt).toISOString());
      toastAt(t("Scheduled for {platform}", { platform: PLATFORM_LABELS[scheduling.platform] }), scheduling.draft.id);
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
      const [conns, posts, account, imagine] = await Promise.all([
        api.getConnections(),
        api.getPosts(),
        api.me(),
        api.imagineStatus().catch(() => null),
      ]);
      setConnections(conns);
      setMe(account);
      if (imagine) setImagineInfo({ configured: imagine.configured, used: imagine.used, limit: imagine.limit });
      const map: Record<string, boolean> = {};
      for (const p of posts) map[`${p.draft_id}:${p.platform}`] = true;
      setPostedMap(map);
    } catch {
      /* posting UI simply stays hidden */
    }
  }

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
            toastAt(t("AI clip ready — attached to this draft"), draftId);
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
        burnIn: true,
      });
    return { caption: film.caption, imagine, onScreen: film.onScreen, burnIn: true };
  }

  function setFilmEditField(draftId: number, platform: Platform, patch: Partial<FilmEdit>, base: FilmEdit) {
    const key = filmKey(draftId, platform);
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
    if (!tierAtLeast(me?.tier, "studio")) {
      toastAt(t("AI clips are a Studio feature"), d.id);
      return;
    }
    try {
      const edit = getFilmEdit(d, platform, film);
      const saved = await saveFilmEdits(d, platform, film);
      const prompt = resolveImaginePrompt(edit, film, d.topic);
      setImagineBusy((m) => ({ ...m, [d.id]: { jobId: 0, progress: 0, kind: "video" } }));
      const job = await api.startImagineVideo({
        draft_id: saved.id,
        platform,
        duration: 8,
        prompt,
      });
      setImagineBusy((m) => ({ ...m, [d.id]: { jobId: job.id, progress: job.progress ?? 0, kind: "video" } }));
      toastAt(t("Generating AI clip… usually under a minute"), d.id);
      pollImagineJob(d.id, job.id);
      void api.imagineStatus().then((s) => setImagineInfo({ configured: s.configured, used: s.used, limit: s.limit }));
    } catch (e: any) {
      setImagineBusy((m) => {
        const next = { ...m };
        delete next[d.id];
        return next;
      });
      toastAt(e.message || t("AI clip failed"), d.id);
    }
  }

  async function generateAiStill(d: Draft, platform: Platform, film: NonNullable<ReturnType<typeof buildFilmGuide>>) {
    noteAnchor(d.id);
    if (!tierAtLeast(me?.tier, "studio")) {
      toastAt(t("AI stills are a Studio feature"), d.id);
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
      });
      setImagineBusy((m) => {
        const next = { ...m };
        delete next[d.id];
        return next;
      });
      toastAt(t("AI still ready — attached to this draft"), d.id);
      void load();
      void api.imagineStatus().then((s) => setImagineInfo({ configured: s.configured, used: s.used, limit: s.limit }));
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
    await copyText(text);
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
      {scheduling && (
        <div className="sheet-overlay" onClick={() => setScheduling(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{t("Schedule for {platform}", { platform: PLATFORM_LABELS[scheduling.platform] })}</div>
            <label>{t("Post at")}</label>
            <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
            <button className="btn primary block" style={{ marginTop: 14 }} onClick={confirmSchedule} disabled={posting}>
              <ClockIcon size={16} />
              {posting ? t("Scheduling…") : t("Schedule post")}
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
                <p className="card-desc" style={{ marginTop: 0 }}>
                  {t(
                    "Pick the apps. We'll copy each caption and open your phone's share sheet — paste when the app asks."
                  )}
                </p>
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
                      <p className="card-desc multi-share-hint">
                        {multiShare.draft.media_url
                          ? t("We copy the caption first. After you pick {platform}, paste it into the description.", {
                              platform: label,
                            })
                          : t("Your phone will open the share sheet — scroll only if you need to find {platform}.", {
                              platform: label,
                            })}
                      </p>
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
                        disabled={shareBusy}
                        onClick={() => void runMultiShareStep()}
                        style={{ background: color, borderColor: color, color: "#0a0a0a" }}
                      >
                        <ShareIcon size={16} />
                        {shareBusy ? t("Opening…") : t("Open share sheet for {platform}", { platform: label })}
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
      {configured && !tierAtLeast(me?.tier, "creator") && (
        <div className="banner ok">
          {t("Guided Share ships to every app — free. Mark posts as shipped when you're done.")}
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
          <b>{t("Nothing here yet — let's fix that!")}</b>
          <p>
            {t("Speak an idea on the Capture tab and tap Draft now — it becomes posts for every platform, including LinkedIn.")}
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
                {d.media_url && <DraftMedia url={d.media_url} />}
                <div className="plat-tabs" role="tablist">
                  {platforms.map((p) => (
                    <button
                      key={p}
                      role="tab"
                      aria-selected={current === p}
                      className={`plat-tab ${current === p ? "active" : ""}`}
                      style={{ "--plat-color": PLATFORM_COLORS[p] } as CSSProperties}
                      onClick={() => setActivePlat(p)}
                    >
                      <span className="dot" />
                      {PLATFORM_LABELS[p]}
                    </button>
                  ))}
                </div>

                <div className="variant" style={{ "--plat-color": PLATFORM_COLORS[current] } as CSSProperties}>
                  <div className="plat">
                    {PLATFORM_LABELS[current]}
                    <span className="chars">
                      {postedMap[`${d.id}:${current}`] ? t("posted") + " ✓ · " : ""}
                      {t("{n} chars", { n: (editingKey === `${d.id}:${current}` ? editText : value).length })}
                    </span>
                  </div>
                  {editingKey === `${d.id}:${current}` ? (
                    <>
                      <textarea
                        className="variant-edit"
                        rows={Math.min(12, Math.max(4, editText.split("\n").length + 1))}
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        autoFocus
                      />
                      <div className="row">
                        <button className="btn primary sm block" onClick={() => saveEdit(d, current)} disabled={savingEdit}>
                          <CheckIcon size={15} />
                          {savingEdit ? t("Saving…") : t("Save")}
                        </button>
                        <button className="btn ghost sm block" onClick={() => setEditingKey(null)} disabled={savingEdit}>
                          {t("Cancel")}
                        </button>
                      </div>
                    </>
                  ) : (
                  <>
                  <pre className="variant-text" onClick={() => startEdit(d, current)} title={t("Tap to edit")}>
                    {value}
                  </pre>
                  <div className="row">
                    <button className="btn sm" onClick={() => startEdit(d, current)}>
                      <PenIcon size={15} />
                      {t("drafts.edit")}
                    </button>
                    <button className="btn sm block" onClick={() => copy(value, d.id)}>
                      <CopyIcon size={15} />
                      {t("drafts.copy")}
                    </button>
                    <button className="btn primary sm block" onClick={() => void openMultiShare(d, current)}>
                      <ShareIcon size={15} />
                      {t("Share")}
                    </button>
                    {canDirectPost(current) && (
                      <button
                        className="btn sm block"
                        onClick={() => postNow(d, current)}
                        disabled={posting || postedMap[`${d.id}:${current}`]}
                      >
                        <SendIcon size={15} />
                        {postedMap[`${d.id}:${current}`] ? t("Posted") : t("drafts.post")}
                      </button>
                    )}
                    {canSchedulePlatform(current) && !postedMap[`${d.id}:${current}`] && (
                      <button
                        className="btn sm icon-only"
                        aria-label={t("Schedule this post")}
                        onClick={() => openScheduler(d, current)}
                        disabled={posting}
                      >
                        <ClockIcon size={15} />
                      </button>
                    )}
                    {!canDirectPost(current) &&
                      current === "x" &&
                      connections?.providers?.x === "available" &&
                      !connections.connected.some((c) => c.platform === "x") && (
                        <Link className="btn sm block" to="/setup" style={{ textDecoration: "none" }}>
                          {t("Connect X in Setup")}
                        </Link>
                      )}
                    {!canDirectPost(current) &&
                      (UNIFIED_POST_PLATFORMS as readonly string[]).includes(current) && (
                        <span className="muted small" style={{ marginLeft: 4, alignSelf: "center" }}>
                          {t("Share for now")}
                        </span>
                      )}
                  </div>
                  </>
                  )}
                </div>

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
                        placeholder={t("Text that can appear on the video")}
                      />
                    </div>

                    <div className="film-block">
                      <span className="film-label">{t("Burn text into clip")}</span>
                      <div className="film-burn-row" role="group" aria-label={t("Burn text into clip")}>
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
                          ? t("AI will try to put the on-screen text into the generated clip")
                          : t("Clean clip — no text burned in")}
                      </p>
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

                    <details className="film-talk-details">
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
                      <button
                        type="button"
                        className="btn sm block"
                        style={{ marginTop: 8 }}
                        onClick={() => {
                          void copyText(film.talkTrack).then(() => toastAt(t("Talk track copied"), d.id));
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
                          void copyText(edit.caption).then(() => toastAt(t("Post caption copied"), d.id));
                        }}
                      >
                        <CopyIcon size={15} />
                        {t("Copy caption")}
                      </button>
                      {tierAtLeast(me?.tier, "studio") ? (
                        <>
                          <button
                            type="button"
                            className="btn primary sm block"
                            disabled={Boolean(imagineBusy[d.id]) || imagineInfo?.configured === false || filmSaving}
                            onClick={() => void generateAiClip(d, current, film)}
                            title={
                              imagineInfo?.configured === false
                                ? t("AI clip not configured on hub")
                                : imagineInfo
                                  ? t("{used}/{limit} AI media this month", {
                                      used: imagineInfo.used,
                                      limit: imagineInfo.limit,
                                    })
                                  : undefined
                            }
                          >
                            <SparkIcon size={15} />
                            {imagineBusy[d.id]?.kind === "video"
                              ? t("Generating…")
                              : t("Generate AI clip")}
                          </button>
                          <button
                            type="button"
                            className="btn sm block"
                            disabled={Boolean(imagineBusy[d.id]) || imagineInfo?.configured === false || filmSaving}
                            onClick={() => void generateAiStill(d, current, film)}
                          >
                            <SparkIcon size={15} />
                            {imagineBusy[d.id]?.kind === "still" ? t("Generating…") : t("Generate still")}
                          </button>
                        </>
                      ) : (
                        <Link className="btn sm block" to="/setup" style={{ textDecoration: "none" }}>
                          {t("Studio · AI clip")}
                        </Link>
                      )}
                    </div>
                    {tierAtLeast(me?.tier, "studio") && imagineInfo && (
                      <p className="film-imagine-meta">
                        {imagineInfo.configured
                          ? t("{used}/{limit} AI media this month · ~8s vertical clip", {
                              used: imagineInfo.used,
                              limit: imagineInfo.limit,
                            })
                          : t("Add XAI_API_KEY on the hub to enable AI clips")}
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
