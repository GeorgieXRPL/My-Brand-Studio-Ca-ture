import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Spark from "./Spark";
import { useT } from "./i18n";

export const TOUR_KEY = "tourDone";

export function shouldShowTour(): boolean {
  return !localStorage.getItem(TOUR_KEY);
}

export function resetTour() {
  localStorage.removeItem(TOUR_KEY);
}

interface Step {
  selector: string;
  title: string;
  text: string;
}

function getSteps(t: (s: string) => string): Step[] {
  return [
    {
      selector: '[data-tour="mic"]',
      title: t("Talk, don't type"),
      text: t(
        "Tap the mic and say your idea out loud. Brand Studio turns it into ready-to-post content for X, Facebook, TikTok, Snapchat, Instagram and LinkedIn — in your voice."
      ),
    },
    {
      selector: '[data-tour="nav-drafts"]',
      title: t("Review your drafts"),
      text: t("Every generated post lands here. Tap Edit to tweak, then Share — or Mark posted when you've shipped it."),
    },
    {
      selector: '[data-tour="nav-schedule"]',
      title: t("Plan days & queue posts"),
      text: t("Daily is your filming/editing rhythm. Content is for planning when drafts go live — Share works anytime."),
    },
    {
      selector: '[data-tour="nav-insights"]',
      title: t("Grow smarter each week"),
      text: t("Weekly AI tips based on your drafts and brand. Live platform metrics are coming soon."),
    },
    {
      selector: '[data-tour="nav-setup"]',
      title: t("Teach it your brand"),
      text: t("Set your goals, voice and style in Setup. Share always works — more platform connects are coming soon."),
    },
  ];
}

export default function Tour({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const STEPS = getSteps(t);
  const step = STEPS[i];

  useEffect(() => {
    const measure = () => {
      const el = document.querySelector(step.selector);
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        setRect(el.getBoundingClientRect());
      } else {
        setRect(null);
      }
    };
    measure();
    const t = window.setTimeout(measure, 120);
    const t2 = window.setTimeout(measure, 400);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.clearTimeout(t);
      window.clearTimeout(t2);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [step.selector, i]);

  function finish() {
    localStorage.setItem(TOUR_KEY, "1");
    onDone();
  }

  function next() {
    if (i + 1 >= STEPS.length) finish();
    else setI(i + 1);
  }

  const pad = 10;

  return createPortal(
    <div className="tour-overlay" role="dialog" aria-label={t("App tour")} aria-modal="true">
      {rect && (
        <div
          className="tour-spot"
          style={{
            top: rect.top - pad,
            left: rect.left - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2,
          }}
        />
      )}
      <div className="tour-card" key={i}>
        <div className="tour-step-label">
          {t("Step {n} of {total}", { n: i + 1, total: STEPS.length })}
        </div>
        <div className="tour-head">
          <Spark size={48} mood={i === STEPS.length - 1 ? "excited" : "happy"} />
          <div className="tour-copy">
            <div className="tour-title">{step.title}</div>
            <p className="tour-text">{step.text}</p>
          </div>
        </div>
        <div className="tour-actions">
          <button type="button" className="btn ghost sm" onClick={finish}>
            {t("Skip")}
          </button>
          <span className="tour-dots" aria-hidden="true">
            {STEPS.map((_, d) => (
              <i key={d} className={d === i ? "on" : ""} />
            ))}
          </span>
          <button type="button" className="btn primary sm tour-next" onClick={next}>
            {i + 1 >= STEPS.length ? t("Let's go!") : t("Next")}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
