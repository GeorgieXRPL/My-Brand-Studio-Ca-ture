import * as jose from "jose";

const JWT_ISSUER = "privy.io";
const JWT_ALG = "ES256";

export function privyConfigured() {
  return Boolean(process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET);
}

function appId() {
  return (process.env.PRIVY_APP_ID || "").trim();
}

function appSecret() {
  return (process.env.PRIVY_APP_SECRET || "").trim();
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

let remoteJwks;

function verificationKey() {
  const pem = (process.env.PRIVY_VERIFICATION_KEY || "").trim().replace(/\\n/g, "\n");
  if (pem) return jose.importSPKI(pem, JWT_ALG);
  if (!remoteJwks) {
    const url =
      process.env.PRIVY_JWKS_URL ||
      `https://auth.privy.io/api/v1/apps/${appId()}/jwks.json`;
    remoteJwks = jose.createRemoteJWKSet(new URL(url));
  }
  return remoteJwks;
}

export async function verifyPrivyAccessToken(accessToken) {
  if (!privyConfigured()) throw httpError(501, "Privy sign-in isn't configured.");
  const token = String(accessToken || "").trim();
  if (!token) throw httpError(400, "Missing Privy token.");
  try {
    const { payload } = await jose.jwtVerify(token, await verificationKey(), {
      issuer: JWT_ISSUER,
      audience: appId(),
      algorithms: [JWT_ALG],
    });
    const did = String(payload.sub || "");
    if (!did.startsWith("did:privy:")) throw new Error("missing privy did");
    return did;
  } catch (err) {
    if (err.status) throw err;
    throw httpError(401, "Privy session expired. Sign in again.");
  }
}

export async function fetchPrivyUser(did) {
  const auth = Buffer.from(`${appId()}:${appSecret()}`).toString("base64");
  const res = await fetch(`https://auth.privy.io/api/v1/users/${encodeURIComponent(did)}`, {
    headers: {
      Authorization: `Basic ${auth}`,
      "privy-app-id": appId(),
    },
  });
  if (!res.ok) throw httpError(401, "Could not read Privy profile.");
  return res.json();
}

export function emailFromPrivyProfile(user) {
  const accounts = Array.isArray(user?.linked_accounts)
    ? user.linked_accounts
    : Array.isArray(user?.linkedAccounts)
      ? user.linkedAccounts
      : [];
  const emails = [];
  for (const account of accounts) {
    if (!accountVerified(account)) continue;
    const email = accountEmail(account);
    if (email) emails.push({ email, prefer: String(account?.type || "") === "email" });
  }
  const preferred = emails.find((e) => e.prefer);
  return (preferred || emails[0])?.email || "";
}

function accountEmail(account) {
  const value = account?.address || account?.email;
  if (!value || !String(value).includes("@")) return "";
  return String(value).trim().toLowerCase();
}

function accountVerified(account) {
  if (!account) return false;
  if (account.verified === false) return false;
  if (account.verified === true) return true;
  if (
    account.first_verified_at ||
    account.verified_at ||
    account.verifiedAt ||
    account.firstVerifiedAt
  ) {
    return true;
  }
  const type = String(account.type || "");
  // Google/Apple OAuth emails are verified by the provider. Bare email
  // accounts must carry a Privy verification timestamp.
  return type === "google_oauth" || type === "apple_oauth";
}

export function syntheticPrivyEmail(did) {
  const id = String(did || "")
    .replace(/^did:privy:/, "")
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 32);
  return `privy.${id || "user"}@users.privy.invalid`;
}
