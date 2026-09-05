import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, isConfigured } from "../lib/api";
import { useToast } from "../lib/toast";
import { DumbbellIcon, FlameIcon, MicIcon, SparkIcon, StopIcon, TrashIcon } from "../lib/icons";
import { startlistening, isVoiceSupported, type VoiceController } from "../lib/voice";
import { dictationLocale } from "../lib/languages";
import type { Workout } from "../lib/types";
import Spark from "../lib/Spark";
import { useT } from "../lib/i18n";

function formatDate(iso: string, t: (s: string) => string): string {
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  const today = new Date();
  const diff = Math.floor((today.setHours(0, 0, 0, 0) - d.getTime()) / 86400000);
  if (diff === 0) return t("Today");
  if (diff === 1) return t("Yesterday");
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Consecutive days trained, counting back from today or yesterday.
function computeStreak(workouts: Workout[]): number {
  const days = new Set(workouts.map((w) => w.date));
  let streak = 0;
  const cursor = new Date();
  if (!days.has(localToday())) cursor.setDate(cursor.getDate() - 1);
  for (;;) {
    const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(
      cursor.getDate()
    ).padStart(2, "0")}`;
    if (!days.has(iso)) break;
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export default function Workouts() {
  const toast = useToast();
  const t = useT();
  const navigate = useNavigate();
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [desc, setDesc] = useState("");
  const [date, setDate] = useState(localToday());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Workout | null>(null);
  const [editText, setEditText] = useState("");
  const [listening, setListening] = useState(false);
  const [speechLang, setSpeechLang] = useState(() => dictationLocale());
  const voice = useRef<VoiceController | null>(null);
  const baseText = useRef("");
  const configured = isConfigured();

  useEffect(() => {
    if (configured) {
      load();
      api
        .getProfile()
        .then((p) => setSpeechLang(dictationLocale(p.traits?.preferred_language)))
        .catch(() => {});
    } else setLoading(false);
    return () => voice.current?.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    try {
      setWorkouts(await api.getWorkouts());
      setError("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function toggleMic() {
    if (listening) {
      voice.current?.stop();
      setListening(false);
      return;
    }
    baseText.current = desc ? desc.trim() + " " : "";
    voice.current = startlistening(
      {
        onTranscript: (finalText, interim) => {
          setDesc((baseText.current + finalText + (interim ? " " + interim : "")).trim());
        },
        onError: (m) => {
          toast(m);
          setListening(false);
        },
        onEnd: () => setListening(false),
      },
      { lang: speechLang }
    );
    setListening(true);
  }

  async function add() {
    if (!desc.trim()) return;
    voice.current?.stop();
    setListening(false);
    try {
      await api.addWorkout(desc.trim(), date);
      setDesc("");
      setDate(localToday());
      toast(t("Workout logged"));
      load();
    } catch (e: any) {
      toast(e.message);
    }
  }

  async function saveEdit() {
    if (!editing || !editText.trim()) return;
    try {
      await api.updateWorkout(editing.id, { description: editText.trim() });
      toast(t("Updated"));
      setEditing(null);
      load();
    } catch (e: any) {
      toast(e.message);
    }
  }

  async function toContent(w: Workout) {
    setBusy(true);
    try {
      const topic = t("Today's workout, turned into motivating fitness content: {desc}", { desc: w.description });
      const draft = await api.generate({ topic });
      navigate(`/drafts?focus=${draft.id}`);
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  }

  const streak = computeStreak(workouts);

  return (
    <div className="screen">
      {busy && (
        <div className="gen-overlay">
          <div className="orb" />
          <div className="gen-text">{t("Turning sweat into content…")}</div>
          <div className="gen-sub">X · Facebook · TikTok · Snapchat · Instagram · LinkedIn</div>
        </div>
      )}

      <div className="header">
        <h1>
          <span className="eyebrow">{t("Optional module")}</span>
          {t("Workouts")}
        </h1>
        <Link to="/setup" className="btn ghost sm" style={{ textDecoration: "none" }}>
          {t("Setup")}
        </Link>
        {streak > 0 ? (
          <span className="streak-chip">
            <FlameIcon size={15} />
            {t("{n}-day streak", { n: streak })}
          </span>
        ) : (
          <span className="sub">{t("train + create")}</span>
        )}
      </div>

      {!configured && <div className="banner warn">{t("Sign in on the Setup tab to log workouts.")}</div>}
      {error && <div className="banner error">{error}</div>}

      <div className="card">
        <div className="card-title">
          <DumbbellIcon size={18} />
          {t("Log a session")}
        </div>
        <textarea
          rows={3}
          placeholder={t("e.g. Push day — bench 4x8, incline DBs, dips. Felt strong, new PB on bench.")}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          style={{ marginTop: 8 }}
        />
        <div className="row" style={{ marginTop: 10, gap: 10 }}>
          <input type="date" value={date} max={localToday()} onChange={(e) => setDate(e.target.value)} style={{ flex: 1 }} />
          {isVoiceSupported() && (
            <button
              className={`btn sm ${listening ? "danger" : "ghost"}`}
              onClick={toggleMic}
              aria-label={listening ? t("Stop dictating") : t("Dictate workout")}
            >
              {listening ? <StopIcon size={16} /> : <MicIcon size={16} />}
              {listening ? t("Stop") : t("Speak")}
            </button>
          )}
        </div>
        <button className="btn primary block" style={{ marginTop: 12 }} onClick={add} disabled={!desc.trim()}>
          {t("Log workout")}
        </button>
      </div>

      {loading && configured && (
        <>
          <div className="skeleton" style={{ height: 90 }} />
          <div className="skeleton" style={{ height: 90 }} />
        </>
      )}

      {!loading && configured && workouts.length === 0 && !error && (
        <div className="empty-spark">
          <Spark size={64} mood="sleepy" />
          <b>{t("No workouts logged")}</b>
          <p>{t("Log a session above — every workout can become content with one tap.")}</p>
        </div>
      )}

      {workouts.map((w) => (
        <div className="card" key={w.id}>
          <div className="row between" style={{ marginBottom: 8 }}>
            <span className="chip workout">{formatDate(w.date, t)}</span>
          </div>
          {editing?.id === w.id ? (
            <>
              <textarea rows={3} value={editText} onChange={(e) => setEditText(e.target.value)} autoFocus />
              <div className="row" style={{ marginTop: 10, gap: 10 }}>
                <button className="btn ghost sm" onClick={() => setEditing(null)}>
                  {t("Cancel")}
                </button>
                <button className="btn primary sm block" onClick={saveEdit} disabled={!editText.trim()}>
                  {t("Save")}
                </button>
              </div>
            </>
          ) : (
            <>
              <button
                className="workout-text"
                onClick={() => {
                  setEditing(w);
                  setEditText(w.description);
                }}
              >
                {w.description}
              </button>
              <div className="row between">
                <button className="btn primary sm" onClick={() => toContent(w)} disabled={busy}>
                  <SparkIcon size={15} />
                  {t("Turn into content")}
                </button>
                <button
                  className="btn ghost danger icon-only"
                  aria-label={t("Delete workout")}
                  onClick={async () => {
                    await api.deleteWorkout(w.id);
                    toast(t("Deleted"));
                    load();
                  }}
                >
                  <TrashIcon size={17} />
                </button>
              </div>
            </>
          )}
        </div>
      ))}
      {!loading && workouts.length > 0 && (
        <p className="muted small" style={{ textAlign: "center" }}>
          {t("Tap a workout's text to edit it")}
        </p>
      )}
    </div>
  );
}
