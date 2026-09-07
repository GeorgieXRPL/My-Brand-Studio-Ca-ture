/**
 * Ops admin API + minimal HTML console.
 * Auth: Bearer ADMIN_TOKEN, cookie bs_admin, or session email in ADMIN_EMAILS.
 */
import { db, mediaDir } from "./db.js";
import { PLAN_PRICES, VIDEO_CREDIT_PACKS } from "./plans.js";
import { setUserDisabled, resolveSession } from "./auth.js";
import { appendMediaSig } from "./mediaSign.js";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

function now() {
  return new Date().toISOString();
}

function adminToken() {
  return (process.env.ADMIN_TOKEN || "").trim();
}

function adminEmails() {
  return (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminRequest(req) {
  const expected = adminToken();
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const cookie = String(req.headers.cookie || "")
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("bs_admin="));
  const cookieVal = cookie ? decodeURIComponent(cookie.split("=").slice(1).join("=")) : "";
  if (expected && (bearer === expected || cookieVal === expected)) return true;

  const emails = adminEmails();
  if (emails.length) {
    let userId = req.userId || 0;
    if (!userId && bearer.startsWith("bs_")) userId = resolveSession(bearer) || 0;
    if (userId) {
      const u = db.prepare("SELECT email FROM users WHERE id = ?").get(userId);
      if (u && emails.includes(String(u.email).toLowerCase())) return true;
    }
  }
  return false;
}

export function requireAdmin(req, res, next) {
  if (!adminToken() && !adminEmails().length) {
    return res.status(503).json({ error: "Admin is not configured. Set ADMIN_TOKEN on the hub." });
  }
  if (!isAdminRequest(req)) return res.status(401).json({ error: "Unauthorized" });
  if (typeof next === "function") return next();
}

export function setUserTier(userId, tier) {
  if (!["free", "creator", "studio"].includes(tier)) return false;
  db.prepare("UPDATE users SET tier = ? WHERE id = ?").run(tier, userId);
  return true;
}

export function createCryptoInvoice({
  userId,
  email,
  product,
  amountUsd,
  chain,
  asset,
  methodId,
  payTo,
  memo,
  expectedRaw,
}) {
  const info = db
    .prepare(
      `INSERT INTO crypto_invoices
        (user_id, email, product, amount_usd, chain, asset, method_id, pay_to, memo, expected_raw, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .run(
      userId,
      email,
      product,
      amountUsd,
      chain || "manual",
      asset || "",
      methodId || "",
      payTo || "",
      memo || "",
      expectedRaw || null,
      now(),
      now()
    );
  return db.prepare("SELECT * FROM crypto_invoices WHERE id = ?").get(info.lastInsertRowid);
}

/** Unique USDC/USDT expected_raw among pending invoices on the same rail. */
export function uniqueStableExpectedRaw(chain, asset, amountUsd) {
  const base = Math.round(Number(amountUsd) * 1e6);
  for (let i = 0; i < 200; i++) {
    const raw = String(base + i * 10000);
    const clash = db
      .prepare(
        `SELECT id FROM crypto_invoices
         WHERE status = 'pending' AND lower(chain) = lower(?) AND upper(asset) = upper(?) AND expected_raw = ?`
      )
      .get(chain, asset, raw);
    if (!clash) return raw;
  }
  return String(base + (Date.now() % 90_000));
}

export function markCryptoPaid(invoiceId, adminNote = "") {
  const ts = now();
  const info = db
    .prepare(
      "UPDATE crypto_invoices SET status = 'paid', admin_note = ?, paid_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'"
    )
    .run(adminNote || "marked paid", ts, ts, invoiceId);
  if (!info.changes) {
    return db.prepare("SELECT * FROM crypto_invoices WHERE id = ?").get(invoiceId) || null;
  }
  const paid = db.prepare("SELECT * FROM crypto_invoices WHERE id = ?").get(invoiceId);
  if (!paid) return null;

  if (paid.product === "creator" || paid.product === "studio") {
    setUserTier(paid.user_id, paid.product);
  } else if (String(paid.product).startsWith("credits_")) {
    const pack = String(paid.product).replace("credits_", "");
    const credits = VIDEO_CREDIT_PACKS[pack]?.credits || Number(pack) || 0;
    if (credits > 0) {
      db.prepare("UPDATE users SET video_credits = COALESCE(video_credits, 0) + ? WHERE id = ?").run(
        credits,
        paid.user_id
      );
    }
  }
  return paid;
}

/** Well-known mainnet token identities for deposit instructions. */
export const CRYPTO_METHOD_DEFS = [
  {
    id: "sol",
    chain: "solana",
    asset: "SOL",
    label: "SOL · Solana",
    kind: "native",
  },
  {
    id: "usdc_sol",
    chain: "solana",
    asset: "USDC",
    label: "USDC · Solana",
    kind: "token",
    token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
  {
    id: "usdt_sol",
    chain: "solana",
    asset: "USDT",
    label: "USDT · Solana",
    kind: "token",
    token: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },
  {
    id: "eth",
    chain: "ethereum",
    asset: "ETH",
    label: "ETH · Ethereum",
    kind: "native",
  },
  {
    id: "usdc_eth",
    chain: "ethereum",
    asset: "USDC",
    label: "USDC · Ethereum",
    kind: "token",
    token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  {
    id: "usdt_eth",
    chain: "ethereum",
    asset: "USDT",
    label: "USDT · Ethereum",
    kind: "token",
    token: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  },
];

function cryptoAddresses() {
  const sol = (process.env.CRYPTO_SOLANA_ADDRESS || "").trim();
  const eth = (process.env.CRYPTO_ETHEREUM_ADDRESS || "").trim();
  const legacy = (process.env.CRYPTO_PAY_TO || "").trim();
  const legacyChain = (process.env.CRYPTO_CHAIN || "solana").trim().toLowerCase();
  return {
    solana: sol || (legacy && legacyChain.includes("sol") ? legacy : ""),
    ethereum: eth || (legacy && legacyChain.includes("eth") ? legacy : ""),
  };
}

export function listCryptoMethods() {
  const addrs = cryptoAddresses();
  return CRYPTO_METHOD_DEFS.map((def) => {
    const payTo = def.chain === "solana" ? addrs.solana : addrs.ethereum;
    if (!payTo) return null;
    return {
      ...def,
      pay_to: payTo,
    };
  }).filter(Boolean);
}

export function resolveCryptoMethod(methodId) {
  const id = String(methodId || "").trim().toLowerCase();
  const methods = listCryptoMethods();
  if (id) {
    const hit = methods.find((m) => m.id === id);
    if (hit) return hit;
  }
  return methods[0] || null;
}

export function cryptoPayConfig() {
  const methods = listCryptoMethods();
  const addrs = cryptoAddresses();
  return {
    enabled: methods.length > 0,
    pay_to: methods[0]?.pay_to || "",
    chain: methods[0]?.chain || (process.env.CRYPTO_CHAIN || "manual").trim(),
    note: (
      process.env.CRYPTO_PAY_NOTE ||
      "Send the exact USD amount. No memo needed — we detect the deposit on-chain and credit your account after confirmations (admin can still verify manually)."
    ).trim(),
    auto_confirm: {
      solana: Math.max(1, Number(process.env.CRYPTO_SOL_CONFIRMATIONS || 32)),
      ethereum: Math.max(1, Number(process.env.CRYPTO_ETH_CONFIRMATIONS || 12)),
    },
    methods,
    addresses: {
      solana: addrs.solana || null,
      ethereum: addrs.ethereum || null,
    },
    prices: {
      creator: PLAN_PRICES.creator.monthly,
      studio: PLAN_PRICES.studio.monthly,
      credits: Object.fromEntries(
        Object.entries(VIDEO_CREDIT_PACKS).map(([k, v]) => [k, { credits: v.credits, usd: v.usd }])
      ),
    },
  };
}

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Brand Studio Admin</title>
<style>
  :root { color-scheme: dark; --bg:#0b1020; --card:#141a2e; --text:#e8eeff; --muted:#8b9bb8; --accent:#7c6af5; --ok:#34d399; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--text); padding:20px; }
  h1 { font-size:1.35rem; margin:0 0 12px; }
  h2 { font-size:1.05rem; margin:24px 0 10px; color:var(--muted); font-weight:600; }
  input, select, button { font: inherit; padding:8px 10px; border-radius:8px; border:1px solid #2a3558; background:#0d1324; color:var(--text); }
  button { background:var(--accent); border:none; cursor:pointer; font-weight:600; }
  button.ghost { background:#1c243c; }
  .row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:8px 0; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:8px 6px; border-bottom:1px solid #222b45; vertical-align:top; }
  .card { background:var(--card); border-radius:12px; padding:14px; margin-bottom:14px; }
  a { color:#9ec1ff; }
  .ok { color:var(--ok); }
  .muted { color:var(--muted); }
</style>
</head>
<body>
  <h1>Brand Studio Admin</h1>
  <div class="card row">
    <input id="token" type="password" placeholder="ADMIN_TOKEN" style="min-width:220px"/>
    <button id="saveToken">Save token</button>
    <span class="muted" id="authStatus"></span>
  </div>
  <h2>Users</h2>
  <div class="card">
    <div class="row">
      <input id="q" placeholder="Search email" style="flex:1;min-width:180px"/>
      <button id="search">Search</button>
      <button class="ghost" id="csv">Download emails CSV</button>
    </div>
    <div id="users"></div>
  </div>
  <h2>Crypto invoices</h2>
  <div class="card" id="invoices"></div>
  <h2>Recent Imagine jobs</h2>
  <div class="card" id="jobs"></div>
<script>
const tokKey = 'bs_admin_token';
const $ = (id) => document.getElementById(id);
function token() { return localStorage.getItem(tokKey) || ''; }
$('token').value = token();
$('saveToken').onclick = () => { localStorage.setItem(tokKey, $('token').value.trim()); $('authStatus').textContent = 'Saved'; loadAll(); };
async function api(path, opts={}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(), ...(opts.headers||{}) }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}
function esc(s){ return String(s??'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
async function searchUsers() {
  const q = $('q').value.trim();
  const data = await api('/api/admin/users?q=' + encodeURIComponent(q));
  $('users').innerHTML = '<table><tr><th>ID</th><th>Email</th><th>Tier</th><th>Credits</th><th>Status</th><th>Actions</th></tr>' +
    data.users.map(u => '<tr><td>'+u.id+'</td><td>'+esc(u.email)+'</td><td>'+esc(u.tier)+'</td><td>'+u.video_credits+'</td><td>'+
      (u.disabled_at ? '<span style="color:#f87171">disabled</span>' : '<span class="ok">active</span>') +
    '</td><td>'+
      '<button data-id="'+u.id+'" data-tier="studio" class="setTier">Studio</button> '+
      '<button data-id="'+u.id+'" data-tier="creator" class="setTier ghost">Creator</button> '+
      '<button data-id="'+u.id+'" data-tier="free" class="setTier ghost">Free</button> '+
      '<button data-id="'+u.id+'" class="addCredits ghost">+5 credits</button> '+
      (u.disabled_at
        ? '<button data-id="'+u.id+'" class="enableUser ghost">Enable</button> '
        : '<button data-id="'+u.id+'" class="disableUser ghost">Disable</button> ') +
      '<button data-id="'+u.id+'" class="purgeMedia ghost">Purge media</button></td></tr>').join('') + '</table>';
  document.querySelectorAll('.setTier').forEach(b => b.onclick = async () => {
    await api('/api/admin/users/' + b.dataset.id + '/tier', { method:'POST', body: JSON.stringify({ tier: b.dataset.tier }) });
    searchUsers();
  });
  document.querySelectorAll('.addCredits').forEach(b => b.onclick = async () => {
    await api('/api/admin/users/' + b.dataset.id + '/credits', { method:'POST', body: JSON.stringify({ delta: 5 }) });
    searchUsers();
  });
  document.querySelectorAll('.disableUser').forEach(b => b.onclick = async () => {
    if (!confirm('Disable this user?')) return;
    await api('/api/admin/users/' + b.dataset.id + '/disable', { method:'POST', body: '{}' });
    searchUsers();
  });
  document.querySelectorAll('.enableUser').forEach(b => b.onclick = async () => {
    await api('/api/admin/users/' + b.dataset.id + '/enable', { method:'POST', body: '{}' });
    searchUsers();
  });
  document.querySelectorAll('.purgeMedia').forEach(b => b.onclick = async () => {
    if (!confirm('Delete all uploaded/generated media files for this user?')) return;
    const r = await api('/api/admin/users/' + b.dataset.id + '/purge-media', { method:'POST', body: '{}' });
    alert('Removed ' + (r.deleted || 0) + ' media files');
  });
}
async function loadInvoices() {
  const data = await api('/api/admin/crypto/invoices');
  $('invoices').innerHTML = '<table><tr><th>ID</th><th>User</th><th>Product</th><th>$</th><th>Rail</th><th>Status</th><th></th></tr>' +
    data.invoices.map(i => '<tr><td>'+i.id+'</td><td>'+esc(i.email)+'<div class="muted" style="font-size:11px">#'+i.user_id+'</div></td><td>'+esc(i.product)+'</td><td>'+i.amount_usd+'</td><td>'+
      esc((i.asset ? i.asset + ' · ' : '') + (i.chain || '')) +
      (i.pay_to ? '<div class="muted" style="font-size:11px;word-break:break-all">'+esc(i.pay_to)+'</div>' : '') +
      (i.tx_hash ? '<div class="muted" style="font-size:11px;word-break:break-all">tx '+esc(i.tx_hash)+' · '+esc(i.confirmations||0)+' conf</div>' : '') +
    '</td><td>'+esc(i.status)+(i.admin_note?'<div class="muted" style="font-size:11px">'+esc(i.admin_note)+'</div>':'')+'</td><td>'+
      (i.status === 'pending'
        ? '<button data-id="'+i.id+'" class="markPaid">Verify & credit</button>'
        : '<span class="ok">credited</span>') +
    '</td></tr>').join('') + '</table>';
  document.querySelectorAll('.markPaid').forEach(b => b.onclick = async () => {
    if (!confirm('Mark invoice #'+b.dataset.id+' paid and credit this account?')) return;
    await api('/api/admin/crypto/invoices/' + b.dataset.id + '/pay', { method:'POST', body: '{}' });
    loadInvoices();
  });
}
async function loadJobs() {
  const data = await api('/api/admin/imagine/jobs');
  $('jobs').innerHTML = '<table><tr><th>ID</th><th>User</th><th>Kind</th><th>Status</th><th>Media</th><th>When</th></tr>' +
    data.jobs.map(j => '<tr><td>'+j.id+'</td><td>'+esc(j.email)+'</td><td>'+esc(j.kind)+'</td><td>'+esc(j.status)+'</td><td>'+
      (j.media_url ? '<a href="'+esc(j.media_url)+'" target="_blank">open</a>' : '') +
    '</td><td class="muted">'+esc(j.created_at)+'</td></tr>').join('') + '</table>';
}
async function loadAll() {
  try {
    await api('/api/admin/ping');
    $('authStatus').textContent = 'Connected';
    await Promise.all([searchUsers(), loadInvoices(), loadJobs()]);
  } catch (e) { $('authStatus').textContent = e.message; }
}
$('search').onclick = () => searchUsers().catch(e => alert(e.message));
$('csv').onclick = async () => {
  try {
    const res = await fetch('/api/admin/users.csv', { headers: { Authorization: 'Bearer ' + token() } });
    if (!res.ok) throw new Error('Could not download CSV');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'brand-studio-users.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch (e) { alert(e.message); }
};
loadAll();
</script>
</body>
</html>`;

export function registerAdminRoutes(app) {
  app.get("/admin", (_req, res) => res.type("html").send(ADMIN_HTML));
  app.get("/admin/", (_req, res) => res.type("html").send(ADMIN_HTML));

  app.get("/api/admin/ping", (req, res) => {
    if (!adminToken() && !adminEmails().length) {
      return res.status(503).json({ error: "Admin is not configured. Set ADMIN_TOKEN on the hub." });
    }
    if (!isAdminRequest(req)) return res.status(401).json({ error: "Unauthorized" });
    res.json({ ok: true });
  });

  app.get("/api/admin/users", (req, res) => {
    if (!isAdminRequest(req)) return res.status(401).json({ error: "Unauthorized" });
    const q = String(req.query.q || "").trim().toLowerCase();
    const rows = q
      ? db
          .prepare(
            `SELECT id, email, tier, COALESCE(video_credits,0) AS video_credits, COALESCE(bonus_drafts,0) AS bonus_drafts,
                    created_at, last_login_at, disabled_at, terms_accepted_at
             FROM users WHERE lower(email) LIKE ? ORDER BY id DESC LIMIT 50`
          )
          .all(`%${q}%`)
      : db
          .prepare(
            `SELECT id, email, tier, COALESCE(video_credits,0) AS video_credits, COALESCE(bonus_drafts,0) AS bonus_drafts,
                    created_at, last_login_at, disabled_at, terms_accepted_at
             FROM users ORDER BY id DESC LIMIT 40`
          )
          .all();
    res.json({ users: rows });
  });

  app.get("/api/admin/users.csv", (req, res) => {
    if (!isAdminRequest(req)) return res.status(401).json({ error: "Unauthorized" });
    const rows = db
      .prepare(
        `SELECT c.email, c.source, c.first_seen_at, c.last_login_at, u.tier, u.id AS user_id
         FROM contacts c
         LEFT JOIN users u ON u.id = c.user_id
         ORDER BY c.first_seen_at DESC`
      )
      .all();
    const header = "email,source,first_seen_at,last_login_at,tier,user_id";
    const csv = [
      header,
      ...rows.map((r) =>
        [r.email, r.source, r.first_seen_at, r.last_login_at, r.tier || "", r.user_id || ""]
          .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
          .join(",")
      ),
    ].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=brand-studio-users.csv");
    res.send(csv);
  });

  app.post("/api/admin/users/:id/tier", (req, res) => {
    if (!isAdminRequest(req)) return res.status(401).json({ error: "Unauthorized" });
    const id = Number(req.params.id);
    const tier = String(req.body?.tier || "");
    if (!setUserTier(id, tier)) return res.status(400).json({ error: "Invalid tier" });
    res.json(db.prepare("SELECT id, email, tier FROM users WHERE id = ?").get(id));
  });

  app.post("/api/admin/users/:id/credits", (req, res) => {
    if (!isAdminRequest(req)) return res.status(401).json({ error: "Unauthorized" });
    const id = Number(req.params.id);
    const delta = Number(req.body?.delta) || 0;
    db.prepare("UPDATE users SET video_credits = MAX(0, COALESCE(video_credits,0) + ?) WHERE id = ?").run(delta, id);
    res.json(
      db.prepare("SELECT id, email, COALESCE(video_credits,0) AS video_credits FROM users WHERE id = ?").get(id)
    );
  });

  app.post("/api/admin/users/:id/disable", (req, res) => {
    if (!isAdminRequest(req)) return res.status(401).json({ error: "Unauthorized" });
    const id = Number(req.params.id);
    if (id === 1) return res.status(400).json({ error: "Cannot disable owner user." });
    setUserDisabled(id, true);
    res.json(db.prepare("SELECT id, email, disabled_at FROM users WHERE id = ?").get(id));
  });

  app.post("/api/admin/users/:id/enable", (req, res) => {
    if (!isAdminRequest(req)) return res.status(401).json({ error: "Unauthorized" });
    const id = Number(req.params.id);
    setUserDisabled(id, false);
    res.json(db.prepare("SELECT id, email, disabled_at FROM users WHERE id = ?").get(id));
  });

  app.post("/api/admin/users/:id/purge-media", (req, res) => {
    if (!isAdminRequest(req)) return res.status(401).json({ error: "Unauthorized" });
    const id = Number(req.params.id);
    const rows = db.prepare("SELECT id FROM media WHERE user_id = ?").all(id);
    let deleted = 0;
    for (const row of rows) {
      const file = join(mediaDir, row.id);
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch {
        /* continue */
      }
      deleted++;
    }
    db.prepare("DELETE FROM media WHERE user_id = ?").run(id);
    db.prepare("UPDATE drafts SET media_url = NULL, original_media_url = NULL WHERE user_id = ?").run(id);
    db.prepare("UPDATE ideas SET media_url = NULL WHERE user_id = ?").run(id);
    res.json({ ok: true, deleted });
  });

  app.get("/api/admin/imagine/jobs", (req, res) => {
    if (!isAdminRequest(req)) return res.status(401).json({ error: "Unauthorized" });
    const jobs = db
      .prepare(
        `SELECT j.id, j.user_id, u.email, j.kind, j.status, j.media_url, j.created_at
         FROM imagine_jobs j LEFT JOIN users u ON u.id = j.user_id
         ORDER BY j.id DESC LIMIT 40`
      )
      .all();
    res.json({
      jobs: jobs.map((j) => {
        const id = String(j.media_url || "")
          .split("?")[0]
          .split("/")
          .pop();
        if (!id || !/^[a-f0-9]{32}$/i.test(id)) return j;
        return { ...j, media_url: appendMediaSig(String(j.media_url).split("?")[0], id, 24 * 3600) };
      }),
    });
  });

  app.get("/api/admin/crypto/invoices", (req, res) => {
    if (!isAdminRequest(req)) return res.status(401).json({ error: "Unauthorized" });
    res.json({ invoices: db.prepare("SELECT * FROM crypto_invoices ORDER BY id DESC LIMIT 50").all() });
  });

  app.post("/api/admin/crypto/invoices/:id/pay", (req, res) => {
    if (!isAdminRequest(req)) return res.status(401).json({ error: "Unauthorized" });
    const inv = markCryptoPaid(Number(req.params.id), req.body?.note || "");
    if (!inv) return res.status(404).json({ error: "Not found" });
    res.json(inv);
  });
}
