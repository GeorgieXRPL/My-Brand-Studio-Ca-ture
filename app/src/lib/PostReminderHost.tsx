import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PLATFORM_LABELS, type Draft, type Me, type Platform } from "./types";
import {
  markReminderDone,
  markReminderNotified,
  nextUnnotifiedDue,
  pushBrowserNotification,
  type PostReminder,
} from "./postReminders";
import { ShareIcon } from "./icons";
import { useT } from "./i18n";
import { getPrefetchedShareMedia, prefetchShareMedia, shareForPlatform } from "./share";
import { api, isConfigured } from "./api";

/**
 * Global host: when a planned Share reminder is due, show a sheet and
 * optionally a browser notification. Works while social auto-post APIs are pending.
 */
export default function PostReminderHost() {
  const t = useT();
  const [due, setDue] = useState<PostReminder | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareMediaReady, setShareMediaReady] = useState(true);

  useEffect(() => {
    if (!isConfigured()) return;
    api.me().then(setMe).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      const next = nextUnnotifiedDue();
      if (!next || cancelled) return;
      markReminderNotified(next.id);
      const label = PLATFORM_LABELS[next.platform as Platform] || next.platform;
      pushBrowserNotification(next, label);
      setDue(next);
      setDraft(null);
      setShareMediaReady(true);
    }

    tick();
    const id = window.setInterval(tick, 30_000);
    const onFocus = () => tick();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") tick();
    });
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // Load draft + prefetch media while the reminder sheet is open (before Share tap).
  useEffect(() => {
    if (!due) return;
    let cancelled = false;
    setShareMediaReady(true);
    (async () => {
      try {
        const rows = await api.getDrafts();
        if (cancelled) return;
        const found = rows.find((d) => d.id === due.draftId) || null;
        setDraft(found);
        if (found?.media_url) {
          if (getPrefetchedShareMedia(found.media_url)) {
            setShareMediaReady(true);
          } else {
            setShareMediaReady(false);
            await prefetchShareMedia(found.media_url);
            if (!cancelled) setShareMediaReady(true);
          }
        }
      } catch {
        /* Share can still use reminder preview text */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [due]);

  async function shareNow() {
    if (!due) return;
    setSharing(true);
    try {
      const text = draft?.variants?.[due.platform] || due.preview || due.topic;
      const mediaUrl = draft?.media_url;
      const file = getPrefetchedShareMedia(mediaUrl);
      await shareForPlatform(due.platform, text, mediaUrl, file, { tier: me?.tier });
      markReminderDone(due.id);
      setDue(null);
      setDraft(null);
    } catch {
      /* keep sheet open — user can open draft */
    } finally {
      setSharing(false);
    }
  }

  function dismiss() {
    if (due) markReminderDone(due.id);
    setDue(null);
    setDraft(null);
  }

  function snooze() {
    // Keep notified so we don't re-popup immediately; leave as pending in list.
    setDue(null);
    setDraft(null);
  }

  if (!due) return null;

  const label = PLATFORM_LABELS[due.platform as Platform] || due.platform;

  return (
    <div className="sheet-overlay" style={{ zIndex: 80 }} onClick={snooze}>
      <div className="sheet reminder-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title">{t("Time to post")}</div>
        <p className="card-desc" style={{ marginTop: 0 }}>
          {t("Reminder for {platform} — Share from your phone while we finish official account linking.", {
            platform: label,
          })}
        </p>
        <div className="content-preview">
          <b>{due.topic || t("Draft #{id}", { id: due.draftId })}</b>
          {due.preview ? <p style={{ margin: "8px 0 0" }}>{due.preview}</p> : null}
        </div>
        <button
          type="button"
          className="btn primary block"
          style={{ marginTop: 14 }}
          onClick={shareNow}
          disabled={sharing || !shareMediaReady}
        >
          <ShareIcon size={16} />
          {sharing ? t("Opening…") : !shareMediaReady ? t("Preparing photo…") : t("Share now")}
        </button>
        <Link
          className="btn outline block"
          style={{ marginTop: 8, textDecoration: "none" }}
          to={`/drafts?focus=${due.draftId}`}
          onClick={() => {
            setDue(null);
            setDraft(null);
          }}
        >
          {t("Open draft")}
        </Link>
        <button type="button" className="btn ghost block" style={{ marginTop: 8 }} onClick={dismiss}>
          {t("Done — I've posted")}
        </button>
      </div>
    </div>
  );
}
