export const AUTH_CHANGED_EVENT = "brand:auth-changed";
export const PRIVY_LOGOUT_EVENT = "brand:privy-logout";

export function privyAppId(): string {
  return String(import.meta.env.VITE_PRIVY_APP_ID || "").trim();
}

export function privyEnabled(): boolean {
  return Boolean(privyAppId());
}

export function notifyAuthChanged(): void {
  window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
}

export function requestPrivyLogout(): void {
  window.dispatchEvent(new Event(PRIVY_LOGOUT_EVENT));
}
