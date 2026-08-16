/**
 * Concurrent load smoke for 10–100 users.
 *
 * Health-only (no token):
 *   HUB_URL=https://brand-studio-hub.fly.dev node scripts/stress.mjs
 *
 * Signed-in mix (list drafts / me / imagine status):
 *   HUB_URL=https://... HUB_TOKEN=bs_... node scripts/stress.mjs
 *
 * Env:
 *   STRESS_N          total requests (default 100)
 *   STRESS_CONCURRENCY in-flight at once (default 25)
 *   STRESS_USERS      simulated users (waves of N / users) — default 1 token reused
 */
const base = (process.env.HUB_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const token = process.env.HUB_TOKEN || process.env.TOKEN || "";
const N = Math.max(1, Number(process.env.STRESS_N || 100));
const concurrency = Math.max(1, Number(process.env.STRESS_CONCURRENCY || 25));

const authed = [
  "/api/health",
  "/api/auth/me",
  "/api/drafts",
  "/api/imagine/status",
  "/api/ideas",
];
const publicPaths = ["/api/health"];
const paths = token ? authed : publicPaths;

async function hit(path) {
  const t0 = Date.now();
  const headers = {};
  if (token && path !== "/api/health") headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(base + path, { headers });
    const ms = Date.now() - t0;
    let ok = res.ok;
    let err = null;
    try {
      const body = await res.json();
      if (!res.ok) err = body?.error || res.statusText;
      if (res.ok && path === "/api/health" && body?.ok !== true) {
        ok = false;
        err = "health.ok !== true";
      }
      if (res.ok && path.includes("/drafts") && !Array.isArray(body)) {
        ok = false;
        err = "drafts not an array";
      }
    } catch (e) {
      ok = false;
      err = e.message;
    }
    return { path, status: res.status, ms, ok, err };
  } catch (e) {
    return { path, status: 0, ms: Date.now() - t0, ok: false, err: e.message };
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i];
}

async function runPool(jobs) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < jobs.length) {
      const job = jobs[i++];
      results.push(await job());
    }
  }
  const n = Math.min(concurrency, jobs.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

function summarize(label, results) {
  const failed = results.filter((r) => !r.ok);
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const byStatus = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  return {
    label,
    requests: results.length,
    concurrency,
    ok: results.length - failed.length,
    failed: failed.length,
    avg_ms: Math.round(times.reduce((s, n) => s + n, 0) / times.length || 0),
    p50_ms: percentile(times, 50),
    p95_ms: percentile(times, 95),
    p99_ms: percentile(times, 99),
    max_ms: times[times.length - 1] || 0,
    by_status: byStatus,
    errors: failed.slice(0, 8),
  };
}

const jobs = [];
for (let i = 0; i < N; i++) {
  const path = paths[i % paths.length];
  jobs.push(() => hit(path));
}

const t0 = Date.now();
const results = await runPool(jobs);
const elapsed = Date.now() - t0;
const summary = summarize(`${N} req @ ${concurrency} inflight`, results);
summary.base = base;
summary.auth = Boolean(token);
summary.elapsed_ms = elapsed;
summary.rps = Number((N / (elapsed / 1000)).toFixed(1));

console.log(JSON.stringify(summary, null, 2));
if (summary.failed) process.exit(1);
