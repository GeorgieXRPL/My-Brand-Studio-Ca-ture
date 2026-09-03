import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  clearHubConfig,
  getAuthEmail,
  getHubUrl,
  isConfigured,
  setAuth,
} from "../lib/api";
import { agentInstructions } from "../lib/agentBrief";
import { withBrandTag } from "../lib/attribution";
import { normalizeEnabledPlatforms } from "../lib/enabledPlatforms";
import { AUTH_CHANGED_EVENT, notifyAuthChanged, privyEnabled } from "../lib/privy-env";
import { copyText } from "../lib/share";
import { useToast } from "../lib/toast";
import { useT } from "../lib/i18n";
import PlatformPicker from "../lib/PlatformPicker";
import {
  CheckIcon,
  CopyIcon,
  KeyIcon,
  MicIcon,
  MonitorIcon,
  PenIcon,
  SparkIcon,
  TrashIcon,
} from "../lib/icons";
import type { Draft, Idea, Me, Platform, Profile, Variants } from "../lib/types";
import { PLATFORM_LABELS, PLATFORMS } from "../lib/types";

const PrivyButton = lazy(() => import("../lib/PrivyButton"));

type Pane = "write" | "queue" | "bots";
type QueueFilter = "all" | "agent" | "mine";

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong";
}

function captionPlatforms(d: Draft, edit: Variants): Platform[] {
  const present = new Set([...Object.keys(d.variants), ...Object.keys(edit)]);
  return PLATFORMS.filter((p) => present.has(p));
}

export default function Desk() {
  const t = useT();
  const toast = useToast();
  const [configured, setConfigured] = useState(isConfigured);
  const [pane, setPane] = useState<Pane>("write");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [edit, setEdit] = useState<Variants>({});
  const [saving, setSaving] = useState(false);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const sync = () => setConfigured(isConfigured());
    window.addEventListener(AUTH_CHANGED_EVENT, sync);
    return () => window.removeEventListener(AUTH_CHANGED_EVENT, sync);
  }, []);

  async function refresh() {
    if (!isConfigured()) return;
    try {
      const [nextMe, nextProfile, nextIdeas, nextDrafts] = await Promise.all([
        api.me(),
        api.getProfile(),
        api.getIdeas(),
        api.getDrafts(),
      ]);
      setMe(nextMe);
      setProfile(nextProfile);
      setIdeas(nextIdeas);
      setDrafts(nextDrafts);
    } catch (e: unknown) {
      toast(errMessage(e));
    }
  }

  useEffect(() => {
    if (!configured) return;
    void refresh();
    const id = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured]);

  const openIdeas = ideas.filter((i) => i.status !== "drafted");
  const visible = drafts.filter((d) => {
    if (filter === "agent") return d.source === "agent";
    if (filter === "mine") return d.source !== "agent";
    return true;
  });
  const selected = drafts.find((d) => d.id === selectedId) || null;
  const agentWaiting = drafts.filter((d) => d.source === "agent" && d.status === "draft").length;

  useEffect(() => {
    if (!selected) {
      setEdit({});
      return;
    }
    setEdit({ ...selected.variants });
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const enabled = useMemo(
    () => normalizeEnabledPlatforms(profile?.traits?.enabled_platforms),
    [profile]
  );

  async function signIn() {
    if (!email.trim() || !password) return;
    setAuthBusy(true);
    try {
      const result = await api.login(email.trim(), password);
      clearHubConfig();
      setAuth(result.token, result.email);
      notifyAuthChanged();
      setConfigured(true);
      setPassword("");
      toast(t("Signed in"));
    } catch (e: unknown) {
      toast(errMessage(e));
    } finally {
      setAuthBusy(false);
    }
  }

  async function draftNow(topic: string, ideaId?: number) {
    const value = topic.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      const platforms = normalizeEnabledPlatforms(profile?.traits?.enabled_platforms);
      const draft = await api.generate(
        ideaId
          ? { idea_id: ideaId, text_provider: profile?.traits?.text_provider, platforms }
          : { topic: value, text_provider: profile?.traits?.text_provider, platforms }
      );
      if (!ideaId) setText("");
      setDrafts((rows) => [draft, ...rows.filter((r) => r.id !== draft.id)]);
      setSelectedId(draft.id);
      setPane("queue");
      toast(t("Drafts ready"));
      void refresh();
    } catch (e: unknown) {
      toast(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveIdea() {
    const value = text.trim();
    if (!value) return;
    try {
      await api.addIdea(value);
      setText("");
      toast(t("Saved to backlog"));
      void refresh();
    } catch (e: unknown) {
      toast(errMessage(e));
    }
  }

  async function saveDraft() {
    if (!selected) return;
    setSaving(true);
    try {
      const updated = await api.updateDraft(selected.id, { variants: edit });
      setDrafts((rows) => rows.map((r) => (r.id === updated.id ? updated : r)));
      toast(t("Saved your edit"));
    } catch (e: unknown) {
      toast(errMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function approve(d: Draft) {
    try {
      const updated = await api.updateDraft(d.id, { status: "approved" });
      setDrafts((rows) => rows.map((r) => (r.id === updated.id ? updated : r)));
      toast("Approved");
    } catch (e: unknown) {
      toast(errMessage(e));
    }
  }

  async function removeDraft(d: Draft) {
    await api.deleteDraft(d.id);
    setDrafts((rows) => rows.filter((r) => r.id !== d.id));
    if (selectedId === d.id) setSelectedId(null);
  }

  async function copyCaption(platform: Platform) {
    const body = edit[platform] || selected?.variants[platform] || "";
    if (!body.trim()) return;
    await copyText(withBrandTag(body, me?.tier));
    toast(t("Copied"));
  }

  async function mintKey() {
    setKeyBusy(true);
    try {
      const created = await api.createKey("Grok / Cursor");
      setFreshKey(created.key);
    } catch (e: unknown) {
      toast(errMessage(e));
    } finally {
      setKeyBusy(false);
    }
  }

  if (!configured) {
    return (
      <div className="desk-gate">
        <div className="card" style={{ maxWidth: 420, width: "100%" }}>
          <div className="card-title">
            <MonitorIcon size={18} />
            Brand Studio Desk
          </div>
          <p className="card-desc">
            Keyboard-first workspace for you and Grok bots. Same account as the phone app.
          </p>
          {privyEnabled() && (
            <div style={{ marginBottom: 12 }}>
              <Suspense fallback={<button type="button" className="btn privy-btn block" disabled />}>
                <PrivyButton />
              </Suspense>
            </div>
          )}
          <form
            className="auth-form"
            onSubmit={(e) => {
              e.preventDefault();
              void signIn();
            }}
          >
            <label htmlFor="desk-email">{t("Email")}</label>
            <input
              id="desk-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <label htmlFor="desk-password">{t("Password")}</label>
            <input
              id="desk-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <button className="btn primary block" type="submit" disabled={authBusy} style={{ marginTop: 14 }}>
              {authBusy ? <span className="spinner" /> : t("Sign in")}
            </button>
          </form>
          <Link to="/setup" className="btn ghost block" style={{ marginTop: 8, textDecoration: "none" }}>
            {t("New here? Create an account")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="desk">
      <aside className="desk-rail">
        <div className="desk-brand">
          <span className="eyebrow">Brand Studio</span>
          <b>Desk</b>
          <span className="muted small">{getAuthEmail() || me?.email}</span>
        </div>
        <nav className="desk-nav">
          <button type="button" className={pane === "write" ? "on" : ""} onClick={() => setPane("write")}>
            <SparkIcon size={16} />
            Write
          </button>
          <button type="button" className={pane === "queue" ? "on" : ""} onClick={() => setPane("queue")}>
            <PenIcon size={16} />
            Queue
            {agentWaiting > 0 ? <span className="desk-count">{agentWaiting}</span> : null}
          </button>
          <button type="button" className={pane === "bots" ? "on" : ""} onClick={() => setPane("bots")}>
            <KeyIcon size={16} />
            Grok bots
          </button>
        </nav>
        <div className="desk-rail-foot">
          <Link to="/capture" className="desk-rail-link">
            <MicIcon size={16} />
            Phone app
          </Link>
          <Link to="/setup" className="desk-rail-link">
            Setup
          </Link>
        </div>
      </aside>

      {pane === "write" && (
        <section className="desk-pane">
          <header className="desk-head">
            <h1>Write</h1>
            <span className="muted small">
              {me
                ? t("{used}/{limit} drafts this month", { used: me.drafts_used, limit: me.drafts_limit })
                : ""}
            </span>
          </header>
          <textarea
            ref={composer}
            className="desk-composer"
            rows={8}
            placeholder="Type the idea. Ctrl+Enter drafts it for every app you have on."
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void draftNow(text);
              }
            }}
          />
          <div className="desk-write-tools">
            <div className="capture-platforms" style={{ marginTop: 0, flex: 1 }}>
              <span className="muted small">{t("Push to")}</span>
              <PlatformPicker
                compact
                selected={enabled}
                onChange={(next) => {
                  if (!profile) return;
                  const updated: Profile = {
                    ...profile,
                    traits: { ...(profile.traits || {}), enabled_platforms: next },
                  };
                  setProfile(updated);
                  void api.saveProfile(updated).catch((e: unknown) => toast(errMessage(e)));
                }}
                disabled={busy}
              />
            </div>
            <div className="text-provider-seg" style={{ marginLeft: 0 }}>
              <span className="muted small">Writer</span>
              <button
                type="button"
                className={`chip-btn ${profile?.traits?.text_provider !== "claude" ? "on" : ""}`}
                onClick={() => {
                  if (!profile) return;
                  const updated: Profile = {
                    ...profile,
                    traits: { ...(profile.traits || {}), text_provider: "grok" },
                  };
                  setProfile(updated);
                  void api.saveProfile(updated).catch((e: unknown) => toast(errMessage(e)));
                }}
              >
                Grok
              </button>
              <button
                type="button"
                className={`chip-btn ${profile?.traits?.text_provider === "claude" ? "on" : ""}`}
                onClick={() => {
                  if (!profile) return;
                  const updated: Profile = {
                    ...profile,
                    traits: { ...(profile.traits || {}), text_provider: "claude" },
                  };
                  setProfile(updated);
                  void api.saveProfile(updated).catch((e: unknown) => toast(errMessage(e)));
                }}
              >
                Claude
              </button>
            </div>
          </div>
          <div className="row" style={{ marginTop: 12, gap: 8 }}>
            <button className="btn outline" type="button" disabled={!text.trim() || busy} onClick={() => void saveIdea()}>
              {t("capture.saveIdea")}
            </button>
            <button className="btn primary" type="button" disabled={!text.trim() || busy} onClick={() => void draftNow(text)}>
              {busy ? <span className="spinner" /> : <SparkIcon size={17} />}
              {t("capture.draftNow")}
            </button>
          </div>

          {openIdeas.length > 0 && (
            <div className="desk-backlog">
              <div className="muted small" style={{ fontWeight: 650, marginBottom: 8 }}>
                {t("Idea backlog · {n}", { n: openIdeas.length })}
              </div>
              {openIdeas.map((idea) => (
                <div className="desk-idea" key={idea.id}>
                  <p>{idea.text}</p>
                  <div className="row" style={{ gap: 8 }}>
                    <button className="btn sm primary" type="button" disabled={busy} onClick={() => void draftNow(idea.text, idea.id)}>
                      {t("Draft this")}
                    </button>
                    <button
                      className="btn ghost danger icon-only"
                      type="button"
                      aria-label={t("Delete idea")}
                      onClick={async () => {
                        await api.deleteIdea(idea.id);
                        void refresh();
                      }}
                    >
                      <TrashIcon size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {pane === "queue" && (
        <section className="desk-queue">
          <div className="desk-list">
            <header className="desk-head">
              <h1>Queue</h1>
              <div className="desk-filters">
                {(["all", "agent", "mine"] as const).map((f) => (
                  <button key={f} type="button" className={`chip-btn ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>
                    {f === "all" ? "All" : f === "agent" ? "Grok" : "Mine"}
                  </button>
                ))}
              </div>
            </header>
            {visible.length === 0 && <p className="muted">{t("Nothing here yet — talk one out")}</p>}
            {visible.map((d) => (
              <button
                key={d.id}
                type="button"
                className={`desk-draft ${selectedId === d.id ? "on" : ""}`}
                onClick={() => setSelectedId(d.id)}
              >
                <span className="topic">{d.topic || "Untitled"}</span>
                <span className="meta">
                  <span className={`chip ${d.status === "posted" ? "posted" : "draft"}`}>
                    {d.source === "agent" && d.status === "draft" ? t("agent draft") : t(d.status)}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <div className="desk-editor">
            {!selected && <p className="muted">Pick a draft. Edit every app on one screen, then copy or approve.</p>}
            {selected && (
              <>
                <header className="desk-head">
                  <h2>{selected.topic || "Draft"}</h2>
                  <div className="row" style={{ gap: 8 }}>
                    {selected.source === "agent" && selected.status === "draft" && (
                      <button className="btn sm primary" type="button" onClick={() => void approve(selected)}>
                        <CheckIcon size={14} />
                        {t("Approve")}
                      </button>
                    )}
                    <button className="btn sm" type="button" disabled={saving} onClick={() => void saveDraft()}>
                      {t("Save")}
                    </button>
                    <button className="btn ghost danger sm" type="button" onClick={() => void removeDraft(selected)}>
                      {t("Delete")}
                    </button>
                  </div>
                </header>
                {selected.source === "agent" && selected.status === "draft" && (
                  <div className="banner warn">{t("Written by your agent — review before sharing.")}</div>
                )}
                <div className="desk-captions">
                  {captionPlatforms(selected, edit).map((p) => (
                    <label key={p} className="desk-caption">
                      <span>
                        {PLATFORM_LABELS[p]}
                        <button type="button" className="btn ghost sm" onClick={() => void copyCaption(p)}>
                          <CopyIcon size={14} />
                          {t("Copy")}
                        </button>
                      </span>
                      <textarea
                        rows={6}
                        value={edit[p] || ""}
                        onChange={(e) => setEdit((cur) => ({ ...cur, [p]: e.target.value }))}
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                            e.preventDefault();
                            void saveDraft();
                          }
                        }}
                      />
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
        </section>
      )}

      {pane === "bots" && (
        <section className="desk-pane">
          <header className="desk-head">
            <h1>Grok bots</h1>
          </header>
          <p className="card-desc" style={{ marginTop: 0, maxWidth: 640 }}>
            Bots talk to the hub with a Studio agent key. They can write drafts and insights. They cannot approve or post. You finish that here in Queue.
          </p>
          <div className="row" style={{ gap: 8, marginBottom: 14 }}>
            <button className="btn primary" type="button" disabled={keyBusy} onClick={() => void mintKey()}>
              {keyBusy ? <span className="spinner" /> : <KeyIcon size={16} />}
              New agent key
            </button>
            <button
              className="btn"
              type="button"
              onClick={async () => {
                await copyText(agentInstructions(getHubUrl()));
                toast(t("Copied"));
              }}
            >
              <CopyIcon size={16} />
              Copy bot instructions
            </button>
          </div>
          {freshKey && (
            <div className="banner ok" style={{ wordBreak: "break-all" }}>
              Shown once. Put this in <code>BRAND_STUDIO_AGENT_KEY</code>, not in chat.
              <pre className="desk-pre">{freshKey}</pre>
            </div>
          )}
          <pre className="desk-pre">{agentInstructions(getHubUrl())}</pre>
          <p className="muted small">
            Hub: <code>{getHubUrl()}</code>
            {" · "}
            This page: <code>https://app.mybrandstudio.club/desk</code>
          </p>
        </section>
      )}
    </div>
  );
}
