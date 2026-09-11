import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { parseSaltBubblePair, saltBubbleDeepLink } from "../lib/saltBubblePair";
import { copyText } from "../lib/share";
import { useToast } from "../lib/toast";

export default function SaltBubblePair() {
  const toast = useToast();
  const [params] = useSearchParams();
  const raw = typeof window === "undefined" ? "" : window.location.href;
  const pair = useMemo(() => {
    const fromUrl = parseSaltBubblePair(raw);
    if (fromUrl) return fromUrl;
    const hub = params.get("hub") || "";
    const key = params.get("key") || params.get("token") || "";
    const capture = params.get("capture") || "";
    return parseSaltBubblePair(`https://app.mybrandstudio.club/salt-bubble/pair?hub=${encodeURIComponent(hub)}&key=${encodeURIComponent(key)}&capture=${encodeURIComponent(capture)}`);
  }, [params, raw]);

  if (!pair) {
    return (
      <div className="screen">
        <div className="header">
          <h1>
            <span className="eyebrow">SALT BUBBLE</span>
            Pairing link is incomplete
          </h1>
        </div>
        <div className="card">
          <p className="card-desc">
            Create an agent key in Brand Studio → Agents, then tap <b>Open Salt Bubble</b> on this phone.
          </p>
        </div>
      </div>
    );
  }

  const deep = saltBubbleDeepLink(pair);

  return (
    <div className="screen">
      <div className="header">
        <h1>
          <span className="eyebrow">SALT BUBBLE</span>
          Pair Brand Studio
        </h1>
      </div>
      <div className="card">
        <p className="card-desc">
          This writes your hub URL and agent key into Salt Bubble. The key can save ideas — it cannot publish or approve.
        </p>
        <p className="muted small" style={{ marginTop: 8 }}>
          Hub: {pair.hub}
        </p>
        <a className="btn primary" href={deep} style={{ marginTop: 14, textDecoration: "none", display: "inline-block" }}>
          Open Salt Bubble
        </a>
        <button
          className="btn ghost"
          style={{ marginTop: 10 }}
          onClick={async () => {
            await copyText(deep);
            toast("Pair link copied");
          }}
        >
          Copy pair link
        </button>
      </div>
    </div>
  );
}
