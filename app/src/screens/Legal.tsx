import { Link } from "react-router-dom";
import { useT } from "../lib/i18n";

type Kind = "terms" | "privacy";

export default function Legal({ kind }: { kind: Kind }) {
  const t = useT();
  const title = kind === "terms" ? t("Terms of Service") : t("Privacy Policy");

  return (
    <div className="screen" style={{ paddingBottom: 96 }}>
      <div className="screen-head">
        <Link to="/setup" className="btn ghost sm">
          ← {t("setup.title")}
        </Link>
        <h1 style={{ marginTop: 12 }}>{title}</h1>
        <p className="card-desc">Brand Studio · Last updated August 2026</p>
      </div>

      <div className="card legal-card">
        {kind === "terms" ? <TermsBody /> : <PrivacyBody />}
      </div>
    </div>
  );
}

function TermsBody() {
  return (
    <div className="legal-prose">
      <p>
        Brand Studio (“we”, “us”) provides tools that help you turn spoken or typed ideas into social
        captions and optional AI media. By creating an account or using the service, you agree to these
        Terms.
      </p>
      <h3>Your content</h3>
      <p>
        You own the ideas, captions, photos, videos, and logos you upload or generate. You are
        responsible for what you publish to third-party apps (TikTok, Instagram, WhatsApp, etc.). Do
        not upload or generate illegal content, including CSAM, malware, or content that infringes
        others’ rights.
      </p>
      <h3>AI output</h3>
      <p>
        Captions and AI clips are machine-assisted suggestions. They may be inaccurate or unsuitable.
        Review everything before sharing. We do not guarantee reach, monetization, or platform
        compliance.
      </p>
      <h3>Accounts &amp; abuse</h3>
      <p>
        Keep your login secure. We may suspend or remove accounts, media, or drafts that violate these
        Terms or harm other users. Rate limits and automated filters may apply to uploads and
        generation.
      </p>
      <h3>Paid plans</h3>
      <p>
        Creator and Studio subscriptions and video credits are billed via Stripe (or other methods we
        show in Setup). Fees, renewals, and refunds follow Stripe’s checkout and your local consumer
        law. Cancel in the customer portal when available.
      </p>
      <h3>Contact</h3>
      <p>
        Questions: <a href="mailto:hello@brand-studio.app">hello@brand-studio.app</a>
      </p>
    </div>
  );
}

function PrivacyBody() {
  return (
    <div className="legal-prose">
      <p>
        This Privacy Policy explains what Brand Studio collects and how we use it when you use the
        app and hub.
      </p>
      <h3>Data we store</h3>
      <ul>
        <li>Account email and authentication data</li>
        <li>Google account email if you use Continue with Google</li>
        <li>Privy user id, email, or wallet address if you use Continue with Privy</li>
        <li>Brand Brain profile (goals, voice, traits, watermark)</li>
        <li>Ideas, drafts, media you upload or generate</li>
        <li>Billing identifiers from Stripe when you subscribe</li>
        <li>Basic usage needed to enforce plan limits</li>
      </ul>
      <h3>Processors</h3>
      <p>
        We use Anthropic and/or xAI to generate captions and media, Stripe for payments, Google for
        optional sign-in, Privy for optional email/wallet sign-in, and our hosting providers (e.g. Fly, Vercel) to run the service. Content you
        send for generation is processed by those providers under their terms. When you create an
        account or sign in, we email our operations inbox (
        <a href="mailto:hello@mybrandstudio.club">hello@mybrandstudio.club</a>
        ) so we can keep a user list and support you — that is not a public directory.
      </p>
      <h3>Your choices</h3>
      <p>
        You can export your data from Setup, remove a watermark, delete drafts, or request account
        deletion by emailing hello@brand-studio.app.
      </p>
      <h3>Retention</h3>
      <p>
        We keep account and content while your account is active, and for a reasonable period after
        deletion for backups and abuse prevention, unless law requires longer.
      </p>
    </div>
  );
}
