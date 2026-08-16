import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, isConfigured } from "../lib/api";
import { useToast } from "../lib/toast";
import { CheckIcon, ClockIcon, PenIcon, PlusIcon, TrashIcon } from "../lib/icons";
import Spark from "../lib/Spark";
import {
  PLATFORMS,
  PLATFORM_LABELS,
  type Draft,
  type Platform,
  type ScheduleBlock,
  type ScheduledPost,
} from "../lib/types";
import { useT } from "../lib/i18n";
import {
  addReminder,
  cancelReminder,
  ensureNotifyPermission,
  listReminders,
  type PostReminder,
} from "../lib/postReminders";

const DAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const CATEGORIES: { id: string; label: string }[] = [
  { id: "content", label: "Content" },
  { id: "light", label: "Light" },
  { id: "dev", label: "Deep work" },
  { id: "review", label: "Review" },
  { id: "meetup", label: "Meetup" },
  { id: "family", label: "Life" },
  { id: "rest", label: "Rest" },
];

const TIME_PRESETS = [
  { label: "Morning", start: "09:00", end: "10:30" },
  { label: "Midday", start: "12:00", end: "13:00" },
  { label: "Afternoon", start: "14:00", end: "15:30" },
  { label: "Evening", start: "18:00", end: "19:00" },
];

type View = "daily" | "content";

type EditorState = {
  id?: number;
  weekday: number;
  start_time: string;
  end_time: string;
  title: string;
  category: string;
};

type ContentForm = {
  draftId: number;
  platform: Platform;
  scheduledAt: string;
};

const STARTER_WEEK: Omit<EditorState, "id">[] = [
  { weekday: 1, start_time: "09:00", end_time: "10:30", title: "Film / capture content", category: "content" },
  { weekday: 1, start_time: "16:00", end_time: "16:45", title: "Edit & queue posts", category: "content" },
  { weekday: 2, start_time: "09:00", end_time: "10:00", title: "Reply & engage", category: "light" },
  { weekday: 3, start_time: "09:00", end_time: "10:30", title: "Film / capture content", category: "content" },
  { weekday: 4, start_time: "14:00", end_time: "15:00", title: "Plan next week's topics", category: "review" },
  { weekday: 5, start_time: "09:00", end_time: "10:30", title: "Film / capture content", category: "content" },
  { weekday: 5, start_time: "16:00", end_time: "16:30", title: "Schedule weekend posts", category: "content" },
];

function todayWeekday(): number {
  const d = new Date().getDay();
  return d === 0 ? 7 : d;
}

function catLabel(id: string, t: (s: string) => string) {
  return t(CATEGORIES.find((c) => c.id === id)?.label || id);
}

function defaultScheduleAt(): string {
  const t = new Date(Date.now() + 24 * 3600e3);
  t.setHours(9, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function weekdayOf(iso: string): number {
  const d = new Date(iso).getDay();
  return d === 0 ? 7 : d;
}

function platformsForDraft(d: Draft): Platform[] {
  return PLATFORMS.filter((p) => (d.variants[p] || "").trim());
}

function previewFor(d: Draft, platform: Platform): string {
  return (d.variants[platform] || "").trim().slice(0, 140);
}

export default function Schedule() {
  const toast = useToast();
  const t = useT();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const initialView: View = params.get("view") === "content" || params.get("view") === "posts" ? "content" : "daily";

  const [blocks, setBlocks] = useState<ScheduleBlock[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledPost[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [view, setView] = useState<View>(initialView);
  const [focusDay, setFocusDay] = useState(todayWeekday);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [contentForm, setContentForm] = useState<ContentForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [reminders, setReminders] = useState<PostReminder[]>(() => listReminders());
  const configured = isConfigured();
  const today = todayWeekday();

  useEffect(() => {
    if (configured) load();
    else setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const refresh = () => setReminders(listReminders());
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("post-reminders-changed", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("post-reminders-changed", refresh);
    };
  }, []);

  useEffect(() => {
    const v = params.get("view");
    if (v === "content" || v === "posts") setView("content");
    if (v === "daily" || v === "week") setView("daily");
  }, [params]);

  function switchView(next: View) {
    setView(next);
    setParams(next === "content" ? { view: "content" } : {}, { replace: true });
  }

  async function load() {
    try {
      const [sched, queue, draftRows] = await Promise.all([
        api.getSchedule(),
        api.getScheduledPosts().catch(() => [] as ScheduledPost[]),
        api.getDrafts().catch(() => [] as Draft[]),
      ]);
      setBlocks(sched);
      setScheduled(queue);
      setDrafts(draftRows);
      setReminders(listReminders());
      setError("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const schedulableDrafts = useMemo(
    () => drafts.filter((d) => d.status !== "posted" && platformsForDraft(d).length > 0),
    [drafts]
  );

  const upcomingReminders = reminders.length;
  const upcoming = scheduled.filter((s) => s.status === "scheduled" || s.status === "publishing").length + upcomingReminders;
  const dayContent = scheduled.filter(
    (sp) =>
      (sp.status === "scheduled" || sp.status === "failed" || sp.status === "publishing") &&
      weekdayOf(sp.scheduled_at) === focusDay
  );
  const dayReminders = reminders.filter((r) => weekdayOf(r.scheduledAt) === focusDay);

  async function toggle(b: ScheduleBlock) {
    setBlocks((prev) => prev.map((x) => (x.id === b.id ? { ...x, done: x.done ? 0 : 1 } : x)));
    try {
      await api.toggleBlock(b.id, !b.done);
    } catch (e: any) {
      toast(e.message);
      load();
    }
  }

  async function reset() {
    if (!confirmReset) {
      setConfirmReset(true);
      window.setTimeout(() => setConfirmReset(false), 3000);
      return;
    }
    setConfirmReset(false);
    await api.resetSchedule();
    toast(t("Checks cleared — fresh week"));
    load();
  }

  async function clearAll() {
    if (!confirmClear) {
      setConfirmClear(true);
      window.setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    setConfirmClear(false);
    await api.clearSchedule();
    toast(t("Week cleared — add new blocks anytime"));
    load();
  }

  async function seedStarter() {
    setSeeding(true);
    try {
      for (const b of STARTER_WEEK) {
        await api.addBlock({ ...b, title: t(b.title) });
      }
      toast(t("Starter week added — tap any block to edit"));
      setFocusDay(today);
      load();
    } catch (e: any) {
      toast(e.message);
    } finally {
      setSeeding(false);
    }
  }

  function openNew(weekday = focusDay) {
    setEditor({
      weekday,
      start_time: "09:00",
      end_time: "10:00",
      title: "",
      category: "content",
    });
  }

  function openEdit(b: ScheduleBlock) {
    setEditor({
      id: b.id,
      weekday: b.weekday,
      start_time: b.start_time,
      end_time: b.end_time,
      title: b.title,
      category: b.category,
    });
  }

  function openContentScheduler(draft?: Draft) {
    if (!configured) {
      toast(t("Sign in on the Setup tab to manage your schedule."));
      navigate("/setup");
      return;
    }
    const d = draft || schedulableDrafts[0];
    if (!d) {
      toast(t("Create a draft first, then come back to schedule it"));
      navigate("/capture");
      return;
    }
    const plats = platformsForDraft(d);
    setContentForm({
      draftId: d.id,
      platform: plats[0],
      scheduledAt: defaultScheduleAt(),
    });
  }

  async function saveEditor() {
    if (!editor || !editor.title.trim()) return;
    setSaving(true);
    try {
      if (editor.id) {
        await api.updateBlock(editor.id, {
          title: editor.title.trim(),
          start_time: editor.start_time,
          end_time: editor.end_time,
          category: editor.category,
          weekday: editor.weekday,
        });
        toast(t("Saved"));
        setFocusDay(editor.weekday);
      } else {
        await api.addBlock({
          weekday: editor.weekday,
          start_time: editor.start_time,
          end_time: editor.end_time,
          title: editor.title.trim(),
          category: editor.category,
        });
        toast(t("Block added"));
        setFocusDay(editor.weekday);
      }
      setEditor(null);
      load();
    } catch (e: any) {
      toast(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function deleteBlock() {
    if (!editor?.id) return;
    setSaving(true);
    try {
      await api.deleteBlock(editor.id);
      toast(t("Removed"));
      setEditor(null);
      load();
    } catch (e: any) {
      toast(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveContentSchedule() {
    if (!contentForm) return;
    const draft = schedulableDrafts.find((d) => d.id === contentForm.draftId);
    if (!draft) return;
    setSaving(true);
    try {
      await ensureNotifyPermission();
      addReminder({
        draftId: draft.id,
        platform: contentForm.platform,
        scheduledAt: contentForm.scheduledAt,
        topic: draft.topic || `Draft #${draft.id}`,
        preview: previewFor(draft, contentForm.platform),
      });
      setReminders(listReminders());
      toast(t("Reminder set — we'll nudge you to Share at that time"));
      setContentForm(null);
      switchView("content");
    } catch (e: any) {
      toast(e.message);
    } finally {
      setSaving(false);
    }
  }

  function removeReminder(id: string) {
    cancelReminder(id);
    setReminders(listReminders());
    toast(t("Cancelled"));
  }

  async function cancelScheduled(sp: ScheduledPost) {
    try {
      await api.cancelScheduledPost(sp.id);
      toast(t("Cancelled"));
      setScheduled((prev) => prev.filter((x) => x.id !== sp.id));
    } catch (e: any) {
      toast(e.message);
    }
  }

  async function retryScheduled(sp: ScheduledPost) {
    try {
      const updated = await api.retryScheduledPost(sp.id);
      setScheduled((prev) => prev.map((x) => (x.id === sp.id ? updated : x)));
      toast(t("Queued again — it'll post soon"));
    } catch (e: any) {
      toast(e.message);
    }
  }

  const byDay = (wd: number) =>
    blocks.filter((b) => b.weekday === wd).sort((a, b) => a.start_time.localeCompare(b.start_time));
  const focusBlocks = byDay(focusDay);
  const focusDone = focusBlocks.filter((b) => b.done).length;
  const focusPct = focusBlocks.length ? Math.round((focusDone / focusBlocks.length) * 100) : 0;
  const emptyWeek = !loading && configured && blocks.length === 0;
  const selectedDraft = contentForm ? drafts.find((d) => d.id === contentForm.draftId) : null;
  const formPlatforms = selectedDraft ? platformsForDraft(selectedDraft) : [];

  return (
    <div className="screen">
      {editor && (
        <div className="sheet-overlay" onClick={() => !saving && setEditor(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{editor.id ? t("Edit daily block") : t("Add daily block")}</div>
            <label>{t("What are you doing?")}</label>
            <input
              value={editor.title}
              placeholder={t("e.g. Film 2 short clips")}
              onChange={(e) => setEditor({ ...editor, title: e.target.value })}
              autoFocus
            />
            <label>{t("Day")}</label>
            <div className="chip-row">
              {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`chip-btn ${editor.weekday === d ? "on" : ""}`}
                  onClick={() => setEditor({ ...editor, weekday: d })}
                >
                  {t(DAY_SHORT[d])}
                </button>
              ))}
            </div>
            <label>{t("Quick time")}</label>
            <div className="chip-row">
              {TIME_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className={`chip-btn ${editor.start_time === p.start && editor.end_time === p.end ? "on" : ""}`}
                  onClick={() => setEditor({ ...editor, start_time: p.start, end_time: p.end })}
                >
                  {t(p.label)}
                </button>
              ))}
            </div>
            <div className="row" style={{ gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label>{t("Start")}</label>
                <input
                  type="time"
                  value={editor.start_time}
                  onChange={(e) => setEditor({ ...editor, start_time: e.target.value })}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label>{t("End")}</label>
                <input
                  type="time"
                  value={editor.end_time}
                  onChange={(e) => setEditor({ ...editor, end_time: e.target.value })}
                />
              </div>
            </div>
            <label>{t("Type")}</label>
            <div className="chip-row">
              {CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`chip-btn ${editor.category === c.id ? "on" : ""}`}
                  onClick={() => setEditor({ ...editor, category: c.id })}
                >
                  {t(c.label)}
                </button>
              ))}
            </div>
            <div className="row" style={{ marginTop: 16, gap: 10 }}>
              {editor.id && (
                <button type="button" className="btn ghost danger" onClick={deleteBlock} disabled={saving}>
                  <TrashIcon size={16} />
                  {t("Delete")}
                </button>
              )}
              <button
                type="button"
                className="btn primary block"
                onClick={saveEditor}
                disabled={saving || !editor.title.trim()}
              >
                {saving ? t("Saving…") : editor.id ? t("Save") : t("Add to week")}
              </button>
            </div>
          </div>
        </div>
      )}

      {contentForm && (
        <div className="sheet-overlay" onClick={() => !saving && setContentForm(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{t("Plan a Share reminder")}</div>
            <p className="card-desc" style={{ marginTop: 0 }}>
              {t("Pick a draft, platform, and time. We'll remind you to Share — auto-post when account linking is ready.")}
            </p>
            <label>{t("Draft")}</label>
            {schedulableDrafts.length === 0 ? (
              <div className="banner warn">
                {t("No drafts ready to schedule.")}{" "}
                <Link to="/capture" style={{ color: "var(--lime)" }}>
                  {t("Capture one")}
                </Link>{" "}
                {t("first.")}
              </div>
            ) : (
              <div className="content-draft-list">
                {schedulableDrafts.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className={`content-draft-pick ${contentForm.draftId === d.id ? "on" : ""}`}
                    onClick={() => {
                      const plats = platformsForDraft(d);
                      setContentForm({
                        ...contentForm,
                        draftId: d.id,
                        platform: plats.includes(contentForm.platform) ? contentForm.platform : plats[0],
                      });
                    }}
                  >
                    <b>{d.topic || t("Draft #{id}", { id: d.id })}</b>
                    <span className="muted small">
                      {platformsForDraft(d)
                        .map((p) => PLATFORM_LABELS[p])
                        .join(" · ")}
                      {d.media_url ? " · " + t("has media") : ""}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {selectedDraft && (
              <>
                <label>{t("Platform")}</label>
                <div className="chip-row">
                  {formPlatforms.map((p) => (
                    <button
                      key={p}
                      type="button"
                      className={`chip-btn ${contentForm.platform === p ? "on" : ""}`}
                      onClick={() => setContentForm({ ...contentForm, platform: p })}
                    >
                      {PLATFORM_LABELS[p]}
                    </button>
                  ))}
                </div>
                <div className="content-preview">
                  {previewFor(selectedDraft, contentForm.platform) || t("No caption for this platform.")}
                </div>
                <label>{t("Post at")}</label>
                <input
                  type="datetime-local"
                  value={contentForm.scheduledAt}
                  onChange={(e) => setContentForm({ ...contentForm, scheduledAt: e.target.value })}
                />
              </>
            )}
            <button
              type="button"
              className="btn primary block"
              style={{ marginTop: 14 }}
              onClick={saveContentSchedule}
              disabled={saving || !selectedDraft || !contentForm.scheduledAt}
            >
              <ClockIcon size={16} />
              {saving ? t("Saving…") : t("Set reminder")}
            </button>
          </div>
        </div>
      )}

      <div className="header">
        <h1>
          <span className="eyebrow">{t("schedule.eyebrow")}</span>
          {t("schedule.title")}
        </h1>
        {configured && view === "daily" && blocks.length > 0 && (
          <button type="button" className="btn primary sm" onClick={() => openNew()}>
            <PlusIcon size={15} />
            {t("schedule.add")}
          </button>
        )}
        {configured && view === "content" && (
          <button type="button" className="btn primary sm" onClick={() => openContentScheduler()}>
            <ClockIcon size={15} />
            {t("schedule.queue")}
          </button>
        )}
      </div>

      {!configured && <div className="banner warn">{t("schedule.signIn")}</div>}
      {error && <div className="banner error">{error}</div>}

      {configured && (
        <div className="seg-row">
          <button type="button" className={`seg ${view === "daily" ? "on" : ""}`} onClick={() => switchView("daily")}>
            {t("schedule.daily")}
          </button>
          <button
            type="button"
            className={`seg ${view === "content" ? "on" : ""}`}
            onClick={() => switchView("content")}
          >
            {t("schedule.content")}{upcoming ? ` · ${upcoming}` : ""}
          </button>
        </div>
      )}

      {loading && configured && (
        <>
          <div className="skeleton" style={{ height: 56 }} />
          <div className="skeleton" style={{ height: 84 }} />
          <div className="skeleton" style={{ height: 56 }} />
        </>
      )}

      {view === "daily" && !loading && configured && (
        <>
          {emptyWeek ? (
            <div className="empty-spark">
              <Spark size={64} mood="happy" />
              <b>{t("Build your daily rhythm")}</b>
              <p>
                {t("Plan filming, editing, and posting blocks for each day — separate from queuing drafts to go live.")}
              </p>
              <button type="button" className="btn primary block" onClick={seedStarter} disabled={seeding}>
                {seeding ? t("Adding…") : t("Use starter week")}
              </button>
              <button type="button" className="btn ghost block" style={{ marginTop: 8 }} onClick={() => openNew(today)}>
                <PlusIcon size={15} />
                {t("Add my first block")}
              </button>
              <button
                type="button"
                className="btn ghost block"
                style={{ marginTop: 8 }}
                onClick={() => switchView("content")}
              >
                <ClockIcon size={15} />
                {t("Or plan when a draft should go live")}
              </button>
            </div>
          ) : (
            <>
              <div className="day-strip" role="tablist" aria-label={t("Days of the week")}>
                {[1, 2, 3, 4, 5, 6, 7].map((d) => {
                  const n = byDay(d).length;
                  const done = byDay(d).filter((b) => b.done).length;
                  const postsN =
                    scheduled.filter(
                      (sp) => sp.status === "scheduled" && weekdayOf(sp.scheduled_at) === d
                    ).length + reminders.filter((r) => weekdayOf(r.scheduledAt) === d).length;
                  return (
                    <button
                      key={d}
                      type="button"
                      role="tab"
                      aria-selected={focusDay === d}
                      className={`day-pill ${focusDay === d ? "on" : ""} ${d === today ? "is-today" : ""}`}
                      onClick={() => setFocusDay(d)}
                    >
                      <span className="day-pill-name">{t(DAY_SHORT[d])}</span>
                      <span className="day-pill-count">
                        {n ? `${done}/${n}` : "—"}
                        {postsN ? ` · ${postsN}` : ""}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="card progress-card">
                <div className="row between">
                  <b>
                    {focusDay === today ? t("Today") : t(DAY_NAMES[focusDay])}
                    {focusDay === today ? ` · ${t(DAY_NAMES[focusDay])}` : ""}
                  </b>
                  <span className="muted small">
                    {focusBlocks.length ? t("{done}/{total} done", { done: focusDone, total: focusBlocks.length }) : t("No blocks yet")}
                  </span>
                </div>
                {focusBlocks.length > 0 && (
                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: `${focusPct}%` }} />
                  </div>
                )}
              </div>

              <p className="section-label">{t("Daily plan")}</p>
              {focusBlocks.map((b) => (
                <div className={`block sched-block ${b.done ? "done" : ""}`} key={b.id}>
                  <button
                    type="button"
                    className={`check ${b.done ? "on" : ""}`}
                    onClick={() => toggle(b)}
                    aria-label={b.done ? t("Mark not done") : t("Mark done")}
                  >
                    <CheckIcon size={16} />
                  </button>
                  <button type="button" className="sched-block-main" onClick={() => openEdit(b)}>
                    <span className="time">
                      {b.start_time} – {b.end_time}
                    </span>
                    <span className="title-text">{b.title}</span>
                    <span className={`chip ${b.category}`}>{catLabel(b.category, t)}</span>
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm icon-only"
                    aria-label={t("Edit block")}
                    onClick={() => openEdit(b)}
                  >
                    <PenIcon size={16} />
                  </button>
                </div>
              ))}

              {focusBlocks.length === 0 && (
                <div className="banner warn" style={{ textAlign: "center" }}>
                  {t("Nothing planned for {day}. Add a block or jump to another day.", { day: t(DAY_NAMES[focusDay]) })}
                </div>
              )}

              {(dayContent.length > 0 || dayReminders.length > 0) && (
                <>
                  <p className="section-label">{t("Share reminders")}</p>
                  {dayReminders.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className="card sched-post sched-post-mini"
                      onClick={() => switchView("content")}
                    >
                      <div className="row between">
                        <span>
                          <i className="sdot scheduled" />
                          <b>{r.topic || t("Draft #{id}", { id: r.draftId })}</b>
                        </span>
                        <span className="muted small">{PLATFORM_LABELS[r.platform]}</span>
                      </div>
                      <div className="muted small" style={{ marginTop: 4 }}>
                        {formatWhen(r.scheduledAt)} · {t("reminder")}
                      </div>
                    </button>
                  ))}
                  {dayContent.map((sp) => (
                    <button
                      key={sp.id}
                      type="button"
                      className="card sched-post sched-post-mini"
                      onClick={() => switchView("content")}
                    >
                      <div className="row between">
                        <span>
                          <i className={`sdot ${sp.status === "publishing" ? "scheduled" : sp.status}`} />
                          <b>{sp.draft_topic || t("Draft #{id}", { id: sp.draft_id })}</b>
                        </span>
                        <span className="muted small">{PLATFORM_LABELS[sp.platform]}</span>
                      </div>
                      <div className="muted small" style={{ marginTop: 4 }}>
                        {formatWhen(sp.scheduled_at)}
                      </div>
                    </button>
                  ))}
                </>
              )}

              <button
                type="button"
                className="btn primary block"
                style={{ marginTop: 8 }}
                onClick={() => openNew(focusDay)}
              >
                <PlusIcon size={16} />
                {t("Add to {day}", { day: focusDay === today ? t("today") : t(DAY_SHORT[focusDay]) })}
              </button>
              <button
                type="button"
                className="btn ghost block"
                style={{ marginTop: 8 }}
                onClick={() => openContentScheduler()}
              >
                <ClockIcon size={16} />
                {t("Set a Share reminder")}
              </button>

              <div className="row" style={{ marginTop: 14, gap: 8 }}>
                <button type="button" className="btn ghost sm block" onClick={reset}>
                  {confirmReset ? t("Tap again to clear checks") : t("Clear checks")}
                </button>
                <button type="button" className="btn ghost danger sm block" onClick={clearAll}>
                  {confirmClear ? t("Tap again to delete all") : t("Clear week")}
                </button>
              </div>
            </>
          )}
        </>
      )}

      {view === "content" && !loading && configured && (
        <>
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="card-title">
              <ClockIcon size={18} />
              {t("Share reminders")}
            </div>
            <p className="card-desc">
              {t("Plan when a draft should go live. We'll pop up a reminder to Share — official auto-post is coming soon.")}
            </p>
            <button type="button" className="btn primary block" onClick={() => openContentScheduler()}>
              <PlusIcon size={16} />
              {t("Plan a Share reminder")}
            </button>
            {schedulableDrafts.length === 0 && (
              <p className="muted small" style={{ marginTop: 10, textAlign: "center" }}>
                {t("No drafts yet —")} <Link to="/capture">{t("capture an idea")}</Link> {t("or open")}{" "}
                <Link to="/drafts">{t("Drafts")}</Link>.
              </p>
            )}
          </div>

          <div className="dot-legend">
            <span>
              <i className="sdot scheduled" /> {t("reminder")}
            </span>
            <span>
              <i className="sdot posted" /> {t("posted")}
            </span>
            <span>
              <i className="sdot failed" /> {t("failed")}
            </span>
          </div>

          {reminders.length === 0 && scheduled.length === 0 && (
            <div className="empty-spark">
              <Spark size={56} mood="thinking" />
              <b>{t("No Share reminders yet")}</b>
              <p>{t("Pick a draft above — we'll nudge you when it's time to post.")}</p>
            </div>
          )}

          {reminders.map((r) => (
            <div className="card sched-post" key={r.id}>
              <div className="row between" style={{ alignItems: "flex-start", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 8, alignItems: "center" }}>
                    <i className="sdot scheduled" />
                    <b className="sched-post-topic">{r.topic || t("Draft #{id}", { id: r.draftId })}</b>
                  </div>
                  <div className="muted small" style={{ marginTop: 4 }}>
                    {PLATFORM_LABELS[r.platform] || r.platform} · {formatWhen(r.scheduledAt)} · {t("Share reminder")}
                  </div>
                  {r.preview && <p className="sched-post-preview">{r.preview}</p>}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "stretch" }}>
                  <button type="button" className="btn ghost sm" onClick={() => removeReminder(r.id)}>
                    {t("Cancel")}
                  </button>
                  <Link className="btn ghost sm" to={`/drafts?focus=${r.draftId}`}>
                    {t("Open")}
                  </Link>
                </div>
              </div>
            </div>
          ))}

          {scheduled.map((sp) => (
            <div className="card sched-post" key={sp.id}>
              <div className="row between" style={{ alignItems: "flex-start", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 8, alignItems: "center" }}>
                    <i className={`sdot ${sp.status === "publishing" ? "scheduled" : sp.status}`} />
                    <b className="sched-post-topic">{sp.draft_topic || t("Draft #{id}", { id: sp.draft_id })}</b>
                  </div>
                  <div className="muted small" style={{ marginTop: 4 }}>
                    {PLATFORM_LABELS[sp.platform] || sp.platform} · {formatWhen(sp.scheduled_at)}
                  </div>
                  {sp.draft_preview && <p className="sched-post-preview">{sp.draft_preview}</p>}
                  {sp.draft_media_url && <span className="chip content">{t("Has media")}</span>}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "stretch" }}>
                  {sp.status === "scheduled" && (
                    <button type="button" className="btn ghost sm" onClick={() => cancelScheduled(sp)}>
                      {t("Cancel")}
                    </button>
                  )}
                  {sp.status === "failed" && (
                    <button type="button" className="btn primary sm" onClick={() => retryScheduled(sp)}>
                      {t("Retry")}
                    </button>
                  )}
                  <Link className="btn ghost sm" to={`/drafts?focus=${sp.draft_id}`}>
                    {t("Open")}
                  </Link>
                </div>
              </div>
              {sp.status === "failed" && sp.error && (
                <div className="muted small" style={{ marginTop: 6, color: "var(--danger)" }}>
                  {sp.error}
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
