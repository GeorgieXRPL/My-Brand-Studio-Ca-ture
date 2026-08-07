import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, isConfigured } from "../lib/api";
import { useToast } from "../lib/toast";
import { BulbIcon, ChartIcon, SparkIcon, XCircleIcon } from "../lib/icons";
import Spark from "../lib/Spark";
import type { GrowthStatus, Insight } from "../lib/types";
import { useT } from "../lib/i18n";

// Algorithm + content-gap playbook — July 2026. Keep in sync with hub/src/algoContext.js.
const PLAYBOOK = [
  {
    platform: "TikTok",
    tool: "FYP completion + Creator Search Insights",
    how: "Hook in 1–1.5s; aim for ~70%+ completion and rewatches. Speak niche keywords (search indexes audio + on-screen text). Use Creator Search Insights → Content Gap for underserved topics.",
  },
  {
    platform: "Instagram",
    tool: "Watch time · DM shares · Trial Reels",
    how: "2026 rankers weight watch time and sends-per-reach (DM shares) above likes. Prefer original media (repost penalty is real). Test risky angles with Trial Reels before pushing to followers.",
  },
  {
    platform: "LinkedIn",
    tool: "Interest graph · saves · dwell",
    how: "LLM topic matching surfaces posts beyond your network. Write a strong first line for dwell; optimise for saves and 3+ sentence comments. Avoid leading with external links.",
  },
  {
    platform: "X",
    tool: "Grok For You · replies · bookmarks",
    how: "Ranking is Grok-based (2026). Chase reply quality and bookmarks over likes. Hook in line one; join rising niche conversations early with a clear POV.",
  },
  {
    platform: "Facebook",
    tool: "Groups · original Reels",
    how: "Meaningful interactions and active Groups still amplify. Prefer original video; pages that mostly repost get fingerprinted and throttled. Native FB captions beat raw IG crossposts.",
  },
  {
    platform: "YouTube",
    tool: "Studio → Research → Content gaps",
    how: "Filter for content gaps / Shorts gaps weekly. Retention in the first 15–30s still decides recommendation. Pair Shorts hooks with a search-intent title.",
  },
];

export default function Insights() {
  const toast = useToast();
  const t = useT();
  const navigate = useNavigate();
  const configured = isConfigured();
  const [feed, setFeed] = useState<Insight[]>([]);
  const [growth, setGrowth] = useState<GrowthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [openPlat, setOpenPlat] = useState<string | null>(null);

  useEffect(() => {
    if (configured) {
      api.getInsights().then(setFeed).catch(() => {});
      api.getGrowthStatus().then(setGrowth).catch(() => {});
    }
  }, [configured]);

  const weeklyTips = feed.filter((i) => i.source === "system");
  const agentFeed = feed.filter((i) => i.source !== "system");

  async function refreshTips() {
    setRefreshing(true);
    try {
      await api.refreshInsights();
      setFeed(await api.getInsights());
      setGrowth(await api.getGrowthStatus());
      toast(t("Fresh analysis is in — new tips below"));
    } catch (e: any) {
      toast(e.message);
    } finally {
      setRefreshing(false);
    }
  }

  async function draftFromInsight(ins: Insight) {
    setBusy(true);
    try {
      const draft = await api.generate({
        topic: t("Content-gap opportunity on {platform}: {title}. {body}", {
          platform: ins.platform || "social",
          title: ins.title,
          body: ins.body,
        }),
      });
      await api.updateInsight(ins.id, "used").catch(() => {});
      navigate(`/drafts?focus=${draft.id}`);
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function dismiss(ins: Insight) {
    await api.updateInsight(ins.id, "dismissed").catch(() => {});
    setFeed((prev) => prev.filter((x) => x.id !== ins.id));
  }

  function renderInsight(ins: Insight) {
    return (
      <div className="insight-row" key={ins.id}>
        <div className="row between">
          <b>
            {ins.platform && <span className="chip" style={{ marginRight: 8 }}>{ins.platform}</span>}
            {ins.title}
          </b>
          <button className="btn ghost sm icon-only" aria-label={t("Dismiss")} onClick={() => dismiss(ins)}>
            <XCircleIcon size={16} />
          </button>
        </div>
        <p className="muted" style={{ margin: "6px 0 10px", lineHeight: 1.5 }}>
          {ins.body}
        </p>
        <button className="btn primary sm" onClick={() => draftFromInsight(ins)} disabled={busy}>
          <SparkIcon size={14} />
          {ins.status === "used" ? t("Draft again") : t("Turn into a draft")}
        </button>
      </div>
    );
  }

  return (
    <div className="screen">
      {busy && (
        <div className="gen-overlay">
          <Spark size={72} mood="thinking" />
          <div className="gen-text">{t("Turning the gap into content…")}</div>
          <div className="gen-sub">X · Facebook · TikTok · Snapchat · Instagram · LinkedIn</div>
        </div>
      )}

      <div className="header">
        <h1>
          <span className="eyebrow">{t("insights.eyebrow")}</span>
          {t("insights.title")}
        </h1>
      </div>

      {/* ---- Weekly AI growth analysis ---- */}
      <div className="card growth-card">
        <div className="card-title">
          <ChartIcon size={18} />
          {t("insights.growthTitle")}
        </div>
        {growth && (
          <div className="growth-meter">
            <div className="growth-stat">
              <b>{growth.drafts_created_30d}</b>
              <span>{t("drafts (30d)")}</span>
            </div>
            <div className="growth-stat">
              <b>{growth.recent_topics.length}</b>
              <span>{t("recent topics")}</span>
            </div>
          </div>
        )}
        <p className="card-desc">
          {t(
            "Tips use your Brand Brain, drafts, and current algorithm knowledge — no analytics login required. Live performance metrics are coming soon."
          )}
        </p>
        {growth?.recent_topics.length ? (
          <p className="muted small" style={{ marginBottom: 10 }}>
            {t("Studying your recent topics: {topics}", { topics: growth.recent_topics.slice(0, 3).join(" · ") })}
          </p>
        ) : null}
        {growth?.tips_fresh && growth.last_tips_at && (
          <div className="banner ok" style={{ marginBottom: 10 }}>
            {t("This week's tips are ready. New batch unlocks")}{" "}
            {growth.next_refresh_at ? new Date(growth.next_refresh_at).toLocaleDateString() : t("in 7 days")}.
          </div>
        )}
        {weeklyTips.length === 0 && (
          <div className="empty-spark" style={{ padding: "16px 8px" }}>
            <Spark size={56} mood="thinking" />
            <p>{t("No analysis yet — capture a few ideas first so there's data to study, then pull your first batch.")}</p>
          </div>
        )}
        {weeklyTips.map(renderInsight)}
        <button className="btn block" style={{ marginTop: 10 }} onClick={refreshTips} disabled={refreshing || growth?.tips_fresh}>
          <SparkIcon size={15} />
          {refreshing
            ? t("Analysing your data…")
            : growth?.tips_fresh
              ? t("Tips are fresh — check back next week")
              : t("Get this week's tips")}
        </button>
      </div>

      {/* ---- Agent research feed ---- */}
      <div className="card">
        <div className="card-title">
          <SparkIcon size={18} />
          {t("Your research feed")}
        </div>
        {agentFeed.length === 0 ? (
          <p className="card-desc">
            {t("Nothing here yet. Connect an agent (Setup → Agents) and ask it for weekly research — it posts content-gap finds and new algorithm opportunities straight into this feed. Studio feature.")}
          </p>
        ) : (
          agentFeed.map(renderInsight)
        )}
      </div>

      {/* ---- Platform playbook ---- */}
      <div className="card">
        <div className="card-title">
          <BulbIcon size={18} />
          {t("Find gaps yourself — this week's playbook")}
        </div>
        <p className="card-desc">{t("Every platform has a built-in tool that shows demand nobody is serving yet.")}</p>
        {PLAYBOOK.map((p) => (
          <div className="playbook-row" key={p.platform}>
            <button className="playbook-head" onClick={() => setOpenPlat(openPlat === p.platform ? null : p.platform)}>
              <b>{p.platform}</b>
              <span className="muted small">{t(p.tool)}</span>
            </button>
            {openPlat === p.platform && <p className="muted small playbook-how">{t(p.how)}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
