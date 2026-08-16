/**
 * Watch deposit addresses for incoming SOL / ETH / USDC / USDT and auto-credit
 * pending crypto invoices after enough confirmations.
 * Admin "Verify & credit" remains as a manual fallback.
 */
import { db } from "./db.js";
import { markCryptoPaid, listCryptoMethods, CRYPTO_METHOD_DEFS } from "./admin.js";

const SOL_CONFIRMS = Math.max(1, Number(process.env.CRYPTO_SOL_CONFIRMATIONS || 32));
const ETH_CONFIRMS = Math.max(1, Number(process.env.CRYPTO_ETH_CONFIRMATIONS || 12));
const NATIVE_TOLERANCE = 0.08; // ±8% for SOL/ETH vs live USD
const LOOKBACK_HOURS = Math.max(1, Number(process.env.CRYPTO_WATCH_LOOKBACK_HOURS || 72));

function solRpc() {
  return (process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com").trim();
}
function ethRpc() {
  return (process.env.ETH_RPC_URL || "https://ethereum.publicnode.com").trim();
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
  return body.result;
}

function methodDef(inv) {
  if (inv.method_id) {
    return CRYPTO_METHOD_DEFS.find((m) => m.id === inv.method_id) || null;
  }
  return (
    CRYPTO_METHOD_DEFS.find(
      (m) =>
        m.chain === String(inv.chain || "").toLowerCase() &&
        m.asset === String(inv.asset || "").toUpperCase()
    ) || null
  );
}

export function expectedRawForMethod(method, amountUsd) {
  const usd = Number(amountUsd) || 0;
  if (!method || usd <= 0) return null;
  if (method.asset === "USDC" || method.asset === "USDT") {
    return String(Math.round(usd * 1e6));
  }
  return null; // native matched via live USD price
}

async function fetchUsdPrices() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana,ethereum&vs_currencies=usd",
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) return { sol: null, eth: null };
    const j = await res.json();
    return {
      sol: Number(j?.solana?.usd) || null,
      eth: Number(j?.ethereum?.usd) || null,
    };
  } catch {
    return { sol: null, eth: null };
  }
}

function attachTx(invoiceId, txHash, confirmations) {
  const ts = new Date().toISOString();
  db.prepare(
    `UPDATE crypto_invoices
     SET tx_hash = ?, confirmations = ?, detected_at = COALESCE(detected_at, ?), updated_at = ?
     WHERE id = ? AND status = 'pending'`
  ).run(txHash, confirmations, ts, ts, invoiceId);
}

function amountMatches(inv, receivedRaw, usdPrice) {
  const def = methodDef(inv);
  if (!def) return false;
  let received;
  try {
    received = BigInt(String(receivedRaw));
  } catch {
    return false;
  }
  if (received <= 0n) return false;

  if (def.asset === "USDC" || def.asset === "USDT") {
    let expected;
    try {
      expected = BigInt(inv.expected_raw || Math.round(Number(inv.amount_usd) * 1e6));
    } catch {
      return false;
    }
    if (expected <= 0n) return false;
    const diff = received > expected ? received - expected : expected - received;
    const pct = expected / 50n; // 2%
    const floor = 10_000n; // $0.01
    return diff <= (pct > floor ? pct : floor);
  }

  if (!usdPrice || usdPrice <= 0) return false;
  const decimals = def.asset === "SOL" ? 9 : 18;
  const whole = Number(received) / 10 ** decimals;
  const usd = whole * usdPrice;
  const target = Number(inv.amount_usd) || 0;
  if (target <= 0) return false;
  return Math.abs(usd - target) / target <= NATIVE_TOLERANCE;
}

function pendingInvoices(chain, asset) {
  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600e3).toISOString();
  return db
    .prepare(
      `SELECT * FROM crypto_invoices
       WHERE status = 'pending'
         AND lower(chain) = lower(?)
         AND upper(asset) = upper(?)
         AND created_at >= ?
       ORDER BY created_at ASC`
    )
    .all(chain, asset, since);
}

function txUsedByOther(txHash, invoiceId) {
  if (!txHash) return true;
  const row = db.prepare("SELECT id FROM crypto_invoices WHERE tx_hash = ?").get(txHash);
  return Boolean(row && row.id !== invoiceId);
}

function findMatch(invoices, receivedRaw, usdPrice, txHash) {
  for (const inv of invoices) {
    if (txUsedByOther(txHash, inv.id)) continue;
    if (inv.tx_hash && inv.tx_hash !== txHash) continue;
    if (amountMatches(inv, receivedRaw, usdPrice)) return inv;
  }
  return null;
}

async function creditIfConfirmed(inv, txHash, confirmations, required, note) {
  attachTx(inv.id, txHash, confirmations);
  if (confirmations < required) return false;
  markCryptoPaid(inv.id, note || `auto confirmed ${txHash.slice(0, 12)}… (${confirmations} conf)`);
  console.log(`[crypto] credited invoice #${inv.id} via ${txHash} (${confirmations} conf)`);
  return true;
}

// ---- Solana ----

async function solTokenAccounts(owner, mint) {
  const result = await rpc(solRpc(), "getTokenAccountsByOwner", [
    owner,
    { mint },
    { encoding: "jsonParsed" },
  ]);
  return (result?.value || []).map((v) => v.pubkey).filter(Boolean);
}

async function solSignatures(address, untilIso) {
  const untilMs = new Date(untilIso).getTime() - 60_000;
  const sigs = await rpc(solRpc(), "getSignaturesForAddress", [
    address,
    { limit: 25 },
  ]);
  return (sigs || []).filter((s) => {
    if (s.err) return false;
    const t = (s.blockTime || 0) * 1000;
    return !untilMs || t >= untilMs || !s.blockTime;
  });
}

async function solTxDetail(signature) {
  return rpc(solRpc(), "getTransaction", [
    signature,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
  ]);
}

async function solSlot() {
  return rpc(solRpc(), "getSlot", [{ commitment: "finalized" }]);
}

function solNativeReceived(tx, payTo) {
  const meta = tx?.meta;
  const keys = tx?.transaction?.message?.accountKeys || [];
  if (!meta || !keys.length) return 0n;
  let idx = -1;
  for (let i = 0; i < keys.length; i++) {
    const k = typeof keys[i] === "string" ? keys[i] : keys[i]?.pubkey;
    if (k === payTo) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return 0n;
  const pre = BigInt(meta.preBalances?.[idx] ?? 0);
  const post = BigInt(meta.postBalances?.[idx] ?? 0);
  return post > pre ? post - pre : 0n;
}

function solTokenReceived(tx, payTo, mint) {
  const meta = tx?.meta;
  if (!meta) return 0n;
  const pre = meta.preTokenBalances || [];
  const post = meta.postTokenBalances || [];
  // Sum by owner+mint
  const key = (b) => `${b.owner || ""}:${b.mint || ""}`;
  const preMap = new Map();
  for (const b of pre) {
    if (b.mint !== mint) continue;
    if (b.owner && b.owner !== payTo) continue;
    preMap.set(key(b), BigInt(b.uiTokenAmount?.amount || 0));
  }
  let delta = 0n;
  for (const b of post) {
    if (b.mint !== mint) continue;
    if (b.owner && b.owner !== payTo) continue;
    const after = BigInt(b.uiTokenAmount?.amount || 0);
    const before = preMap.get(key(b)) || 0n;
    if (after > before) delta += after - before;
  }
  // Some txs only list post with owner; also accept destination token account owner match via accountKeys
  if (delta > 0n) return delta;
  return 0n;
}

async function watchSolana(prices) {
  const methods = listCryptoMethods().filter((m) => m.chain === "solana");
  if (!methods.length) return;
  const payTo = methods[0].pay_to;
  const tip = await solSlot();

  for (const method of methods) {
    const invoices = pendingInvoices("solana", method.asset);
    if (!invoices.length) continue;
    const oldest = invoices[0].created_at;
    const addresses =
      method.kind === "token" && method.token
        ? await solTokenAccounts(payTo, method.token)
        : [payTo];
    if (!addresses.length && method.kind === "token") continue;

    for (const address of addresses.length ? addresses : [payTo]) {
      let sigs = [];
      try {
        sigs = await solSignatures(address, oldest);
      } catch (e) {
        console.warn("[crypto] sol signatures", e.message);
        continue;
      }
      for (const s of sigs) {
        let tx;
        try {
          tx = await solTxDetail(s.signature);
        } catch {
          continue;
        }
        if (!tx) continue;
        const received =
          method.kind === "token"
            ? solTokenReceived(tx, payTo, method.token)
            : solNativeReceived(tx, payTo);
        if (received <= 0n) continue;
        const conf = Math.max(0, Number(tip) - Number(tx.slot || 0));
        const match = findMatch(invoices, received, prices.sol, s.signature);
        if (!match) continue;
        await creditIfConfirmed(
          match,
          s.signature,
          conf,
          SOL_CONFIRMS,
          `auto solana ${method.asset} ${s.signature}`
        );
        break;
      }
    }
  }
}

// ---- Ethereum ----

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function padAddress(addr) {
  return "0x" + addr.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
}

async function ethBlockNumber() {
  const hex = await rpc(ethRpc(), "eth_blockNumber", []);
  return parseInt(hex, 16);
}

async function watchEthTokens(_prices) {
  const methods = listCryptoMethods().filter((m) => m.chain === "ethereum" && m.kind === "token");
  if (!methods.length) return;
  const payTo = methods[0].pay_to;
  const tip = await ethBlockNumber();
  const fromBlock = Math.max(0, tip - 4000); // ~14h

  for (const method of methods) {
    const invoices = pendingInvoices("ethereum", method.asset);
    if (!invoices.length) continue;
    let logs = [];
    try {
      logs = await rpc(ethRpc(), "eth_getLogs", [
        {
          fromBlock: "0x" + fromBlock.toString(16),
          toBlock: "0x" + tip.toString(16),
          address: method.token,
          topics: [TRANSFER_TOPIC, null, padAddress(payTo)],
        },
      ]);
    } catch (e) {
      console.warn("[crypto] eth logs", method.asset, e.message);
      continue;
    }
    for (const log of logs || []) {
      const txHash = log.transactionHash;
      if (!txHash) continue;
      const raw = BigInt(log.data || "0x0");
      if (raw <= 0n) continue;
      const block = parseInt(log.blockNumber, 16);
      const conf = Math.max(0, tip - block + 1);
      const match = findMatch(invoices, raw, null, txHash);
      if (!match) continue;
      await creditIfConfirmed(match, txHash, conf, ETH_CONFIRMS, `auto ethereum ${method.asset} ${txHash}`);
      break;
    }
  }
}

async function watchEthNative(prices) {
  const methods = listCryptoMethods().filter((m) => m.chain === "ethereum" && m.asset === "ETH");
  if (!methods.length) return;
  const invoices = pendingInvoices("ethereum", "ETH");
  if (!invoices.length) return;
  const payTo = methods[0].pay_to.toLowerCase();
  const tip = await ethBlockNumber();
  // Scan recent blocks for value transfers to our address
  const depth = Math.min(80, Math.max(ETH_CONFIRMS + 5, 40));
  for (let b = tip; b > tip - depth; b--) {
    let block;
    try {
      block = await rpc(ethRpc(), "eth_getBlockByNumber", ["0x" + b.toString(16), true]);
    } catch {
      continue;
    }
    if (!block?.transactions) continue;
    for (const tx of block.transactions) {
      if (!tx?.to || String(tx.to).toLowerCase() !== payTo) continue;
      const value = BigInt(tx.value || "0x0");
      if (value <= 0n) continue;
      const txHash = tx.hash;
      const conf = Math.max(0, tip - b + 1);
      const match = findMatch(invoices, value, prices.eth, txHash);
      if (!match) continue;
      await creditIfConfirmed(match, txHash, conf, ETH_CONFIRMS, `auto ethereum ETH ${txHash}`);
      return;
    }
  }
}

export async function syncCryptoDeposits() {
  const methods = listCryptoMethods();
  if (!methods.length) return { checked: 0 };

  const pending = db
    .prepare(`SELECT COUNT(*) AS n FROM crypto_invoices WHERE status = 'pending'`)
    .get()?.n;
  if (!pending) return { checked: 0 };

  const prices = await fetchUsdPrices();
  try {
    await watchSolana(prices);
  } catch (e) {
    console.warn("[crypto] solana watch", e.message);
  }
  try {
    await watchEthTokens(prices);
  } catch (e) {
    console.warn("[crypto] eth tokens", e.message);
  }
  try {
    await watchEthNative(prices);
  } catch (e) {
    console.warn("[crypto] eth native", e.message);
  }
  return { checked: pending, prices };
}
