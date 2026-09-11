const SCHEME = "saltbubble";
const WEB_PAIR_PATH = "/salt-bubble/pair";
const DEFAULT_CAPTURE = "https://app.mybrandstudio.club/capture";
const WEB_ORIGIN = "https://app.mybrandstudio.club";

export type SaltBubblePair = {
  hub: string;
  key: string;
  capture: string;
};

export function looksSafeHub(hub: Stringish): boolean {
  const root = String(hub || "").trim().toLowerCase();
  return (
    root.startsWith("https://") ||
    root.startsWith("http://localhost") ||
    root.startsWith("http://127.0.0.1")
  );
}

export function buildSaltBubblePair(input: {
  hub: string;
  key: string;
  capture?: string;
}): SaltBubblePair {
  const hub = input.hub.trim().replace(/\/$/, "");
  const key = input.key.trim();
  const capture = (input.capture || DEFAULT_CAPTURE).trim() || DEFAULT_CAPTURE;
  if (!hub || !key) throw new Error("hub and key are required");
  if (!looksSafeHub(hub)) throw new Error("Hub URL must be https");
  return { hub, key, capture };
}

export function saltBubbleDeepLink(pair: SaltBubblePair): string {
  const q = new URLSearchParams({
    hub: pair.hub,
    key: pair.key,
    capture: pair.capture,
  });
  return `${SCHEME}://pair?${q.toString()}`;
}

export function saltBubbleWebPairUrl(pair: SaltBubblePair, origin = WEB_ORIGIN): string {
  const q = new URLSearchParams({
    hub: pair.hub,
    key: pair.key,
    capture: pair.capture,
  });
  return `${origin.replace(/\/$/, "")}${WEB_PAIR_PATH}?${q.toString()}`;
}

export function parseSaltBubblePair(raw: string): SaltBubblePair | null {
  const text = (raw || "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    const hub = url.searchParams.get("hub") || "";
    const key = url.searchParams.get("key") || url.searchParams.get("token") || "";
    const capture = url.searchParams.get("capture") || DEFAULT_CAPTURE;
    if (!hub || !key) return null;
    return buildSaltBubblePair({ hub, key, capture });
  } catch {
    return null;
  }
}

type Stringish = string | null | undefined;
