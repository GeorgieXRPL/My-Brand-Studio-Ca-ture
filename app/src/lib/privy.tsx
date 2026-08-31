import { type ReactNode, useEffect, useRef } from "react";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import { api, clearHubConfig, isSelfHost, setAuth } from "./api";
import {
  PRIVY_LOGOUT_EVENT,
  notifyAuthChanged,
  privyAppId,
} from "./privy-env";
import { useToast } from "./toast";
import { useT } from "./i18n";

export {
  AUTH_CHANGED_EVENT,
  PRIVY_LOGOUT_EVENT,
  notifyAuthChanged,
  privyAppId,
  privyEnabled,
  requestPrivyLogout,
} from "./privy-env";

let bindInflight: Promise<string | null> | null = null;

export function bindPrivyToken(accessToken: string): Promise<string | null> {
  if (isSelfHost()) return Promise.resolve(null);
  if (localStorage.getItem("authToken")) return Promise.resolve(localStorage.getItem("authEmail"));
  if (!bindInflight) {
    bindInflight = (async () => {
      try {
        const ref = localStorage.getItem("refCode") || undefined;
        const result = await api.privyLogin(accessToken, ref);
        clearHubConfig();
        setAuth(result.token, result.email);
        notifyAuthChanged();
        return result.email;
      } finally {
        bindInflight = null;
      }
    })();
  }
  return bindInflight;
}

export function PrivyRoot({ children }: { children: ReactNode }) {
  const appId = privyAppId();
  if (!appId) return children;
  const clientId = String(import.meta.env.VITE_PRIVY_CLIENT_ID || "").trim();
  return (
    <PrivyProvider
      appId={appId}
      {...(clientId ? { clientId } : {})}
      config={{
        loginMethods: ["email", "google", "wallet"],
        appearance: {
          theme: "dark",
          accentColor: "#8b5cf6",
          logo: "/icon.svg",
        },
        embeddedWallets: {
          ethereum: { createOnLogin: "off" },
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}

export function PrivyHubBinder() {
  const { ready, authenticated, getAccessToken, logout } = usePrivy();
  const toast = useToast();
  const t = useT();
  const welcomed = useRef(false);

  useEffect(() => {
    const onLogout = () => {
      welcomed.current = false;
      void logout();
    };
    window.addEventListener(PRIVY_LOGOUT_EVENT, onLogout);
    return () => window.removeEventListener(PRIVY_LOGOUT_EVENT, onLogout);
  }, [logout]);

  useEffect(() => {
    if (!ready || !authenticated) return;
    if (isSelfHost() || localStorage.getItem("authToken")) return;
    let cancelled = false;
    void (async () => {
      try {
        const accessToken = await getAccessToken();
        if (!accessToken || cancelled) return;
        const email = await bindPrivyToken(accessToken);
        if (!cancelled && email && !welcomed.current) {
          welcomed.current = true;
          toast(t("Signed in with Privy"));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : t("Privy sign-in failed");
        toast(message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, authenticated, getAccessToken, toast, t]);

  return null;
}
