import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// DB_PATH lets hosted deployments (Fly volume) relocate the database.
const dbPath = process.env.DB_PATH || join(__dirname, "..", "data", "hub.db");
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 8000");
db.pragma("foreign_keys = ON");

// Uploaded media lives next to the database (on the Fly volume in production).
export const mediaDir = process.env.MEDIA_DIR || join(dirname(dbPath), "media");
mkdirSync(mediaDir, { recursive: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS profiles (
    user_id INTEGER PRIMARY KEY,
    goals TEXT DEFAULT '',
    projects TEXT DEFAULT '',
    brand_voice TEXT DEFAULT '',
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS ideas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    idea_id INTEGER,
    topic TEXT NOT NULL,
    variants TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    source TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schedule_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    weekday INTEGER NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS workouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    date TEXT NOT NULL,
    description TEXT NOT NULL,
    is_content_source INTEGER NOT NULL DEFAULT 1,
    draft_id INTEGER,
    created_at TEXT NOT NULL
  );

  -- Social platform connections (OAuth tokens per user per platform).
  CREATE TABLE IF NOT EXISTS connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    platform TEXT NOT NULL,
    handle TEXT DEFAULT '',
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (user_id, platform)
  );

  -- Short-lived state for in-flight OAuth flows.
  CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    platform TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- Record of every publish attempt through the API.
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    draft_id INTEGER NOT NULL,
    platform TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'posted',
    external_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL
  );

  -- Agent / API keys (bring-your-own-agent access).
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );

  -- Uploaded media files (served publicly by unguessable id).
  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  -- Audit log of every agent (API-key) request. Powers agent analytics.
  CREATE TABLE IF NOT EXISTS agent_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    method TEXT NOT NULL,
    route TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- Research findings (content gaps / algo opportunities) pushed by agents
  -- or system jobs into the user's Insights feed.
  CREATE TABLE IF NOT EXISTS insights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    platform TEXT DEFAULT '',
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'agent',
    api_key_id INTEGER,
    status TEXT NOT NULL DEFAULT 'new',
    created_at TEXT NOT NULL
  );

  -- Queue of posts to publish at a future time.
  CREATE TABLE IF NOT EXISTS scheduled_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    draft_id INTEGER NOT NULL,
    platform TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',
    external_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL
  );

  -- Grok Imagine generation jobs (video / still) attached to drafts.
  CREATE TABLE IF NOT EXISTS imagine_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    draft_id INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'video',
    xai_request_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    progress INTEGER DEFAULT 0,
    prompt TEXT NOT NULL DEFAULT '',
    error TEXT,
    media_url TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// ---- Migrations from the single-user schema (v1) ----

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

// v1 data tables had no user_id; everything belonged to the machine owner (user 1).
for (const table of ["ideas", "drafts", "schedule_blocks", "workouts"]) {
  if (!hasColumn(table, "user_id")) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1`);
  }
}

// v2 -> v3: media attachments on ideas and drafts.
for (const table of ["ideas", "drafts"]) {
  if (!hasColumn(table, "media_url")) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN media_url TEXT`);
  }
}

// v3 -> v4: tiers, referrals, agent attribution, structured brand traits.
if (!hasColumn("users", "tier")) {
  db.exec("ALTER TABLE users ADD COLUMN tier TEXT NOT NULL DEFAULT 'free'");
}
if (!hasColumn("users", "ref_code")) {
  db.exec("ALTER TABLE users ADD COLUMN ref_code TEXT");
  db.exec("ALTER TABLE users ADD COLUMN referred_by INTEGER");
  db.exec("ALTER TABLE users ADD COLUMN bonus_drafts INTEGER NOT NULL DEFAULT 0");
}
if (!hasColumn("drafts", "agent_key_id")) {
  db.exec("ALTER TABLE drafts ADD COLUMN agent_key_id INTEGER");
}
if (!hasColumn("profiles", "traits")) {
  db.exec("ALTER TABLE profiles ADD COLUMN traits TEXT NOT NULL DEFAULT '{}'");
}

// v4 -> v5: Stripe billing ids
if (!hasColumn("users", "stripe_customer_id")) {
  db.exec("ALTER TABLE users ADD COLUMN stripe_customer_id TEXT");
}
if (!hasColumn("users", "stripe_subscription_id")) {
  db.exec("ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT");
}

// v5 -> v6: purchased Imagine video credits (overflow past monthly included)
if (!hasColumn("users", "video_credits")) {
  db.exec("ALTER TABLE users ADD COLUMN video_credits INTEGER NOT NULL DEFAULT 0");
}

// Overlay text + optional TTS voice on imagine jobs
if (!hasColumn("imagine_jobs", "overlay_text")) {
  db.exec("ALTER TABLE imagine_jobs ADD COLUMN overlay_text TEXT");
}
if (!hasColumn("imagine_jobs", "voice_id")) {
  db.exec("ALTER TABLE imagine_jobs ADD COLUMN voice_id TEXT");
}
if (!hasColumn("imagine_jobs", "narration_text")) {
  db.exec("ALTER TABLE imagine_jobs ADD COLUMN narration_text TEXT");
}
if (!hasColumn("imagine_jobs", "credit_charged")) {
  db.exec("ALTER TABLE imagine_jobs ADD COLUMN credit_charged INTEGER NOT NULL DEFAULT 0");
}
if (!hasColumn("imagine_jobs", "watermark")) {
  db.exec("ALTER TABLE imagine_jobs ADD COLUMN watermark INTEGER NOT NULL DEFAULT 0");
}

// Custom brand watermark (media URL owned by the user).
if (!hasColumn("profiles", "watermark_media_url")) {
  db.exec("ALTER TABLE profiles ADD COLUMN watermark_media_url TEXT");
}

if (!hasColumn("users", "terms_accepted_at")) {
  db.exec("ALTER TABLE users ADD COLUMN terms_accepted_at TEXT");
}
if (!hasColumn("users", "disabled_at")) {
  db.exec("ALTER TABLE users ADD COLUMN disabled_at TEXT");
}
if (!hasColumn("users", "last_login_at")) {
  db.exec("ALTER TABLE users ADD COLUMN last_login_at TEXT");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    email TEXT PRIMARY KEY,
    user_id INTEGER,
    source TEXT NOT NULL DEFAULT 'password',
    first_seen_at TEXT NOT NULL,
    last_login_at TEXT NOT NULL,
    last_notified_at TEXT
  );
`);
db.exec("CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts (user_id)");

// Capture/source media so users can revert after Imagine still/edit/video.
if (!hasColumn("drafts", "original_media_url")) {
  db.exec("ALTER TABLE drafts ADD COLUMN original_media_url TEXT");
  // Prefer the linked idea's capture when we still have it.
  db.exec(`
    UPDATE drafts
    SET original_media_url = (
      SELECT ideas.media_url FROM ideas
      WHERE ideas.id = drafts.idea_id AND ideas.media_url IS NOT NULL AND ideas.media_url != ''
    )
    WHERE original_media_url IS NULL AND idea_id IS NOT NULL
  `);
  // Drafts never rewritten by Imagine: current attachment is the original.
  db.exec(`
    UPDATE drafts
    SET original_media_url = media_url
    WHERE original_media_url IS NULL
      AND media_url IS NOT NULL
      AND media_url != ''
      AND id NOT IN (SELECT DISTINCT draft_id FROM imagine_jobs WHERE draft_id IS NOT NULL)
  `);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS crypto_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    email TEXT NOT NULL,
    product TEXT NOT NULL,
    amount_usd REAL NOT NULL,
    chain TEXT NOT NULL DEFAULT 'manual',
    pay_to TEXT,
    memo TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    admin_note TEXT,
    paid_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

if (!hasColumn("crypto_invoices", "asset")) {
  db.exec("ALTER TABLE crypto_invoices ADD COLUMN asset TEXT");
}
if (!hasColumn("crypto_invoices", "method_id")) {
  db.exec("ALTER TABLE crypto_invoices ADD COLUMN method_id TEXT");
}
if (!hasColumn("crypto_invoices", "tx_hash")) {
  db.exec("ALTER TABLE crypto_invoices ADD COLUMN tx_hash TEXT");
}
if (!hasColumn("crypto_invoices", "confirmations")) {
  db.exec("ALTER TABLE crypto_invoices ADD COLUMN confirmations INTEGER NOT NULL DEFAULT 0");
}
if (!hasColumn("crypto_invoices", "expected_raw")) {
  db.exec("ALTER TABLE crypto_invoices ADD COLUMN expected_raw TEXT");
}
if (!hasColumn("crypto_invoices", "detected_at")) {
  db.exec("ALTER TABLE crypto_invoices ADD COLUMN detected_at TEXT");
}
try {
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_crypto_invoices_tx_hash ON crypto_invoices(tx_hash) WHERE tx_hash IS NOT NULL AND tx_hash != ''");
} catch {
  /* older SQLite may lack partial indexes — ignore */
}

// v1 had a singleton "profile" table; move its row to the per-user "profiles".
const hasOldProfile = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'profile'")
  .get();
if (hasOldProfile) {
  const old = db.prepare("SELECT goals, projects, brand_voice, updated_at FROM profile WHERE id = 1").get();
  if (old) {
    db.prepare(
      "INSERT OR IGNORE INTO profiles (user_id, goals, projects, brand_voice, updated_at) VALUES (1, ?, ?, ?, ?)"
    ).run(old.goals, old.projects, old.brand_voice, old.updated_at);
  }
  db.exec("DROP TABLE profile");
}

// Indexes are created after migration so user_id is guaranteed to exist.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_ideas_user ON ideas (user_id);
  CREATE INDEX IF NOT EXISTS idx_drafts_user ON drafts (user_id);
  CREATE INDEX IF NOT EXISTS idx_blocks_user ON schedule_blocks (user_id);
  CREATE INDEX IF NOT EXISTS idx_workouts_user ON workouts (user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
  CREATE INDEX IF NOT EXISTS idx_agent_events_key ON agent_events (api_key_id);
  CREATE INDEX IF NOT EXISTS idx_insights_user ON insights (user_id);
  CREATE INDEX IF NOT EXISTS idx_sched_posts_due ON scheduled_posts (status, scheduled_at);
  CREATE INDEX IF NOT EXISTS idx_imagine_jobs_user ON imagine_jobs (user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_imagine_jobs_draft ON imagine_jobs (draft_id);
`);

// Every user gets a shareable referral code.
export function ensureRefCode(userId) {
  const row = db.prepare("SELECT ref_code FROM users WHERE id = ?").get(userId);
  if (row?.ref_code) return row.ref_code;
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  db.prepare("UPDATE users SET ref_code = ? WHERE id = ?").run(code, userId);
  return code;
}

// ---- Per-user bootstrap ----

const DEFAULT_SCHEDULE = [
  // Monday - light day
  [1, "10:00", "19:00", "Light engagement + capture ideas", "light"],
  [1, "19:30", "21:00", "Optional: light dev or rest", "rest"],
  // Tuesday - production
  [2, "07:00", "08:00", "Workout (record for content)", "workout"],
  [2, "09:00", "12:00", "Deep work block (priority)", "dev"],
  [2, "13:00", "15:00", "Content: edit clips + batch drafts", "content"],
  // Wednesday - production
  [3, "09:00", "12:00", "Deep work block (priority)", "dev"],
  [3, "13:00", "15:00", "Content: draft + queue ahead", "content"],
  [3, "17:00", "18:00", "Optional workout", "workout"],
  // Thursday - light day + meetup
  [4, "10:00", "19:00", "Light capture + engagement", "light"],
  [4, "19:00", "22:00", "Networking / community night", "meetup"],
  // Friday - production
  [5, "07:00", "08:00", "Workout (record for content)", "workout"],
  [5, "09:00", "12:00", "Deep work block (priority)", "dev"],
  [5, "13:00", "15:00", "Content batch + weekly review", "review"],
  // Weekend - flex
  [6, "10:00", "12:00", "Optional: batch filming", "content"],
  [6, "12:00", "23:00", "Family-flex / rest", "family"],
  [7, "00:00", "23:00", "Family-flex / rest", "family"],
];

const insertBlock = db.prepare(
  "INSERT INTO schedule_blocks (user_id, weekday, start_time, end_time, title, category) VALUES (?, ?, ?, ?, ?, ?)"
);

export const bootstrapUser = db.transaction((userId) => {
  db.prepare(
    "INSERT OR IGNORE INTO profiles (user_id, goals, projects, brand_voice, updated_at) VALUES (?, '', '', '', ?)"
  ).run(userId, new Date().toISOString());
  const n = db.prepare("SELECT COUNT(*) AS n FROM schedule_blocks WHERE user_id = ?").get(userId).n;
  if (n === 0) {
    for (const row of DEFAULT_SCHEDULE) insertBlock.run(userId, ...row);
  }
});

// The self-host / HUB_TOKEN identity. Password-less: it can only be used
// via the shared token, never via email login. Always Studio on the owner row.
export function ensureOwnerUser() {
  db.prepare(
    "INSERT OR IGNORE INTO users (id, email, password_hash, created_at) VALUES (1, 'owner@selfhost.local', NULL, ?)"
  ).run(new Date().toISOString());
  db.prepare("UPDATE users SET tier = 'studio' WHERE id = 1 AND email = 'owner@selfhost.local'").run();
  bootstrapUser(1);
}
