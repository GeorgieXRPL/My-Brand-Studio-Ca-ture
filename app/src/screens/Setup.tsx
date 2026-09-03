import { lazy, Suspense, useCallback, useEffect, useState } from "react";
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
  ImageIcon,
  KeyIcon,
  MonitorIcon,
  PlugIcon,
  SparkIcon,
  UserIcon,
} from "../lib/icons";
import QrScanner, { isScanSupported } from "../lib/QrScanner";
import { resetTour } from "../lib/Tour";
import { copyText, shareText } from "../lib/share";
import { getTextScale, MAX_TEXT_SCALE, MIN_TEXT_SCALE, setTextScale } from "../lib/viewportZoom";
import { PLAN_COPY, VIDEO_CREDIT_PACKS, tierAtLeast } from "../lib/plans";
import { useLocale } from "../lib/i18n";
import { OUTPUT_LANGUAGES } from "../lib/languages";
import { PLATFORM_LABELS, type BrandTraits, type Connections, type Me, type Platform } from "../lib/types";
import { normalizeEnabledPlatforms } from "../lib/enabledPlatforms";
import PlatformPicker from "../lib/PlatformPicker";
import { prepareMedia } from "../lib/media";
import GoogleButton from "../lib/GoogleButton";
import {
  AUTH_CHANGED_EVENT,
  notifyAuthChanged,
  privyEnabled,
  requestPrivyLogout,
} from "../lib/privy-env";

const PrivyButton = lazy(() => import("../lib/PrivyButton"));

const STYLE_OPTIONS = ["Educational", "Entertaining", "Inspirational", "Behind-the-scenes", "Storytelling", "Contrarian"];
const TYPE_OPTIONS = ["Short video", "Photo posts", "Threads", "Carousels", "Live/streams", "Long-form"];
const VIBE_OPTIONS = ["Hype & energetic", "Calm & authentic", "Funny & playful", "Premium & polished", "Raw & unfiltered"];
const EMOJI_OPTIONS = ["None", "Light (1-2 per post)", "Expressive"];
const CTA_OPTIONS = ["Ask a question", "Follow for more", "Link in bio", "Soft / none"];
const LINKABLE: Platform[] = ["facebook", "instagram", "tiktok", "linkedin"];
const ACCOUNT_ROW_PLATFORMS: Platform[] = ["x", "facebook", "instagram", "tiktok", "linkedin", "snapchat"];

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

  const [url, setUrl] = useState(isSelfHost() ? getHubUrl() : "");
  const [token, setToken] = useState(getHubToken());
  // Self-hosted pairing UI is Coming soon; only allow scan reconnect if already on a custom hub.
  const [scanning, setScanning] = useState(
    isSelfHost() && params.get("scan") === "1" && isScanSupported()
  );

  const [goals, setGoals] = useState("");
  const [projects, setProjects] = useState("");
  const [voice, setVoice] = useState("");
  const [traits, setTraits] = useState<BrandTraits>({});
  const [watermarkUrl, setWatermarkUrl] = useState<string | null>(null);
  const [watermarkBusy, setWatermarkBusy] = useState(false);
  const [savedBrand, setSavedBrand] = useState<string>("");
  const [connected, setConnected] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);

  const [conns, setConns] = useState<Connections | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [textScale, setTextScaleState] = useState(() => getTextScale());
  const [billingBusy, setBillingBusy] = useState(false);
  const [cryptoMethods, setCryptoMethods] = useState<
    Array<{ id: string; chain: string; asset: string; label: string; pay_to: string; token?: string }>
  >([]);
  const [cryptoPay, setCryptoPay] = useState<{
    product: string;
    amountHint: string;
    step: "pick" | "pay";
    methodId?: string;
    details?: {
      amount_usd: number;
      chain: string;
      asset: string;
      label: string;
      pay_to: string;
      token: string | null;
      note: string;
      invoice_id: number;
    };
  } | null>(null);
  const [googleAvailable, setGoogleAvailable] = useState(false);
  const [termsAgreed, setTermsAgreed] = useState(false);
  const [termsBusy, setTermsBusy] = useState(false);

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
    } else if (params.get("billing") === "credits_success") {
      toast(t("Video credits added — generate clips from Drafts"));
      window.history.replaceState(null, "", "/setup");
    } else if (params.get("billing") === "cancel") {
      toast(t("Checkout cancelled"));
      window.history.replaceState(null, "", "/setup");
    }

    if (isConfigured()) {
      loadProfile();
    }
    api
      .authProviders()
      .then((p) => setGoogleAvailable(p.google))
      .catch(() => {});

    const onAuthChanged = () => {
      const email = getAuthEmail();
      setSignedInAs(isSelfHost() ? "" : email);
      if (email && isConfigured()) loadProfile();
    };
    window.addEventListener(AUTH_CHANGED_EVENT, onAuthChanged);
    return () => window.removeEventListener(AUTH_CHANGED_EVENT, onAuthChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadProfile() {
    try {
      const p = await api.getProfile();
      applySavedProfile(p);
      if (p.traits?.preferred_language) setLocale(p.traits.preferred_language);
      setConnected(true);
    } catch {
      setConnected(false);
      return;
    }
    try {
      const [c, m, crypto] = await Promise.all([
        api.getConnections(),
        api.me(),
        api.billingCryptoConfig().catch(() => null),
      ]);
      setConns(c);
      setMe(m);
      setCryptoMethods(crypto?.enabled ? crypto.methods || [] : []);
    } catch {
      /* older hubs */
    }
  }


  const EXAMPLE_CAP = 3;
  const LIST_CAP = 12;

  function parseList(raw: string, cap = LIST_CAP): string[] {
    return raw
      .split(/[\n,]+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, cap);
  }

  function brandSnapshot(next?: {
    goals?: string;
    projects?: string;
    voice?: string;
    traits?: BrandTraits;
    watermarkUrl?: string | null;
  }) {
    const t = next?.traits ?? traits;
    return JSON.stringify({
      goals: next?.goals ?? goals,
      projects: next?.projects ?? projects,
      voice: next?.voice ?? voice,
      traits: {
        content_style: t.content_style || "",
        content_types: t.content_types || [],
        target_audience: t.target_audience || "",
        vibe: t.vibe || "",
        emoji_usage: t.emoji_usage || "",
        cta_preference: t.cta_preference || "",
        preferred_language: t.preferred_language || "",
        text_provider: t.text_provider || "grok",
        never_use: t.never_use || [],
        always_use: t.always_use || [],
        example_posts: (t.example_posts || []).slice(0, EXAMPLE_CAP),
        enabled_platforms: normalizeEnabledPlatforms(t.enabled_platforms),
      },
      watermarkUrl: next?.watermarkUrl !== undefined ? next.watermarkUrl : watermarkUrl,
    });
  }

  function applySavedProfile(p: {
    goals?: string;
    projects?: string;
    brand_voice?: string;
    traits?: BrandTraits;
    watermark_media_url?: string | null;
  }) {
    const nextGoals = p.goals || "";
    const nextProjects = p.projects || "";
    const nextVoice = p.brand_voice || "";
    const nextTraits = p.traits || {};
    const nextWm = p.watermark_media_url || null;
    setGoals(nextGoals);
    setProjects(nextProjects);
    setVoice(nextVoice);
    setTraits(nextTraits);
    setWatermarkUrl(nextWm);
    setSavedBrand(
      JSON.stringify({
        goals: nextGoals,
        projects: nextProjects,
        voice: nextVoice,
        traits: {
          content_style: nextTraits.content_style || "",
          content_types: nextTraits.content_types || [],
          target_audience: nextTraits.target_audience || "",
          vibe: nextTraits.vibe || "",
          emoji_usage: nextTraits.emoji_usage || "",
          cta_preference: nextTraits.cta_preference || "",
          preferred_language: nextTraits.preferred_language || "",
          text_provider: nextTraits.text_provider || "grok",
          never_use: nextTraits.never_use || [],
          always_use: nextTraits.always_use || [],
          example_posts: (nextTraits.example_posts || []).slice(0, EXAMPLE_CAP),
          enabled_platforms: normalizeEnabledPlatforms(nextTraits.enabled_platforms),
        },
        watermarkUrl: nextWm,
      })
    );
  }

  const brandDirty = Boolean(connected && savedBrand && brandSnapshot() !== savedBrand);

  function traitsForSave(): BrandTraits {
    const lang = traits.preferred_language || "en";
    return {
      ...traits,
      preferred_language: lang,
      text_provider: traits.text_provider === "claude" ? "claude" : "grok",
      never_use: (traits.never_use || []).map((x) => x.trim()).filter(Boolean).slice(0, LIST_CAP),
      always_use: (traits.always_use || []).map((x) => x.trim()).filter(Boolean).slice(0, LIST_CAP),
      example_posts: (traits.example_posts || []).map((x) => x.trim()).filter(Boolean).slice(0, EXAMPLE_CAP),
      enabled_platforms: normalizeEnabledPlatforms(traits.enabled_platforms),
    };
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

  function openCryptoCheckout(product: string, amountHint: string) {
    if (!cryptoMethods.length) {
      toast(t("Crypto deposits aren't enabled yet"));
      return;
    }
    if (cryptoMethods.length === 1) {
      void createCryptoInvoice(product, amountHint, cryptoMethods[0].id);
      return;
    }
    setCryptoPay({ product, amountHint, step: "pick" });
  }

  async function createCryptoInvoice(product: string, amountHint: string, methodId: string) {
    setBillingBusy(true);
    try {
      const inv = await api.billingCryptoInvoice(product, methodId);
      setCryptoPay({
        product,
        amountHint,
        step: "pay",
        methodId,
        details: {
          amount_usd: inv.amount_usd,
          chain: inv.chain,
          asset: inv.asset,
          label: inv.label,
          pay_to: inv.pay_to,
          token: inv.token,
          note: inv.note,
          invoice_id: inv.invoice?.id,
        },
      });
    } catch (e: any) {
      toast(e.message);
      setCryptoPay(null);
    } finally {
      setBillingBusy(false);
    }
  }

  async function copyCryptoField(value: string, label: string) {
    try {
      await copyText(value);
      toast(t("Copied {label}", { label }));
    } catch {
      toast(t("Couldn't copy"));
    }
  }

  async function buyVideoCredits(pack: "5" | "15" | "40") {
    setBillingBusy(true);
    try {
      if (me?.credits_checkout || me?.billing_configured) {
        const { url } = await api.billingCreditsCheckout(pack);
        window.location.href = url;
        return;
      }
      window.location.href = `mailto:hello@brand-studio.app?subject=Buy%20${pack}%20video%20credits&body=I'd like ${pack} AI video credits (${me?.email || ""}).`;
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
    if (mode === "signup" && !termsAgreed) {
      toast(t("Please agree to the Terms and Privacy Policy"));
      return;
    }
    setAuthBusy(true);
    try {
      const result =
        mode === "signup"
          ? await api.signup(email.trim(), password, localStorage.getItem("refCode") || undefined, {
              terms_accepted: true,
            })
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

  async function acceptTermsNow() {
    setTermsBusy(true);
    try {
      await api.acceptTerms();
      setMe((prev) =>
        prev ? { ...prev, terms_accepted_at: new Date().toISOString() } : prev
      );
      toast(t("Thanks — you're all set"));
    } catch (e: any) {
      toast(e.message);
    } finally {
      setTermsBusy(false);
    }
  }

  async function signOut() {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    clearAuth();
    requestPrivyLogout();
    notifyAuthChanged();
    setSignedInAs("");
    setConnected(false);
    toast(t("Signed out"));
  }

  async function connectSelfHost(urlValue: string, tokenValue: string) {
    setHubConfig(urlValue.trim(), tokenValue.trim());
    clearAuth();
    setSignedInAs("");
    try {
      await api.health();
      toast(t("Connected to your server"));
      loadProfile();
    } catch (e: any) {
      toast(e.message);
    }
  }

  function disconnectSelfHost() {
    clearHubConfig();
    setUrl("");
    setToken("");
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


  async function saveBrand() {
    setSavingProfile(true);
    try {
      const nextTraits = traitsForSave();
      setLocale(nextTraits.preferred_language || "en");
      setTraits(nextTraits);
      const saved = await api.saveProfile({
        goals,
        projects,
        brand_voice: voice,
        traits: nextTraits,
        watermark_media_url: watermarkUrl,
      });
      applySavedProfile(saved || {
        goals,
        projects,
        brand_voice: voice,
        traits: nextTraits,
        watermark_media_url: watermarkUrl,
      });
      toast(t("setup.saved"));
    } catch (e: any) {
      toast(e.message);
    } finally {
      setSavingProfile(false);
    }
  }

  const selfHostActive = isSelfHost();
  const isStudio = tierAtLeast(me?.tier, "studio") || selfHostActive;

  return (
    <div className="screen">
      {scanning && <QrScanner onResult={handleScan} onClose={() => setScanning(false)} />}
      <div className="header">
        <h1>
          <span className="eyebrow">Brand Studio · v2.9.0</span>
          {t("setup.title")}
        </h1>
        <span className="sub">{isVoiceSupported() ? t("voice ready") : t("voice: use Chrome / Safari")}</span>
      </div>
      {brandDirty && (
        <div
          className="unsaved-bar"
          role="status"
          style={{
            position: "sticky",
            top: 0,
            zIndex: 20,
            display: "flex",
            gap: 10,
            alignItems: "center",
            flexWrap: "wrap",
            margin: "0 0 12px",
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid var(--border-strong)",
            background: "var(--surface-2)",
          }}
        >
          <span className="small">{t("setup.unsaved")}</span>
          <button
            type="button"
            className="btn sm outline"
            onClick={() => {
              try {
                const snap = JSON.parse(savedBrand);
                setGoals(snap.goals || "");
                setProjects(snap.projects || "");
                setVoice(snap.voice || "");
                setTraits(snap.traits || {});
                setWatermarkUrl(snap.watermarkUrl || null);
              } catch {
                void loadProfile();
              }
            }}
          >
            {t("setup.discard")}
          </button>
          <button
            type="button"
            className="btn primary sm"
            disabled={!connected || savingProfile}
            onClick={() => void saveBrand()}
          >
            {savingProfile ? <span className="spinner" /> : t("setup.saveBrand")}
          </button>
        </div>
      )}

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
          {signedInAs && me && !me.terms_accepted_at && (
            <div className="terms-gate" style={{ marginBottom: 14 }}>
              <p className="card-desc" style={{ marginBottom: 10 }}>
                {t("Please accept the Terms of Service and Privacy Policy to continue.")}{" "}
                <Link to="/terms">{t("Terms")}</Link> · <Link to="/privacy">{t("Privacy")}</Link>
              </p>
              <button className="btn primary block" disabled={termsBusy} onClick={() => void acceptTermsNow()}>
                {termsBusy ? <span className="spinner" /> : t("I agree")}
              </button>
            </div>
          )}
          {signedInAs ? (
            <>
              <p className="card-desc">{signedInAs} — {t("ideas, drafts and schedule sync here.")}</p>
              <Link to="/desk" className="btn block" style={{ textDecoration: "none", marginBottom: 12 }}>
                <MonitorIcon size={16} />
                Open desk
              </Link>
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
                  {tierAtLeast(me.tier, "creator") && (
                    <p className="muted small" style={{ marginTop: 8 }}>
                      {t("{used}/{limit} AI stills", {
                        used: me.stills_used ?? 0,
                        limit: me.stills_limit ?? 0,
                      })}
                      {tierAtLeast(me.tier, "studio")
                        ? ` · ${t("{n} videos left", { n: me.videos_remaining ?? 0 })}`
                        : me.video_credits
                          ? ` · ${t("{n} video credits", { n: me.video_credits })}`
                          : ""}
                    </p>
                  )}
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
                        {t("Creator: drafts + AI stills. Studio: AI video, agents, your server.")}
                      </p>
                      {cryptoMethods.length > 0 && (
                        <button
                          className="btn ghost sm block"
                          style={{ marginTop: 8 }}
                          disabled={billingBusy}
                          onClick={() =>
                            openCryptoCheckout(
                              me.tier === "free" ? "creator" : "studio",
                              me.tier === "free" ? PLAN_COPY.creator.price : PLAN_COPY.studio.price
                            )
                          }
                        >
                          {t("Pay with crypto")}
                        </button>
                      )}
                    </div>
                  )}
                  {tierAtLeast(me.tier, "creator") && (
                    <div className="credit-packs" style={{ marginTop: 12 }}>
                      <p className="muted small" style={{ marginBottom: 8 }}>
                        {t("Need more AI video? Buy clip credits anytime.")}
                      </p>
                      <div className="chip-row">
                        {VIDEO_CREDIT_PACKS.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            className="chip-btn"
                            disabled={billingBusy}
                            onClick={() => buyVideoCredits(p.id)}
                          >
                            {p.blurb} · {p.price}
                          </button>
                        ))}
                      </div>
                      {cryptoMethods.length > 0 && (
                        <button
                          className="btn ghost sm block"
                          style={{ marginTop: 8 }}
                          disabled={billingBusy}
                          onClick={() => openCryptoCheckout("credits_5", VIDEO_CREDIT_PACKS[0].price)}
                        >
                          {t("Pay credits with crypto")}
                        </button>
                      )}
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
              {privyEnabled() && (
                <>
                  <Suspense fallback={<button type="button" className="btn privy-btn block" disabled />}>
                    <PrivyButton />
                  </Suspense>
                  <p className="muted small" style={{ marginTop: 8, textAlign: "center" }}>
                    {t("By continuing you agree to the")}{" "}
                    <Link to="/terms">{t("Terms")}</Link> {t("and")} <Link to="/privacy">{t("Privacy Policy")}</Link>.
                  </p>
                </>
              )}
              {googleAvailable && !privyEnabled() && (
                <>
                  <GoogleButton />
                  <p className="muted small" style={{ marginTop: 8, textAlign: "center" }}>
                    {t("By continuing with Google you agree to the")}{" "}
                    <Link to="/terms">{t("Terms")}</Link> {t("and")} <Link to="/privacy">{t("Privacy Policy")}</Link>.
                  </p>
                </>
              )}
              {(privyEnabled() || googleAvailable) && (
                <div className="auth-divider">{t("or use email")}</div>
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
                {mode === "signup" && (
                  <label className="terms-check" htmlFor="auth-terms">
                    <input
                      id="auth-terms"
                      type="checkbox"
                      checked={termsAgreed}
                      onChange={(e) => setTermsAgreed(e.target.checked)}
                    />
                    <span>
                      {t("I agree to the")}{" "}
                      <Link to="/terms" target="_blank" rel="noreferrer">
                        {t("Terms of Service")}
                      </Link>{" "}
                      {t("and")}{" "}
                      <Link to="/privacy" target="_blank" rel="noreferrer">
                        {t("Privacy Policy")}
                      </Link>
                    </span>
                  </label>
                )}
                <button
                  type="submit"
                  className="btn primary block"
                  style={{ marginTop: 14 }}
                  disabled={
                    !email.trim() ||
                    !password ||
                    authBusy ||
                    (mode === "signup" && !termsAgreed)
                  }
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
          {t("Concrete facts beat vibes — who you talk to, how you sound, words you never use. That's how drafts stay yours.")}
          {!connected && (selfHostActive ? " " + t("Connect your server below first.") : " " + t("Sign in first."))}
        </p>
        <label>{t("setup.goals")}</label>
        <textarea
          rows={3}
          placeholder={t("What do you want people to know you for?")}
          value={goals}
          onChange={(e) => setGoals(e.target.value)}
          disabled={!connected}
        />
        <label>{t("setup.projects")}</label>
        <textarea
          rows={3}
          placeholder={t("Real things you're working on right now — specifics beat slogans.")}
          value={projects}
          onChange={(e) => setProjects(e.target.value)}
          disabled={!connected}
        />
        <label>{t("setup.voice")}</label>
        <textarea
          rows={3}
          placeholder={t("How you talk in real life — phrases you use, words you never say, who you're talking to.")}
          value={voice}
          onChange={(e) => setVoice(e.target.value)}
          disabled={!connected}
        />
        <label>{t("Apps you post to")}</label>
        <PlatformPicker
          selected={normalizeEnabledPlatforms(traits.enabled_platforms)}
          onChange={(next) => setTraits({ ...traits, enabled_platforms: next })}
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
          placeholder={t("e.g. local tradies who hate corporate jargon")}
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
        <label>{t("setup.textAi")}</label>
        <div className="chip-row">
          <button
            type="button"
            className={`chip-btn ${(traits.text_provider || "grok") !== "claude" ? "on" : ""}`}
            onClick={() => setTraits({ ...traits, text_provider: "grok" })}
            disabled={!connected}
          >
            {t("setup.textAiGrok")}
          </button>
          <button
            type="button"
            className={`chip-btn ${traits.text_provider === "claude" ? "on" : ""}`}
            onClick={() => setTraits({ ...traits, text_provider: "claude" })}
            disabled={!connected}
          >
            {t("setup.textAiClaude")}
          </button>
        </div>
        <p className="card-desc" style={{ marginTop: 6, marginBottom: 10 }}>
          {t("setup.textAiHint")}
        </p>
        <label>{t("setup.neverUse")}</label>
        <textarea
          rows={2}
          placeholder={t("setup.neverUseHint")}
          value={(traits.never_use || []).join(", ")}
          onChange={(e) => setTraits({ ...traits, never_use: parseList(e.target.value) })}
          disabled={!connected}
        />
        <label>{t("setup.alwaysUse")}</label>
        <textarea
          rows={2}
          placeholder={t("setup.alwaysUseHint")}
          value={(traits.always_use || []).join(", ")}
          onChange={(e) => setTraits({ ...traits, always_use: parseList(e.target.value) })}
          disabled={!connected}
        />
        <label>{t("setup.examplePosts")}</label>
        <p className="card-desc" style={{ marginTop: 0, marginBottom: 8 }}>
          {t("setup.examplePostsHint")}
        </p>
        {[0, 1, 2].map((i) => (
          <textarea
            key={i}
            rows={2}
            placeholder={t("setup.examplePostN", { n: i + 1 })}
            value={(traits.example_posts || [])[i] || ""}
            onChange={(e) => {
              const next = [...(traits.example_posts || [])];
              next[i] = e.target.value;
              setTraits({
                ...traits,
                example_posts: next.map((x) => x.trim()).filter((x, idx) => x || idx <= i).slice(0, EXAMPLE_CAP),
              });
            }}
            disabled={!connected}
            style={{ marginBottom: 8 }}
          />
        ))}
        <label>{t("Custom watermark")}</label>
        <p className="card-desc" style={{ marginTop: 0, marginBottom: 8 }}>
          {t("Upload a PNG logo — we'll stamp it in the lower-right on stills and clips when watermark is On.")}
        </p>
        {watermarkUrl ? (
          <div className="watermark-preview-row">
            <div className="watermark-corner-demo" aria-hidden="true">
              <img className="watermark-preview" src={watermarkUrl} alt="" />
              <span className="watermark-corner-label">{t("Lower right")}</span>
            </div>
            <button
              type="button"
              className="btn sm outline"
              disabled={!connected || watermarkBusy || savingProfile}
              onClick={async () => {
                setWatermarkUrl(null);
                if (!connected) return;
                setSavingProfile(true);
                try {
                  const saved = await api.saveProfile({
                    goals,
                    projects,
                    brand_voice: voice,
                    traits: traitsForSave(),
                    watermark_media_url: null,
                  });
                  applySavedProfile(saved || {
                    goals,
                    projects,
                    brand_voice: voice,
                    traits: traitsForSave(),
                    watermark_media_url: null,
                  });
                  toast(t("Watermark removed"));
                } catch (e: any) {
                  toast(e.message);
                } finally {
                  setSavingProfile(false);
                }
              }}
            >
              {t("Remove")}
            </button>
          </div>
        ) : (
          <label className={`btn sm ${!connected || watermarkBusy ? "disabled" : ""}`} style={{ display: "inline-flex", cursor: connected ? "pointer" : "default" }}>
            <ImageIcon size={15} />
            {watermarkBusy ? t("Uploading…") : t("Upload watermark")}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              hidden
              disabled={!connected || watermarkBusy}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                setWatermarkBusy(true);
                try {
                  const prepared = await prepareMedia(file);
                  const up = await api.uploadMedia(prepared);
                  if (!up.mime?.startsWith("image/")) {
                    toast(t("Watermark must be an image"));
                    return;
                  }
                  setWatermarkUrl(up.url);
                  // Persist immediately so Drafts can stamp clips without a second Save tap.
                  const saved = await api.saveProfile({
                    goals,
                    projects,
                    brand_voice: voice,
                    traits: traitsForSave(),
                    watermark_media_url: up.url,
                  });
                  applySavedProfile(saved || {
                    goals,
                    projects,
                    brand_voice: voice,
                    traits: traitsForSave(),
                    watermark_media_url: up.url,
                  });
                  toast(t("Watermark saved — lower right on generates"));
                } catch (err: any) {
                  toast(err.message || t("Couldn't upload watermark"));
                } finally {
                  setWatermarkBusy(false);
                }
              }}
            />
          </label>
        )}
        <div className="row" style={{ gap: 10, marginTop: 12 }}>
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
          onClick={() => void saveBrand()}
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
            {t("X can connect when available for Creator+. Instagram, TikTok, Facebook and LinkedIn connects — plus live metrics — are coming soon. YouTube Shorts, Reddit, Threads, Pinterest and Nextdoor use Share from Drafts.")}
          </p>
          <div className="conn-list">
            {ACCOUNT_ROW_PLATFORMS.map((p) => {
              const providerStatus = conns.providers[p] || "unsupported";
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
                  t("I talk ideas into Brand Studio when I can't get them onto the screen. Join with my link — we both get bonus drafts: {link}", {
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
              <button className="btn ghost block" style={{ marginTop: 8 }} type="button" disabled>
                <GearIcon size={16} />
                {t("Self-hosted server")} — {t("Coming soon")}
              </button>
            </>
          ) : (
            <>
              <p className="card-desc">
                {t("Run Brand Studio on your own server, plug in AI agents, and unlock Studio AI video.")}
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
        <p style={{ marginBottom: 8 }}>
          <b style={{ color: "var(--text-2)" }}>{t("iPhone:")}</b> {t("Safari → Share → Add to Home Screen.")}
        </p>
        <p style={{ marginBottom: 0 }}>
          <Link to="/terms">{t("Terms of Service")}</Link>
          {" · "}
          <Link to="/privacy">{t("Privacy Policy")}</Link>
        </p>
      </div>

      {cryptoPay && (
        <div className="sheet-overlay" onClick={() => !billingBusy && setCryptoPay(null)} role="presentation">
          <div
            className="sheet crypto-pay-sheet"
            role="dialog"
            aria-label={t("Pay with crypto")}
            onClick={(e) => e.stopPropagation()}
          >
            {cryptoPay.step === "pick" ? (
              <>
                <div className="sheet-title">{t("Pick a deposit rail")}</div>
                <p className="muted small" style={{ marginTop: 0 }}>
                  {t("Amount")}: {cryptoPay.amountHint}
                </p>
                <div className="chip-row" style={{ marginTop: 12 }}>
                  {cryptoMethods.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className="chip-btn"
                      disabled={billingBusy}
                      onClick={() => void createCryptoInvoice(cryptoPay.product, cryptoPay.amountHint, m.id)}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              cryptoPay.details && (
                <>
                  <div className="sheet-title">{t("Pay with crypto")}</div>
                  <p className="crypto-pay-amount">
                    ${cryptoPay.details.amount_usd} USD · {cryptoPay.details.label}
                  </p>
                  <p className="muted small" style={{ marginTop: 0 }}>
                    {t(
                      "Send the exact amount to this address. No memo needed — we credit your account automatically after network confirmations."
                    )}
                  </p>

                  <label className="crypto-pay-label">{t("Deposit address")}</label>
                  <div className="crypto-pay-address-row">
                    <code className="crypto-pay-address">{cryptoPay.details.pay_to}</code>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => void copyCryptoField(cryptoPay.details!.pay_to, t("address"))}
                    >
                      {t("Copy")}
                    </button>
                  </div>

                  <p className="muted small" style={{ marginTop: 14 }}>
                    {cryptoPay.details.note}
                  </p>
                </>
              )
            )}
            <button
              className="btn ghost block"
              style={{ marginTop: 14 }}
              disabled={billingBusy}
              onClick={() => setCryptoPay(null)}
            >
              {t("Done")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
