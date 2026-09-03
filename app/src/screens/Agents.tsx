import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, getHubUrl, isConfigured } from "../lib/api";
import { agentInstructions } from "../lib/agentBrief";
import { useToast } from "../lib/toast";
import { copyText } from "../lib/share";
import { ChartIcon, CopyIcon, KeyIcon, PlugIcon, TrashIcon } from "../lib/icons";
import type { AgentStats } from "../lib/types";
import { useT } from "../lib/i18n";

// Recommended agent platforms users can bring. Referral-tagged links.
const AGENT_DIRECTORY = [
  {
    name: "Grok (Cursor)",
    desc: "Paste the instructions into a Cursor Grok chat. It drafts via the hub; you approve on Desk.",
    url: "https://app.mybrandstudio.club/desk",
  },
  {
    name: "OpenClaw",
    desc: "Open-source personal AI agent — runs on your own machine, great first agent.",
    url: "https://openclaw.ai/?ref=brandstudio",
  },
  {
    name: "Claude (Anthropic)",
    desc: "Give Claude your key in a project's instructions and let it draft while you sleep.",
    url: "https://claude.ai/?ref=brandstudio",
  },
  {
    name: "n8n",
    desc: "Visual automation — schedule a weekly research workflow that posts insights to your feed.",
    url: "https://n8n.io/?ref=brandstudio",
  },
  {
    name: "Zapier Agents",
    desc: "No-code agents that can read your ideas and push drafts on a schedule.",
    url: "https://zapier.com/agents?ref=brandstudio",
  },
];

export default function Agents() {
  const toast = useToast();
  const t = useT();
  const configured = isConfigured();
  const [stats, setStats] = useState<AgentStats | null>(null);
  const [newKeyName, setNewKeyName] = useState("");
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (configured) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    try {
      setStats(await api.agentStats());
      setError("");
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function createKey() {
    setBusy(true);
    try {
      const created = await api.createKey(newKeyName.trim() || "My agent");
      setFreshKey(created.key);
      setNewKeyName("");
      load();
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function revokeKey(id: number) {
    await api.deleteKey(id);
    toast(t("Key revoked — that agent is locked out"));
    load();
  }

  async function copy(text: string, label: string) {
    await copyText(text);
    toast(label);
  }

  const totalDrafts = stats?.keys.reduce((s, k) => s + k.drafts_total, 0) || 0;

  return (
    <div className="screen">
      <div className="header">
        <h1>
          <span className="eyebrow">{t("Bring your own agent")}</span>
          {t("Agents")}
        </h1>
        <Link to="/setup" className="btn ghost sm" style={{ textDecoration: "none" }}>
          {t("Back")}
        </Link>
      </div>

      {!configured && <div className="banner warn">{t("Sign in on the Setup tab first.")}</div>}
      {error && <div className="banner error">{error}</div>}

      {/* ---- Keys ---- */}
      <div className="card">
        <div className="card-title">
          <KeyIcon size={18} />
          {t("Agent keys")}
        </div>
        <p className="card-desc">
          {t("One key = one agent. Your agent can read your content and submit drafts into your approval queue — it can never post, approve, or touch your settings.")}
        </p>
        {freshKey && (
          <div className="banner warn" style={{ marginTop: 10 }}>
            {t("Copy this key now — it won't be shown again.")}
            <div className="key-reveal">
              <code>{freshKey}</code>
              <button className="btn sm" onClick={() => copy(freshKey, t("Key copied"))}>
                <CopyIcon size={14} />
              </button>
            </div>
            <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => setFreshKey(null)}>
              {t("Done — I saved it")}
            </button>
          </div>
        )}
        {stats?.keys.map((k) => (
          <div className="conn-row" key={k.id}>
            <span>
              <b>{k.name}</b>
              <span className="muted small" style={{ display: "block" }}>
                {k.last_used_at ? t("last active {date}", { date: new Date(k.last_used_at).toLocaleDateString() }) : t("never used")}
              </span>
            </span>
            <button className="btn ghost danger sm" onClick={() => revokeKey(k.id)}>
              <TrashIcon size={14} />
              {t("Revoke")}
            </button>
          </div>
        ))}
        <div className="row" style={{ marginTop: 12, gap: 10 }}>
          <input
            placeholder={t("Name it, e.g. OpenClaw")}
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="btn primary sm" onClick={createKey} disabled={busy}>
            {t("Create key")}
          </button>
        </div>
        <button
          className="btn ghost sm"
          style={{ marginTop: 10 }}
          onClick={() => copy(agentInstructions(getHubUrl()), t("Instructions copied — paste them into your agent"))}
        >
          <CopyIcon size={14} />
          {t("Copy setup instructions for your agent")}
        </button>
      </div>

      {/* ---- Analytics ---- */}
      {stats && stats.keys.length > 0 && (
        <div className="card">
          <div className="card-title">
            <ChartIcon size={18} />
            {t("Agent analytics")}
          </div>
          {totalDrafts === 0 && (
            <p className="card-desc">{t("No agent drafts yet. Once your agent starts working, its stats show here.")}</p>
          )}
          {stats.keys.map((k) => (
            <div key={k.id} className="agent-stat">
              <div className="row between">
                <b>{k.name}</b>
                <span className="muted small">{t("{n} requests", { n: k.requests })}</span>
              </div>
              <div className="stat-grid">
                <span>
                  <b>{k.drafts_total}</b> {t("drafts")}
                </span>
                <span>
                  <b>{k.drafts_draft}</b> {t("awaiting review")}
                </span>
                <span>
                  <b>{k.approval_rate === null ? "—" : `${k.approval_rate}%`}</b> {t("approved")}
                </span>
                <span>
                  <b>{k.insights}</b> {t("insights")}
                </span>
              </div>
            </div>
          ))}
          {stats.events.length > 0 && (
            <>
              <div className="muted small" style={{ margin: "12px 0 6px", fontWeight: 600 }}>
                {t("Recent activity")}
              </div>
              {stats.events.slice(0, 8).map((e, i) => (
                <div className="event-row" key={i}>
                  <span className="muted small">
                    {e.key_name} · {e.method} {e.route.replace("/api/", "")}
                  </span>
                  <span className="muted small">
                    {new Date(e.created_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* ---- Directory ---- */}
      <div className="card">
        <div className="card-title">
          <PlugIcon size={18} />
          {t("Don't have an agent yet?")}
        </div>
        <p className="card-desc">{t("These work great with Brand Studio — create a key above, paste the instructions in, done.")}</p>
        {AGENT_DIRECTORY.map((a) => (
          <a key={a.name} className="conn-row dir-row" href={a.url} target="_blank" rel="noopener noreferrer">
            <span>
              <b>{a.name}</b>
              <span className="muted small" style={{ display: "block" }}>
                {t(a.desc)}
              </span>
            </span>
            <span className="muted small">{t("open →")}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
