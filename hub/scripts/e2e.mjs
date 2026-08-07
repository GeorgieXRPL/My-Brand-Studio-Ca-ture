// End-to-end + agent-security test against a running hub.
// Usage: DB_PATH=/tmp/e2e/hub.db PORT=8791 node src/index.js  (separately)
//        node scripts/e2e.mjs http://localhost:8791
import assert from "node:assert";

const HUB = process.argv[2] || "http://localhost:8791";
let passed = 0;

async function req(method, path, { token, body } = {}) {
  const res = await fetch(HUB + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function check(name, cond, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  passed++;
  console.log(`  ok  ${name}`);
}

// ---- Accounts & referrals ----
const rand = Math.random().toString(36).slice(2, 8);
const emailB = `bob-${rand}@test.local`;
const emailA = `alice-${rand}@test.local`;

// On a fresh DB the first user takes id 1, which is the owner/studio identity.
// Burn it so B and A are regular users.
await req("POST", "/api/auth/signup", { body: { email: `owner-${rand}@test.local`, password: "password123" } });

const b = await req("POST", "/api/auth/signup", { body: { email: emailB, password: "password123" } });
check("signup B", b.status === 201 && b.data.token);
const meB1 = await req("GET", "/api/auth/me", { token: b.data.token });
check("me B has ref_code + free tier", meB1.data.ref_code && meB1.data.tier === "free" && meB1.data.drafts_limit === 10);

const a = await req("POST", "/api/auth/signup", {
  body: { email: emailA, password: "password123", ref: meB1.data.ref_code },
});
check("signup A with ref", a.status === 201);
const meA = await req("GET", "/api/auth/me", { token: a.data.token });
check("A got +20 bonus drafts", meA.data.drafts_limit === 30, `got ${meA.data.drafts_limit}`);
const meB2 = await req("GET", "/api/auth/me", { token: b.data.token });
check("B got +20 bonus + referral count", meB2.data.drafts_limit === 30 && meB2.data.referrals === 1);

const A = a.data.token;

// ---- Profile traits ----
const put = await req("PUT", "/api/profile", {
  token: A,
  body: { goals: "grow", projects: "app", brand_voice: "hype", traits: { content_style: "Educational", content_types: ["Threads"] } },
});
check("profile PUT with traits", put.status === 200 && put.data.traits.content_style === "Educational");

// ---- Schedule CRUD ----
const blk = await req("POST", "/api/schedule", {
  token: A,
  body: { weekday: 2, start_time: "06:00", end_time: "07:00", title: "E2E block", category: "dev" },
});
check("schedule POST", blk.status === 201 && blk.data.id);
const upd = await req("PATCH", `/api/schedule/${blk.data.id}`, { token: A, body: { title: "E2E edited" } });
check("schedule PATCH title", upd.status === 200 && upd.data.title === "E2E edited");
const del = await req("DELETE", `/api/schedule/${blk.data.id}`, { token: A });
check("schedule DELETE", del.status === 200);
const badBlk = await req("POST", "/api/schedule", { token: A, body: { weekday: 9, start_time: "1", end_time: "2", title: "x" } });
check("schedule rejects weekday 9", badBlk.status === 400);

// ---- Workouts edit ----
const w = await req("POST", "/api/workouts", { token: A, body: { description: "push day", date: "2026-07-10" } });
check("workout POST", w.status === 201);
const wPatch = await req("PATCH", `/api/workouts/${w.data.id}`, { token: A, body: { description: "pull day", date: "2026-07-09" } });
check("workout PATCH desc+date", wPatch.data.description === "pull day" && wPatch.data.date === "2026-07-09");

// ---- Tier gating ----
const keyFree = await req("POST", "/api/keys", { token: A, body: { name: "should fail" } });
check("free tier blocked from agent keys (402)", keyFree.status === 402);
const postFree = await req("POST", "/api/posts", { token: A, body: { draft_id: 1, platform: "x" } });
check("free tier blocked from publishing (402)", postFree.status === 402);
const schedFree = await req("POST", "/api/posts/schedule", {
  token: A,
  body: { draft_id: 1, platform: "x", scheduled_at: new Date(Date.now() + 3600e3).toISOString() },
});
check("free tier blocked from scheduling (402)", schedFree.status === 402);
const insFree = await req("POST", "/api/insights", { token: A, body: { title: "t", body: "b" } });
check("free tier blocked from insights POST (402)", insFree.status === 402);

// Upgrade A to studio directly in the DB (set-tier equivalent).
const { default: Database } = await import("better-sqlite3");
const db = new Database(process.env.DB_PATH || "/tmp/e2e/hub.db");
db.prepare("UPDATE users SET tier = 'studio' WHERE email = ?").run(emailA);
db.close();
const meA2 = await req("GET", "/api/auth/me", { token: A });
check("A now studio, limit 1020", meA2.data.tier === "studio" && meA2.data.drafts_limit === 1020);

// ---- Agent key lifecycle + scoping ----
const keyRes = await req("POST", "/api/keys", { token: A, body: { name: "e2e agent" } });
check("studio can create agent key", keyRes.status === 201 && keyRes.data.key.startsWith("ak_"));
const AK = keyRes.data.key;

const agentIdeas = await req("GET", "/api/ideas", { token: AK });
check("agent can read ideas", agentIdeas.status === 200);
const agentProfile = await req("GET", "/api/profile", { token: AK });
check("agent can read profile", agentProfile.status === 200);

// Blocked routes
for (const [method, path] of [
  ["GET", "/api/keys"],
  ["POST", "/api/keys"],
  ["GET", "/api/export"],
  ["GET", "/api/connections"],
  ["POST", "/api/posts"],
  ["POST", "/api/posts/schedule"],
  ["GET", "/api/posts/scheduled"],
  ["GET", "/api/agent/stats"],
  ["POST", "/api/auth/logout"],
  ["PUT", "/api/profile"],
  ["POST", "/api/schedule"],
  ["POST", "/api/workouts"],
]) {
  const r = await req(method, path, { token: AK, body: method === "GET" ? undefined : {} });
  check(`agent blocked: ${method} ${path}`, r.status === 403, `got ${r.status}`);
}

// Agent draft is forced into approval queue
const agentDraft = await req("POST", "/api/drafts", {
  token: AK,
  body: { topic: "agent topic", variants: { x: "hello from agent" }, status: "approved", source: "user" },
});
check(
  "agent draft forced to draft/agent",
  agentDraft.status === 201 && agentDraft.data.status === "draft" && agentDraft.data.source === "agent"
);
const selfApprove = await req("PATCH", `/api/drafts/${agentDraft.data.id}`, { token: AK, body: { status: "approved" } });
check("agent cannot self-approve (403)", selfApprove.status === 403);
const editText = await req("PATCH", `/api/drafts/${agentDraft.data.id}`, {
  token: AK,
  body: { variants: { x: "edited by agent" } },
});
check("agent CAN edit draft text", editText.status === 200 && editText.data.variants.x === "edited by agent");

// Agent insights
const agentIns = await req("POST", "/api/insights", {
  token: AK,
  body: { platform: "tiktok", title: "Gap: test", body: "e2e insight" },
});
check("agent can post insight (studio)", agentIns.status === 201 && agentIns.data.source === "agent");

// User approves + manages insights
const approve = await req("PATCH", `/api/drafts/${agentDraft.data.id}`, { token: A, body: { status: "approved" } });
check("user can approve agent draft", approve.status === 200 && approve.data.status === "approved");
const insList = await req("GET", "/api/insights", { token: A });
check("user sees insight feed", insList.data.some((i) => i.title === "Gap: test"));
const insUsed = await req("PATCH", `/api/insights/${agentIns.data.id}`, { token: A, body: { status: "used" } });
check("user can mark insight used", insUsed.status === 200 && insUsed.data.status === "used");

// ---- Agent stats ----
const stats = await req("GET", "/api/agent/stats", { token: A });
const k = stats.data.keys.find((x) => x.name === "e2e agent");
check("stats: drafts + approval + events", k && k.drafts_total === 1 && k.approval_rate === 100 && k.requests > 5 && k.insights === 1);
check("stats: recent events present", stats.data.events.length > 0);

// ---- Scheduling (studio) ----
const sched = await req("POST", "/api/posts/schedule", {
  token: A,
  body: { draft_id: agentDraft.data.id, platform: "x", scheduled_at: new Date(Date.now() + 7200e3).toISOString() },
});
check("studio can schedule a post", sched.status === 201 && sched.data.status === "scheduled");
const schedList = await req("GET", "/api/posts/scheduled", { token: A });
check("scheduled list", schedList.data.length === 1);
const cancel = await req("DELETE", `/api/posts/scheduled/${sched.data.id}`, { token: A });
check("cancel scheduled post", cancel.status === 200);
const pastSched = await req("POST", "/api/posts/schedule", {
  token: A,
  body: { draft_id: agentDraft.data.id, platform: "x", scheduled_at: "2020-01-01T00:00:00Z" },
});
check("rejects past scheduled_at", pastSched.status === 400);

// ---- Cross-tenant isolation ----
const bIdeas = await req("GET", "/api/drafts", { token: b.data.token });
check("B cannot see A's drafts", !bIdeas.data.some((d) => d.topic === "agent topic"));

// ---- Key revocation ----
const keyList = await req("GET", "/api/keys", { token: A });
const revoke = await req("DELETE", `/api/keys/${keyList.data[0].id}`, { token: A });
check("revoke key", revoke.status === 200);
const afterRevoke = await req("GET", "/api/ideas", { token: AK });
check("revoked key rejected (401)", afterRevoke.status === 401);

console.log(`\nAll ${passed} checks passed.`);
