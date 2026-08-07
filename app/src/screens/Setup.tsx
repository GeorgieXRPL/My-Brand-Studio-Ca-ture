import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  api,
  clearAuth,
  clearHubConfig,
  getAuthEmail,
  getHubToken,
  getHubUrl,
  isConfigured,
  isSelfHost,
  setAuth,
  setHubConfig,
} from "../lib/api";
import { useToast } from "../lib/toast";
import { isVoiceSupported } from "../lib/voice";
import {
  DownloadIcon,
  DumbbellIcon,
  GearIcon,
  GiftIcon,
  KeyIcon,
  PlugIcon,
  QrIcon,
  SparkIcon,
  UserIcon,
} from "../lib/icons";
import QrScanner, { isScanSupported } from "../lib/QrScanner";
import { resetTour } from "../lib/Tour";
import { copyText, shareText } from "../lib/share";
import { getTextScale, MAX_TEXT_SCALE, MIN_TEXT_SCALE, setTextScale } from "../lib/viewportZoom";
import { PLAN_COPY, tierAtLeast } from "../lib/plans";
import { useLocale } from "../lib/i18n";
import { OUTPUT_LANGUAGES } from "../lib/languages";
import { PLATFORM_LABELS, type BrandTraits, type Connections, type Me, type Platform } from "../lib/types";

const STYLE_OPTIONS = ["Educational", "Entertaining", "Inspirational", "Behind-the-scenes", "Storytelling", "Contrarian"];
const TYPE_OPTIONS = ["Short video", "Photo posts", "Threads", "Carousels", "Live/streams", "Long-form"];
const VIBE_OPTIONS = ["Hype & energetic", "Calm & authentic", "Funny & playful", "Premium & polished", "Raw & unfiltered"];
const EMOJI_OPTIONS = ["None", "Light (1-2 per post)", "Expressive"];
const CTA_OPTIONS = ["Ask a question", "Follow for more", "Link in bio", "Soft / none"];
const LINKABLE: Platform[] = ["facebook", "instagram", "tiktok", "linkedin"];

const TIER_LABELS: Record<string, string> = { free: "Free", creator: "Creator", studio: "Studio" };

export default function Setup() {
  const toast = useToast();
  const { t, locale, setLocale } = useLocale();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [authBusy, setAuthBusy] = useState(false);
  const [signedInAs, setSignedInAs] = useState(isSelfHost() ? "" : getAuthEmail());

  const [showSelfHost, setShowSelfHost] = useState(isSelfHost() || params.get("scan") === "1");
  const [url, setUrl] = useState(isSelfHost() ? getHubUrl() : "");
  const [token, setToken] = useState(getHubToken());
  const [status, setStatus] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [scanning, setScanning] = useState(params.get("scan") === "1" && isScanSupported());

  const [goals, setGoals] = useState("");
  const [projects, setProjects] = useState("");
  const [voice, setVoice] = useState("");
  const [traits, setTraits] = useState<BrandTraits>({});
  const [connected, setConnected] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);

  const [conns, setConns] = useState<Connections | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [textScale, setTextScaleState] = useState(() => getTextScale());
  const [billingBusy, setBillingBusy] = useState(false);
  const [googleAvailable, setGoogleAvailable] = useState(false);

  useEffect(() => {
    const onScale = (e: Event) => {
      const detail = (e as CustomEvent<number>).detail;
      if (typeof detail === "number") setTextScaleState(detail);
      else setTextScaleState(getTextScale());
    };
    window.addEventListener("brand:textscale", onScale);
    return () => window.removeEventListener("brand:textscale", onScale);
  }, []);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    if (hash.get("gtoken")) {
      clearHubConfig();
      setAuth(hash.get("gtoken")!, hash.get("gemail") || "");
      setSignedInAs(hash.get("gemail") || "");
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      toast(t("Signed in with Google"));
    } else if (hash.get("gerror")) {
      toast(hash.get("gerror")!);
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }

    if (params.get("billing") === "success") {
      toast(t("You're upgraded — welcome aboard"));
      window.history.replaceState(null, "", "/setup");
    } else if (params.get("billing") === "cancel") {
      toast(t("Checkout cancelled"));
      window.history.replaceState(null, "", "/setup");
    }

    if (isConfigured()) {
      setStatus("ok");
      loadProfile();
    }
    api
      .authProviders()
      .then((p) => setGoogleAvailable(p.google))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadProfile() {
    try {
      const p = await api.getProfile();
      setGoals(p.goals || "");
      setProjects(p.projects || "");
      setVoice(p.brand_voice || "");
      setTraits(p.traits || {});
      if (p.traits?.preferred_language) setLocale(p.traits.preferred_language);
      setConnected(true);
    } catch {
      setConnected(false);
      return;
    }
    try {
      const [c, m] = await Promise.all([api.getConnections(), api.me()]);
      setConns(c);
      setMe(m);
    } catch {
      /* older hubs */
    }
  }

  function toggleContentType(t: string) {
    const cur = traits.content_types || [];
    setTraits({
      ...traits,
      content_types: cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t],
    });
  }

  async function connectX() {
    try {
      const { url: authUrl } = await api.startConnectX();
      window.open(authUrl, "_blank");
      toast(t("Approve access, then come back and refresh"));
    } catch (e: any) {
      toast(e.message);
    }
  }

  async function disconnectPlatform(platform: Platform) {
    await api.disconnect(platform);
    toast(t("Disconnected"));
    loadProfile();
  }

  function connectAction(p: Platform, providerStatus: string) {
    if (p === "x" && providerStatus === "available") {
      return (
        <button className="btn sm" style={{ marginLeft: "auto" }} onClick={connectX}>
          {t("Connect")}
        </button>
      );
    }
    // Meta / TikTok / LinkedIn: official APIs in progress — don't promise link or live metrics yet.
    if (LINKABLE.includes(p)) {
      return (
        <span className="muted small" style={{ marginLeft: "auto" }}>
          {t("Coming soon")}
        </span>
      );
    }
    return (
      <span className="muted small" style={{ marginLeft: "auto" }}>
        {providerStatus === "unsupported" ? t("use Share") : t("use Share for now")}
      </span>
    );
  }

  async function startCheckout(tier: "creator" | "studio") {
    setBillingBusy(true);
    try {
      if (me?.billing_configured) {
        const { url: checkoutUrl } = await api.billingCheckout(tier);
        window.location.href = checkoutUrl;
        return;
      }
      window.location.href = `mailto:hello@brand-studio.app?subject=Upgrade%20to%20${tier}&body=I'd like to upgrade (${me?.email || ""}) to the ${tier} plan.`;
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBillingBusy(false);
    }
  }

  async function openPortal() {
    setBillingBusy(true);
    try {
      const { url: portalUrl } = await api.billingPortal();
      window.location.href = portalUrl;
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBillingBusy(false);
    }
  }

  async function downloadExport() {
    try {
      const data = await api.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `brand-studio-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e: any) {
      toast(e.message);
    }
  }

  async function submitAuth() {
    if (!email.trim() || !password) return;
    setAuthBusy(true);
    try {
      const result =
        mode === "signup"
          ? await api.signup(email.trim(), password, localStorage.getItem("refCode") || undefined)
          : await api.login(email.trim(), password);
      clearHubConfig();
      setAuth(result.token, result.email);
      setSignedInAs(result.email);
      setPassword("");
      toast(mode === "signup" ? t("Account created — welcome!") : t("Signed in"));
      loadProfile();
    } catch (e: any) {
      toast(e.message);
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    clearAuth();
    setSignedInAs("");
    setConnected(false);
    toast(t("Signed out"));
  }

  async function connectSelfHost(urlValue: string, tokenValue: string) {
    setHubConfig(urlValue.trim(), tokenValue.trim());
    clearAuth();
    setSignedInAs("");
    setStatus("testing");
    try {
      await api.health();
      setStatus("ok");
      toast(t("Connected to your server"));
      loadProfile();
    } catch (e: any) {
      setStatus("fail");
      toast(e.message);
    }
  }

  function disconnectSelfHost() {
    clearHubConfig();
    setUrl("");
    setToken("");
    setStatus("idle");
    setConnected(false);
    toast(t("Back to Brand Studio cloud — sign in above"));
  }

  const handleScan = useCallback((text: string) => {
    try {
      const data = JSON.parse(text);
      if (data.app === "brand-studio" && data.hub && data.token) {
        setScanning(false);
        setUrl(data.hub);
        setToken(data.token);
        connectSelfHost(data.hub, data.token);
        return;
      }
    } catch {
      /* not JSON */
    }
    toast(t("That's not a Brand Studio pairing code"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selfHostActive = isSelfHost();
  const isStudio = tierAtLeast(me?.tier, "studio") || selfHostActive;

  return (
    <div className="screen">
      {scanning && <QrScanner onResult={handleScan} onClose={() => setScanning(false)} />}
      <div className="header">
        <h1>
          <span className="eyebrow">Brand Studio · v2.8.1</span>
          {t("setup.title")}
        </h1>
        <span className="sub">{isVoiceSupported() ? t("voice ready") : t("voice: use Chrome / Safari")}</span>
      </div>

      {/* 1. Account */}
      {!selfHostActive && (
        <div className="card">
          <div className="card-title">
            <UserIcon size={18} />
            {t("Account")}
            {signedInAs && (
              <span style={{ marginLeft: "auto" }} className="small">
                <span className="status-dot ok" />
                {t("signed in")}
              </span>
            )}
          </div>
          {signedInAs ? (
            <>
              <p className="card-desc">{signedInAs} — {t("ideas, drafts and schedule sync here.")}</p>
              {me && (
                <div className="tier-box">
                  <div className="row between">
                    <span className={`tier-badge ${me.tier}`}>{t(TIER_LABELS[me.tier] || me.tier)} {t("plan")}</span>
                    <span className="muted small">
                      {t("{used}/{limit} drafts this month", { used: me.drafts_used, limit: me.drafts_limit })}
                    </span>
                  </div>
                  <div className="progress-track" style={{ marginTop: 8 }}>
                    <div
                      className="progress-fill"
                      style={{
                        width: `${Math.min(100, Math.round((me.drafts_used / Math.max(1, me.drafts_limit)) * 100))}%`,
                      }}
                    />
                  </div>
                  {me.tier !== "studio" && (
                    <div className="plan-upsell" style={{ marginTop: 12 }}>
                      {me.tier === "free" && (
                        <button
                          className="btn primary sm block"
                          disabled={billingBusy}
                          onClick={() => startCheckout("creator")}
                        >
                          {t("Upgrade to Creator")} — {PLAN_COPY.creator.price}
                        </button>
                      )}
                      <button
                        className="btn sm block"
                        style={{ marginTop: 8 }}
                        disabled={billingBusy}
                        onClick={() => startCheckout("studio")}
                      >
                        {me.tier === "creator" ? t("Upgrade to Studio") : t("Go Studio")} — {PLAN_COPY.studio.price}
                      </button>
                      <p className="muted small" style={{ marginTop: 8, textAlign: "center" }}>
                        {t("Creator: more drafts + queue. Studio: agents, Imagine, your server.")}
                      </p>
                    </div>
                  )}
                  {me.has_stripe_customer && me.billing_configured && (
                    <button className="btn ghost sm block" style={{ marginTop: 8 }} disabled={billingBusy} onClick={openPortal}>
                      {t("Manage subscription")}
                    </button>
                  )}
                </div>
              )}
              <button className="btn block" style={{ marginTop: 14 }} onClick={signOut}>
                {t("Sign out")}
              </button>
            </>
          ) : (
            <>
              <p className="card-desc">{t("Speak an idea. Get posts for every platform. Free to start.")}</p>
              {googleAvailable && (
                <>
                  <button
                    className="btn block"
                    style={{ marginTop: 14 }}
                    onClick={() => {
                      window.location.href = `${getHubUrl()}/api/auth/google/start`;
                    }}
                  >
                    {t("Continue with Google")}
                  </button>
                  <div className="auth-divider">{t("or use email")}</div>
                </>
              )}
              <form
                className="auth-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitAuth();
                }}
                autoComplete="on"
              >
                <label htmlFor="auth-email">{t("Email")}</label>
                <input
                  id="auth-email"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="username"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  required
                />
                <label htmlFor="auth-password">{t("Password")}</label>
                <input
                  id="auth-password"
                  name="password"
                  type="password"
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  placeholder={mode === "signup" ? t("At least 8 characters") : t("Your password")}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={mode === "signup" ? 8 : undefined}
                />
                <button
                  type="submit"
                  className="btn primary block"
                  style={{ marginTop: 14 }}
                  disabled={!email.trim() || !password || authBusy}
                >
                  {authBusy ? <span className="spinner" /> : mode === "signup" ? t("setup.createAccount") : t("setup.signIn")}
                </button>
              </form>
              <button
                type="button"
                className="btn ghost block"
                style={{ marginTop: 8 }}
                onClick={() => setMode(mode === "signup" ? "signin" : "signup")}
              >
                {mode === "signup" ? t("Have an account? Sign in") : t("New here? Create an account")}
              </button>
            </>
          )}
        </div>
      )}

      {/* 2. Brand */}
      <div className="card">
        <div className="card-title">
          <SparkIcon size={18} />
          {t("setup.yourBrand")}
        </div>
        <p className="card-desc">
          {t("So every draft sounds like you.")}
          {!connected && (selfHostActive ? " " + t("Connect your server below first.") : " " + t("Sign in first."))}
        </p>
        <label>{t("setup.goals")}</label>
        <textarea
          rows={3}
          placeholder={t("What are you building toward?")}
          value={goals}
          onChange={(e) => setGoals(e.target.value)}
          disabled={!connected}
        />
        <label>{t("setup.projects")}</label>
        <textarea
          rows={3}
          placeholder={t("What are you shipping right now?")}
          value={projects}
          onChange={(e) => setProjects(e.target.value)}
          disabled={!connected}
        />
        <label>{t("setup.voice")}</label>
        <textarea
          rows={3}
          placeholder={t("Tone, do's and don'ts, who you're talking to.")}
          value={voice}
          onChange={(e) => setVoice(e.target.value)}
          disabled={!connected}
        />
        <label>{t("Content style")}</label>
        <div className="chip-row">
          {STYLE_OPTIONS.map((o) => (
            <button
              key={o}
              className={`chip-btn ${traits.content_style === o ? "on" : ""}`}
              onClick={() => setTraits({ ...traits, content_style: traits.content_style === o ? undefined : o })}
              disabled={!connected}
            >
              {t(o)}
            </button>
          ))}
        </div>
        <label>{t("Content types")}</label>
        <div className="chip-row">
          {TYPE_OPTIONS.map((o) => (
            <button
              key={o}
              className={`chip-btn ${(traits.content_types || []).includes(o) ? "on" : ""}`}
              onClick={() => toggleContentType(o)}
              disabled={!connected}
            >
              {t(o)}
            </button>
          ))}
        </div>
        <label>{t("Audience")}</label>
        <input
          placeholder={t("e.g. creators who want to post more consistently")}
          value={traits.target_audience || ""}
          onChange={(e) => setTraits({ ...traits, target_audience: e.target.value })}
          disabled={!connected}
        />
        <label>{t("Vibe")}</label>
        <div className="chip-row">
          {VIBE_OPTIONS.map((o) => (
            <button
              key={o}
              className={`chip-btn ${traits.vibe === o ? "on" : ""}`}
              onClick={() => setTraits({ ...traits, vibe: traits.vibe === o ? undefined : o })}
              disabled={!connected}
            >
              {t(o)}
            </button>
          ))}
        </div>
        <label>{t("setup.appLanguage")}</label>
        <select
          value={traits.preferred_language || locale || "en"}
          onChange={(e) => {
            const code = e.target.value || "en";
            setTraits({ ...traits, preferred_language: code });
            setLocale(code);
          }}
        >
          {OUTPUT_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
        <p className="card-desc" style={{ marginTop: 6, marginBottom: 10 }}>
          {t("setup.appLanguageHint")}
        </p>
        <div className="row" style={{ gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label>{t("Emoji")}</label>
            <select
              value={traits.emoji_usage || ""}
              onChange={(e) => setTraits({ ...traits, emoji_usage: e.target.value || undefined })}
              disabled={!connected}
            >
              <option value="">{t("Default")}</option>
              {EMOJI_OPTIONS.map((o) => (
                <option key={o} value={o}>{t(o)}</option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label>{t("Call to action")}</label>
            <select
              value={traits.cta_preference || ""}
              onChange={(e) => setTraits({ ...traits, cta_preference: e.target.value || undefined })}
              disabled={!connected}
            >
              <option value="">{t("Default")}</option>
              {CTA_OPTIONS.map((o) => (
                <option key={o} value={o}>{t(o)}</option>
              ))}
            </select>
          </div>
        </div>
        <button
          className="btn primary block"
          style={{ marginTop: 14 }}
          onClick={async () => {
            setSavingProfile(true);
            try {
              const lang = traits.preferred_language || "en";
              setLocale(lang);
              await api.saveProfile({
                goals,
                projects,
                brand_voice: voice,
                traits: { ...traits, preferred_language: lang },
              });
              toast(t("setup.saved"));
            } catch (e: any) {
              toast(e.message);
            } finally {
              setSavingProfile(false);
            }
          }}
          disabled={!connected || savingProfile}
        >
          {savingProfile ? <span className="spinner" /> : t("setup.saveBrand")}
        </button>
      </div>

      {/* 3. Accounts */}
      {connected && conns && (
        <div className="card">
          <div className="card-title">
            <PlugIcon size={18} />
            {t("Connected accounts")}
          </div>
          <p className="card-desc">
            {t("Guided Share from Drafts works on every plan.")}{" "}
            {t("X can connect when available for Creator+. Instagram, TikTok, Facebook and LinkedIn connects — plus live metrics — are coming soon.")}
          </p>
          <div className="conn-list">
            {(Object.keys(conns.providers) as Platform[]).map((p) => {
              const providerStatus = conns.providers[p];
              const active = conns.connected.find((c) => c.platform === p);
              return (
                <div className="conn-row" key={p}>
                  <span className="conn-name">{PLATFORM_LABELS[p]}</span>
                  {active ? (
                    <>
                      <span className="muted small" style={{ marginLeft: "auto" }}>
                        {active.handle || t("connected")}
                      </span>
                      <button className="btn ghost danger sm" onClick={() => disconnectPlatform(p)}>
                        {t("Disconnect")}
                      </button>
                    </>
                  ) : (
                    connectAction(p, providerStatus)
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 4. Invite */}
      {connected && me?.ref_code && (
        <div className="card">
          <div className="card-title">
            <GiftIcon size={18} />
            {t("Invite friends")}
          </div>
          <p className="card-desc">
            {t("You and every friend who joins with your link both get +20 bonus drafts.")}
            {me.referrals > 0 && " " + t("You've invited {n}.", { n: me.referrals })}
          </p>
          <div className="key-reveal" style={{ marginTop: 10 }}>
            <code>{`${window.location.origin}/?ref=${me.ref_code}`}</code>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="btn block"
              onClick={async () => {
                await copyText(`${window.location.origin}/?ref=${me.ref_code}`);
                toast(t("Invite link copied"));
              }}
            >
              {t("Copy link")}
            </button>
            <button
              className="btn primary block"
              onClick={() =>
                shareText(
                  t("I speak ideas into Brand Studio and it writes posts for every platform. Join with my link — we both get bonus drafts: {link}", {
                    link: `${window.location.origin}/?ref=${me.ref_code}`,
                  })
                )
              }
            >
              {t("Share invite")}
            </button>
          </div>
        </div>
      )}

      {/* 5. Preferences */}
      <div className="card">
        <div className="card-title">
          <GearIcon size={18} />
          {t("Preferences")}
        </div>
        <p className="card-desc">{t("Display size. Pinch-zoom in the camera is separate.")}</p>
        <div className="row" style={{ marginTop: 12, gap: 8 }}>
          <button
            type="button"
            className="btn block"
            onClick={() => setTextScaleState(setTextScale(textScale - 0.1))}
            disabled={textScale <= MIN_TEXT_SCALE + 0.01}
          >
            A−
          </button>
          <button type="button" className="btn ghost block" onClick={() => setTextScaleState(setTextScale(1))}>
            {Math.round(textScale * 100)}%
          </button>
          <button
            type="button"
            className="btn block"
            onClick={() => setTextScaleState(setTextScale(textScale + 0.1))}
            disabled={textScale >= MAX_TEXT_SCALE - 0.01}
          >
            A+
          </button>
        </div>
        {connected && (
          <>
            <button className="btn ghost block" style={{ marginTop: 12 }} onClick={downloadExport}>
              <DownloadIcon size={16} />
              {t("Export my data")}
            </button>
            <button
              className="btn ghost block"
              style={{ marginTop: 8 }}
              onClick={() => {
                resetTour();
                navigate("/capture");
              }}
            >
              {t("Replay the tour")}
            </button>
          </>
        )}
      </div>

      {/* 6. Studio tools */}
      {connected && (
        <div className="card">
          <div className="card-title">
            <KeyIcon size={18} />
            {t("Studio tools")}
          </div>
          {isStudio ? (
            <>
              <p className="card-desc">{t("Agents, optional modules, and your own server — unlocked on Studio.")}</p>
              <Link to="/agents" className="btn block" style={{ marginTop: 12, textDecoration: "none" }}>
                <KeyIcon size={16} />
                {t("Manage agents")}
              </Link>
              <Link to="/workouts" className="btn ghost block" style={{ marginTop: 8, textDecoration: "none" }}>
                <DumbbellIcon size={16} />
                {t("Workout log")}
              </Link>
              <button
                className="btn ghost block"
                style={{ marginTop: 8 }}
                onClick={() => setShowSelfHost(!showSelfHost)}
              >
                <GearIcon size={16} />
                {showSelfHost ? t("Hide self-hosted server") : t("Show self-hosted server")}
              </button>
              {showSelfHost && (
                <>
                  <p className="card-desc" style={{ marginTop: 12 }}>
                    {t("Point this app at your own Brand Studio server. Pairing stays on this device.")}
                    {selfHostActive && status === "ok" && (
                      <span className="small">
                        {" "}
                        <span className="status-dot ok" /> {t("connected")}
                      </span>
                    )}
                  </p>
                  {isScanSupported() && (
                    <button className="btn block" style={{ marginTop: 10 }} onClick={() => setScanning(true)}>
                      <QrIcon size={17} />
                      {t("Scan pairing code")}
                    </button>
                  )}
                  <label>{t("Server URL")}</label>
                  <input
                    type="url"
                    inputMode="url"
                    placeholder="https://your-server.example.com"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <label>{t("Access token")}</label>
                  <input
                    type="password"
                    name="hub-access-token"
                    autoComplete="off"
                    data-1p-ignore
                    data-lpignore="true"
                    placeholder={t("Token from your server setup")}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <button
                    className="btn primary block"
                    style={{ marginTop: 14 }}
                    onClick={() => connectSelfHost(url, token)}
                    disabled={!url.trim() || !token.trim() || status === "testing"}
                  >
                    {status === "testing" ? <span className="spinner" /> : t("Save & test")}
                  </button>
                  {selfHostActive && (
                    <button className="btn ghost block" style={{ marginTop: 8 }} onClick={disconnectSelfHost}>
                      {t("Switch back to cloud")}
                    </button>
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <p className="card-desc">
                {t("Run Brand Studio on your own server, plug in AI agents, and unlock 1,000 drafts / month.")}
              </p>
              <ul className="plan-feature-list">
                {PLAN_COPY.studio.features.map((f) => (
                  <li key={f}>{t(f)}</li>
                ))}
              </ul>
              <button
                className="btn primary block"
                style={{ marginTop: 12 }}
                disabled={billingBusy || !signedInAs}
                onClick={() => startCheckout("studio")}
              >
                {t("Unlock Studio")} — {PLAN_COPY.studio.price}
              </button>
            </>
          )}
        </div>
      )}

      {/* Already on self-host without Studio UI path */}
      {selfHostActive && !connected && (
        <div className="card">
          <div className="card-title">
            <GearIcon size={18} />
            {t("Your server")}
          </div>
          <p className="card-desc">{t("Reconnect or switch back to the cloud app.")}</p>
          <button className="btn primary block" onClick={() => connectSelfHost(url, token)} disabled={!url || !token}>
            {t("Reconnect")}
          </button>
          <button className="btn ghost block" style={{ marginTop: 8 }} onClick={disconnectSelfHost}>
            {t("Switch back to cloud")}
          </button>
        </div>
      )}

      <div className="card muted small">
        <b style={{ color: "var(--text-1)" }}>{t("Install on your phone")}</b>
        <p>
          <b style={{ color: "var(--text-2)" }}>{t("Android:")}</b> {t("Chrome → menu → Add to Home screen.")}
        </p>
        <p style={{ marginBottom: 0 }}>
          <b style={{ color: "var(--text-2)" }}>{t("iPhone:")}</b> {t("Safari → Share → Add to Home Screen.")}
        </p>
      </div>
    </div>
  );
}
