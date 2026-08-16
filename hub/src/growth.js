// Weekly growth analysis engine.
// Looks at what a creator has actually been doing (drafts, posts, schedule,
// approval behaviour) and asks Claude for 3 platform-specific growth tips,
// which land in their Insights feed as source='system'.
//
// When platform metric connectors ship (X/Meta/TikTok analytics APIs), add
// their numbers to collectStats() and the prompt automatically uses them.

import { db } from "./db.js";
import { generateGrowthTips } from "./textGen.js";
import { ALGO_KNOWLEDGE_CUTOFF } from "./algoContext.js";

const WEEK_MS = 7 * 24 * 3600e3;

function now() {
  return new Date().toISOString();
}

function readProfile(userId) {
  const row = db
    .prepare("SELECT goals, projects, brand_voice, traits FROM profiles WHERE user_id = ?")
    .get(userId) || { goals: "", projects: "", brand_voice: "", traits: "{}" };
  let traits = {};
  try {
    traits = JSON.parse(row.traits || "{}");
  } catch {
    /* ignore corrupted traits */
  }
  return { goals: row.goals, projects: row.projects, brand_voice: row.brand_voice, traits };
}

function collectStats(userId) {
  const since = new Date(Date.now() - 30 * 24 * 3600e3).toISOString();
  const drafts = db
    .prepare("SELECT topic, status, source, created_at FROM drafts WHERE user_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 25")
    .all(userId, since);
  const postCounts = db
    .prepare("SELECT platform, COUNT(*) AS n FROM posts WHERE user_id = ? AND created_at >= ? GROUP BY platform")
    .all(userId, since);
  const scheduled = db
    .prepare("SELECT platform, status, COUNT(*) AS n FROM scheduled_posts WHERE user_id = ? AND created_at >= ? GROUP BY platform, status")
    .all(userId, since);
  const connected = db.prepare("SELECT platform FROM connections WHERE user_id = ?").all(userId).map((r) => r.platform);

  return {
    recent_topics: drafts.map((d) => d.topic).slice(0, 15),
    drafts_created: drafts.length,
    drafts_approved: drafts.filter((d) => d.status !== "draft").length,
    agent_drafts: drafts.filter((d) => d.source === "agent").length,
    posts_by_platform: Object.fromEntries(postCounts.map((r) => [r.platform, r.n])),
    scheduled_posts: scheduled,
    connected_platforms: connected,
    // Live platform analytics are Coming soon — never nudge the model to ask for account linking.
    metrics: "coming_soon — do not ask the user to link or connect accounts for analytics; tip from drafts, topics, and cadence only",
  };
}

export function lastSystemInsightAt(userId) {
  const row = db
    .prepare("SELECT created_at FROM insights WHERE user_id = ? AND source = 'system' ORDER BY created_at DESC LIMIT 1")
    .get(userId);
  return row ? new Date(row.created_at).getTime() : 0;
}

export function tipsAreFresh(userId) {
  const last = lastSystemInsightAt(userId);
  if (!last) return false;
  // Old tips written before the current algo knowledge cutoff are never "fresh".
  if (last < Date.parse(ALGO_KNOWLEDGE_CUTOFF)) return false;
  return Date.now() - last < WEEK_MS;
}

export function getGrowthStatus(userId) {
  const stats = collectStats(userId);
  const lastAt = lastSystemInsightAt(userId);
  const fresh = tipsAreFresh(userId);
  const nextRefreshAt = lastAt ? new Date(lastAt + WEEK_MS).toISOString() : null;
  return {
    metrics_connected: false,
    connected_platforms: stats.connected_platforms,
    drafts_created_30d: stats.drafts_created,
    posts_by_platform: stats.posts_by_platform,
    recent_topics: stats.recent_topics.slice(0, 5),
    last_tips_at: lastAt ? new Date(lastAt).toISOString() : null,
    tips_fresh: fresh,
    next_refresh_at: nextRefreshAt,
    weekly_worker: "active",
  };
}

// Generates and stores this week's tips for one user. Returns the new rows.
export async function generateTipsFor(userId) {
  const profile = readProfile(userId);
  const stats = collectStats(userId);
  const tips = await generateGrowthTips({ profile, stats });
  // Retire prior system tips so outdated "link for metrics" copy does not linger.
  db.prepare("UPDATE insights SET status = 'dismissed' WHERE user_id = ? AND source = 'system' AND status != 'dismissed'").run(
    userId
  );
  const insert = db.prepare(
    "INSERT INTO insights (user_id, platform, title, body, source, status, created_at) VALUES (?, ?, ?, ?, 'system', 'new', ?)"
  );
  const rows = [];
  for (const t of tips) {
    const info = insert.run(userId, t.platform, t.title, t.body, now());
    rows.push(db.prepare("SELECT * FROM insights WHERE id = ?").get(info.lastInsertRowid));
  }
  return rows;
}

// Batch pass used by the weekly worker: users who created a draft in the
// last 14 days (so we have data and they're active) and whose last system
// insight is over a week old. Capped per run to keep API spend flat.
export async function runWeeklyGrowthTips({ limit = 10, log = console } = {}) {
  const activeSince = new Date(Date.now() - 14 * 24 * 3600e3).toISOString();
  const staleBefore = new Date(Date.now() - WEEK_MS).toISOString();
  const users = db
    .prepare(
      `SELECT DISTINCT u.id FROM users u
       JOIN drafts d ON d.user_id = u.id AND d.created_at >= ?
       WHERE u.tier IN ('creator', 'studio')
         AND NOT EXISTS (
         SELECT 1 FROM insights i
         WHERE i.user_id = u.id AND i.source = 'system' AND i.created_at >= ?
       )
       LIMIT ?`
    )
    .all(activeSince, staleBefore, limit);

  for (const { id } of users) {
    try {
      const rows = await generateTipsFor(id);
      log.log(`[growth] wrote ${rows.length} weekly tips for user ${id}`);
    } catch (err) {
      log.error(`[growth] tips failed for user ${id}:`, err.message);
    }
  }
  return users.length;
}
