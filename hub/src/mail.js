// Owner notifications (new signups + logins) via Resend.
// Never block auth if mail fails.

const OWNER = (process.env.OWNER_NOTIFY_EMAIL || "hello@mybrandstudio.club").trim();
const FROM = (process.env.MAIL_FROM || "Brand Studio <beth.t@example.com>").trim();
const LOGIN_NOTIFY_MS = Math.max(0, Number(process.env.LOGIN_NOTIFY_HOURS || 12)) * 3600e3;

export function mailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && OWNER);
}

export async function notifyOwner({ subject, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !OWNER) {
    console.log("[mail:skip]", subject);
    return false;
  }
  return sendResend({ to: [OWNER], subject, text });
}

export async function sendUserMail({ to, subject, text }) {
  const email = String(to || "").trim().toLowerCase();
  if (!email || !email.includes("@") || email.endsWith(".invalid") || email.endsWith("@selfhost.local")) {
    return false;
  }
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log("[mail:user:skip]", email, subject);
    return false;
  }
  return sendResend({ to: [email], subject, text });
}

async function sendResend({ to, subject, text }) {
  const key = process.env.RESEND_API_KEY;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM, to, subject, text }),
    });
    if (!res.ok) {
      console.error("[mail]", res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("[mail]", err.message);
    return false;
  }
}

/**
 * Upsert the email list, stamp last_login, and email ops.
 * Signups always notify. Logins notify at most once per LOGIN_NOTIFY_HOURS.
 */
export function recordAuthEvent({ userId, email, method, isNew }) {
  const ts = new Date().toISOString();
  const source = method === "google" ? "google" : method === "privy" ? "privy" : "password";
  const row = {
    email: String(email || "").trim().toLowerCase(),
    userId,
    source,
    isNew: Boolean(isNew),
    ts,
  };
  if (!row.email || row.email.endsWith("@selfhost.local") || row.email.endsWith(".invalid")) return;

  return row;
}

export function shouldNotifyLogin(lastNotifiedAt, isNew) {
  if (isNew) return true;
  if (!lastNotifiedAt) return true;
  const then = Date.parse(lastNotifiedAt);
  if (!Number.isFinite(then)) return true;
  return Date.now() - then >= LOGIN_NOTIFY_MS;
}

export function ownerInbox() {
  return OWNER;
}

export function formatAuthMail({ email, method, isNew, userId, ts }) {
  const kind = isNew ? "New signup" : "Login";
  const via = method === "google" ? "Google" : method === "privy" ? "Privy" : "email";
  return {
    subject: `${kind}: ${email} (${via})`,
    text: [
      `${kind} on Brand Studio`,
      "",
      `Email: ${email}`,
      `Method: ${via}`,
      `User id: ${userId}`,
      `When: ${ts}`,
      "",
      `This address is on the user list. Reply not needed.`,
    ].join("\n"),
  };
}
