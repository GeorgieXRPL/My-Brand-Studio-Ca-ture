import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, isConfigured } from "../lib/api";
import { isVoiceSupported, startlistening, type VoiceController } from "../lib/voice";
import { useToast } from "../lib/toast";
import { BulbIcon, CameraIcon, FlameIcon, ImageIcon, MicIcon, SparkIcon, StopIcon, TrashIcon, XCircleIcon } from "../lib/icons";
import Tour, { shouldShowTour } from "../lib/Tour";
import Checklist, { dismissChecklist, shouldShowChecklist } from "../lib/Checklist";
import { queueCelebration } from "../lib/Confetti";
import CameraCapture from "../lib/CameraCapture";
import Spark from "../lib/Spark";
import { MAX_UPLOAD_BYTES, prepareMedia } from "../lib/media";
import { speechLocaleFor } from "../lib/languages";
import { useLocale, useT } from "../lib/i18n";
import type { Idea, Profile } from "../lib/types";

// Consecutive days with at least one captured idea, counting back from today/yesterday.
function captureStreak(ideas: Idea[]): number {
  const days = new Set(ideas.map((i) => i.created_at.slice(0, 10)));
  let streak = 0;
  const cursor = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  if (!days.has(iso(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(iso(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export default function Capture() {
  const toast = useToast();
  const t = useT();
  const { setLocale } = useLocale();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [listening, setListening] = useState(false);
  const [text, setText] = useState("");
  const [interim, setInterim] = useState("");
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [mediaMime, setMediaMime] = useState("");
  const [uploading, setUploading] = useState(false);
  const [showTour, setShowTour] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [showChecklist, setShowChecklist] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [draftCount, setDraftCount] = useState(0);
  const controller = useRef<VoiceController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const configured = isConfigured();

  useEffect(() => {
    if (configured) {
      loadIdeas();
      Promise.all([api.getProfile(), api.getDrafts()])
        .then(([p, drafts]) => {
          setProfile(p);
          setDraftCount(drafts.length);
          if (p.traits?.preferred_language) setLocale(p.traits.preferred_language);
        })
        .catch(() => {});
    }
    // Content shared into the app from other apps (Web Share Target).
    const shared = [params.get("title"), params.get("text"), params.get("url")].filter(Boolean).join("\n");
    if (shared) {
      setText(shared);
      setParams({}, { replace: true });
      toast(t("Shared content added — draft it or save it"));
    }
    // Tour only after sign-in so first-timers aren't coached before they have an account.
    if (configured && shouldShowTour()) {
      const t = window.setTimeout(() => setShowTour(true), 600);
      return () => {
        window.clearTimeout(t);
        controller.current?.stop();
      };
    }
    return () => controller.current?.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!configured) {
      setShowChecklist(false);
      return;
    }
    // Don't stack checklist under the tour — checklist after tour finishes.
    if (showTour || shouldShowTour()) {
      setShowChecklist(false);
      return;
    }
    const hasBrand = Boolean(profile?.goals?.trim() || profile?.brand_voice?.trim());
    const hasDraft = draftCount > 0 || ideas.some((i) => i.status === "drafted");
    setShowChecklist(shouldShowChecklist({ configured, hasBrand, hasDraft }));
  }, [configured, profile, draftCount, ideas, showTour]);

  async function attachMedia(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    try {
      const prepared = await prepareMedia(file);
      if (prepared.size > MAX_UPLOAD_BYTES) {
        throw new Error(t("That video is too large (max ~24MB). Trim it in your gallery and try again."));
      }
      const media = await api.uploadMedia(prepared);
      setMediaUrl(media.url);
      setMediaMime(media.mime);
      toast(t("Media attached"));
    } catch (e: any) {
      toast(e.message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function loadIdeas() {
    try {
      setIdeas(await api.getIdeas());
      setError("");
    } catch (e: any) {
      setError(e.message);
    }
  }

  function toggleMic() {
    if (listening) {
      controller.current?.stop();
      return;
    }
    if (!isVoiceSupported()) {
      toast(t("Voice needs Chrome on Android or Safari on iPhone"));
      return;
    }
    setInterim("");
    setListening(true);
    controller.current = startlistening(
      {
        onTranscript: (finalText, interimText) => {
          setText(finalText);
          setInterim(interimText);
        },
        onError: (msg) => {
          toast(msg);
          setListening(false);
        },
        onEnd: () => {
          setListening(false);
          setInterim("");
        },
      },
      { lang: speechLocaleFor(profile?.traits?.preferred_language) }
    );
  }

  async function saveIdea() {
    const value = text.trim();
    if (!value) return;
    try {
      await api.addIdea(value, mediaUrl || undefined);
      setText("");
      setMediaUrl("");
      toast(t("Saved to backlog"));
      loadIdeas();
    } catch (e: any) {
      toast(e.message);
    }
  }

  async function draftNow(topic: string, ideaId?: number) {
    if (!topic.trim()) return;
    setBusy(true);
    try {
      const draft = await api.generate(
        ideaId ? { idea_id: ideaId } : { topic, media_url: mediaUrl || undefined }
      );
      setText("");
      setMediaUrl("");
      setDraftCount((n) => n + 1);
      queueCelebration();
      navigate(`/drafts?focus=${draft.id}`);
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  }

  const openIdeas = ideas.filter((i) => i.status !== "drafted");
  const draftedIdeas = ideas.filter((i) => i.status === "drafted");
  const streak = captureStreak(ideas);

  return (
    <div className="screen screen-capture">
      {showTour && <Tour onDone={() => setShowTour(false)} />}
      {showCamera && (
        <CameraCapture
          onCapture={(file) => attachMedia(file)}
          onClose={() => setShowCamera(false)}
        />
      )}
      {busy && (
        <div className="gen-overlay">
          <Spark size={72} mood="thinking" />
          <div className="gen-text">{t("capture.writing")}</div>
          <div className="gen-sub">X · Facebook · TikTok · Snapchat · Instagram · LinkedIn</div>
        </div>
      )}

      <div className="header">
        <h1>
          <span className="eyebrow">Brand Studio</span>
          {t("capture.title")}
        </h1>
        {streak > 1 ? (
          <span className="streak-chip">
            <FlameIcon size={15} />
            {t("capture.streak", { n: streak })}
          </span>
        ) : (
          <span className="sub">{t("capture.sub")} · v2.8.1</span>
        )}
      </div>

      {showChecklist && (
        <Checklist
          hasBrand={Boolean(profile?.goals?.trim() || profile?.brand_voice?.trim())}
          hasDraft={draftCount > 0 || ideas.some((i) => i.status === "drafted")}
          onDismiss={() => {
            dismissChecklist();
            setShowChecklist(false);
          }}
        />
      )}

      {!configured && (
        <div className="card welcome">
          <div className="welcome-hero">
            <Spark size={58} mood="excited" />
          </div>
          <div className="card-title">{t("capture.welcomeTitle")}</div>
          <p className="card-desc">{t("capture.welcomeBody")}</p>
          <ol className="welcome-steps">
            <li>{t("Create your free account")}</li>
            <li>{t("Tell it about your brand (goals, voice)")}</li>
            <li>{t("Tap the mic and start capturing")}</li>
          </ol>
          <Link to="/setup" className="btn primary block" style={{ textDecoration: "none" }}>
            {t("capture.welcomeCta")}
          </Link>
        </div>
      )}
      {error && <div className="banner error">{error}</div>}

      <div className="capture-main">
        <div className="mic-wrap">
          <div className={`mic-stage ${listening ? "live" : ""}`}>
            <span className="mic-ring" />
            <span className="mic-ring" />
            <span className="mic-ring" />
            <button
              className={`mic ${listening ? "listening" : ""}`}
              data-tour="mic"
              onClick={toggleMic}
              aria-label={listening ? t("Stop listening") : t("Start listening")}
            >
              {listening ? <StopIcon size={44} /> : <MicIcon size={52} />}
            </button>
          </div>
          <span className={`mic-hint ${listening ? "live" : ""}`}>
            {listening ? (
              <>
                <span className="wave" aria-hidden="true">
                  <i /><i /><i /><i /><i />
                </span>
                {t("capture.listening")}
              </>
            ) : (
              t("capture.tapMic")
            )}
          </span>
        </div>

        <textarea
          rows={4}
          placeholder={t("capture.placeholder")}
          value={interim ? `${text} ${interim}`.trim() : text}
          onChange={(e) => setText(e.target.value)}
        />

        <input
          ref={fileInput}
          type="file"
          accept="image/*,video/*"
          style={{ display: "none" }}
          onChange={(e) => attachMedia(e.target.files?.[0])}
        />
        {mediaUrl ? (
          <div className="media-preview">
            {mediaMime.startsWith("video/") ? (
              <video src={mediaUrl} controls playsInline muted />
            ) : (
              <img src={mediaUrl} alt="Attached media" />
            )}
            <button
              className="btn ghost sm"
              onClick={() => {
                setMediaUrl("");
                setMediaMime("");
              }}
            >
              <XCircleIcon size={15} />
              {t("Remove")}
            </button>
          </div>
        ) : (
          configured && (
            <div className="row" style={{ marginTop: 8, gap: 8 }}>
              <button className="btn ghost sm" onClick={() => setShowCamera(true)} disabled={uploading}>
                <CameraIcon size={16} />
                {uploading ? t("Uploading…") : t("Camera")}
              </button>
              <button className="btn ghost sm" onClick={() => fileInput.current?.click()} disabled={uploading}>
                <ImageIcon size={16} />
                {t("Upload")}
              </button>
            </div>
          )
        )}

        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn outline block" onClick={saveIdea} disabled={!text.trim() || busy}>
            {t("capture.saveIdea")}
          </button>
          <button className="btn primary block" onClick={() => draftNow(text)} disabled={!text.trim() || busy}>
            <SparkIcon size={17} />
            {t("capture.draftNow")}
          </button>
        </div>
      </div>

      {configured && (
        <Link to="/insights" className="insights-link">
          <BulbIcon size={16} />
          <span>
            <b>{t("Content gaps this week")}</b>
            <span className="muted small" style={{ display: "block" }}>
              {t("Find topics people search for that nobody covers")}
            </span>
          </span>
        </Link>
      )}

      {openIdeas.length > 0 && (
        <>
          <div className="day-title">{t("Idea backlog · {n}", { n: openIdeas.length })}</div>
          {openIdeas.map((idea) => (
            <div className="card" key={idea.id}>
              <div style={{ marginBottom: 12, lineHeight: 1.5 }}>{idea.text}</div>
              <div className="row between">
                <button className="btn primary sm" onClick={() => draftNow(idea.text, idea.id)} disabled={busy}>
                  <SparkIcon size={15} />
                  {t("Draft this")}
                </button>
                <button
                  className="btn ghost danger icon-only"
                  aria-label={t("Delete idea")}
                  onClick={async () => {
                    await api.deleteIdea(idea.id);
                    loadIdeas();
                  }}
                >
                  <TrashIcon size={17} />
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {draftedIdeas.length > 0 && (
        <>
          <div className="day-title">{t("Already drafted · {n}", { n: draftedIdeas.length })}</div>
          {draftedIdeas.map((idea) => (
            <div className="card" key={idea.id} style={{ opacity: 0.6 }}>
              <div className="row between">
                <span className="small" style={{ flex: 1 }}>{idea.text}</span>
                <button
                  className="btn ghost danger icon-only"
                  aria-label={t("Delete idea")}
                  onClick={async () => {
                    await api.deleteIdea(idea.id);
                    loadIdeas();
                  }}
                >
                  <TrashIcon size={16} />
                </button>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
