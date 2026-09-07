import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hub-hard-"));
process.env.DB_PATH = join(dir, "hub.db");
process.env.MEDIA_SIGNING_SECRET = "test-media-signing-secret-32b";

const {
  createAuthToken,
  consumeAuthToken,
  signup,
  requestPasswordReset,
  resetPassword,
  findOrCreateGoogleUser,
  createSession,
  resolveSession,
} = await import("./auth.js");
const { db } = await import("./db.js");
const { takeRateLimit } = await import("./rateLimit.js");
const { signMediaId, verifyMediaSig, appendMediaSig } = await import("./mediaSign.js");
const { uniqueStableExpectedRaw, createCryptoInvoice } = await import("./admin.js");
const { findMatch } = await import("./cryptoWatch.js");

test("consumeAuthToken only burns the matching kind", () => {
  const token = createAuthToken("verify", { userId: 1, email: "a@b.c" }, 60_000);
  assert.equal(consumeAuthToken("reset", token), null);
  const row = consumeAuthToken("verify", token);
  assert.equal(row.user_id, 1);
  assert.equal(consumeAuthToken("verify", token), null);
});

test("password signup stays unverified until Google reclaim", () => {
  const user = signup("victim@example.com", "password1", "", { termsAccepted: true });
  const row = db.prepare("SELECT password_hash, email_verified_at FROM users WHERE id = ?").get(user.id);
  assert.ok(row.password_hash);
  assert.equal(row.email_verified_at, null);

  const google = findOrCreateGoogleUser("victim@example.com");
  assert.equal(google.id, user.id);
  const after = db.prepare("SELECT password_hash, email_verified_at FROM users WHERE id = ?").get(user.id);
  assert.equal(after.password_hash, null);
  assert.ok(after.email_verified_at);
});

test("verified password accounts refuse Google merge", () => {
  const user = signup("kept@example.com", "password1", "", { termsAccepted: true });
  db.prepare("UPDATE users SET email_verified_at = ? WHERE id = ?").run(new Date().toISOString(), user.id);
  assert.throws(() => findOrCreateGoogleUser("kept@example.com"), /already exists/);
});

test("password reset signs the inbox, kills sessions and keys", () => {
  const user = signup("resetme@example.com", "password1", "", { termsAccepted: true });
  const session = createSession(user.id);
  db.prepare(
    "INSERT INTO api_keys (user_id, name, key_hash, created_at) VALUES (?, ?, ?, ?)"
  ).run(user.id, "agent", "abc", new Date().toISOString());
  const reset = requestPasswordReset("resetme@example.com");
  assert.ok(reset?.token);
  const out = resetPassword(reset.token, "newpass12");
  assert.equal(out.email, "resetme@example.com");
  assert.equal(resolveSession(session), null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?").get(user.id).n, 0);
  const verified = db.prepare("SELECT email_verified_at FROM users WHERE id = ?").get(user.id);
  assert.ok(verified.email_verified_at);
});

test("signed media URLs expire", () => {
  const id = "a".repeat(32);
  const { exp, sig } = signMediaId(id, 60);
  assert.equal(verifyMediaSig(id, exp, sig), true);
  assert.equal(verifyMediaSig(id, exp, "0".repeat(32)), false);
  assert.equal(verifyMediaSig(id, Math.floor(Date.now() / 1000) - 10, sig), false);
  assert.match(appendMediaSig("/media/" + id, id, 60), /[?&]s=/);
});

test("sqlite rate limiter shares a bucket", () => {
  assert.equal(takeRateLimit("t:one", 2, 60_000), 0);
  assert.equal(takeRateLimit("t:one", 2, 60_000), 0);
  assert.ok(takeRateLimit("t:one", 2, 60_000) >= 1);
  assert.equal(takeRateLimit("t:two", 2, 60_000), 0);
});

test("stable invoices get unique expected_raw and exact-match only", () => {
  const ts = new Date().toISOString();
  db.prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, NULL, ?)").run("pay@example.com", ts);
  const userId = db.prepare("SELECT id FROM users WHERE email = ?").get("pay@example.com").id;
  const a = uniqueStableExpectedRaw("solana", "USDC", 29);
  createCryptoInvoice({
    userId,
    email: "pay@example.com",
    product: "creator",
    amountUsd: 29,
    chain: "solana",
    asset: "USDC",
    methodId: "usdc_sol",
    payTo: "addr",
    memo: "A",
    expectedRaw: a,
  });
  const b = uniqueStableExpectedRaw("solana", "USDC", 29);
  assert.notEqual(a, b);
  createCryptoInvoice({
    userId,
    email: "pay@example.com",
    product: "creator",
    amountUsd: 29,
    chain: "solana",
    asset: "USDC",
    methodId: "usdc_sol",
    payTo: "addr",
    memo: "B",
    expectedRaw: b,
  });
  const invoices = db
    .prepare("SELECT * FROM crypto_invoices WHERE status = 'pending' AND asset = 'USDC'")
    .all();
  const hit = findMatch(invoices, a, null, "tx-unique");
  assert.equal(String(hit.expected_raw), String(a));
  assert.equal(findMatch(invoices, "1", null, "tx-none"), null);
});

test("ambiguous native deposits are not auto-credited", () => {
  const invoices = [
    { id: 101, amount_usd: 29, chain: "solana", asset: "SOL", method_id: "sol", tx_hash: null },
    { id: 102, amount_usd: 29, chain: "solana", asset: "SOL", method_id: "sol", tx_hash: null },
  ];
  const lamports = String(Math.round((29 / 150) * 1e9));
  assert.equal(findMatch(invoices, lamports, 150, "sig-ambiguous"), null);
});
