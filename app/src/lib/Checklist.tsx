import { Link } from "react-router-dom";
import { CheckIcon } from "./icons";
import Spark from "./Spark";
import { useT } from "./i18n";

const DISMISS_KEY = "checklistDismissed";

export function shouldShowChecklist(opts: {
  configured: boolean;
  hasBrand: boolean;
  hasDraft: boolean;
}): boolean {
  if (!opts.configured) return false;
  if (localStorage.getItem(DISMISS_KEY)) return false;
  // Hide once they've done the core loop.
  if (opts.hasBrand && opts.hasDraft) return false;
  return true;
}

export function dismissChecklist() {
  localStorage.setItem(DISMISS_KEY, "1");
}

export default function Checklist({
  hasBrand,
  hasDraft,
  onDismiss,
}: {
  hasBrand: boolean;
  hasDraft: boolean;
  onDismiss: () => void;
}) {
  const t = useT();
  const steps = [
    {
      done: true,
      label: t("Create your account"),
      hint: t("You're in"),
    },
    {
      done: hasBrand,
      label: t("Teach your Brand Brain"),
      hint: t("Who you talk to + how you sound"),
      to: "/setup",
    },
    {
      done: hasDraft,
      label: t("Speak, draft, then Share"),
      hint: t("Talk it out, Draft now, open Drafts, tap Share"),
    },
  ];

  return (
    <div className="card checklist-card">
      <div className="row between" style={{ alignItems: "flex-start" }}>
        <div className="row" style={{ gap: 10, alignItems: "center" }}>
          <Spark size={40} mood="excited" />
          <div>
            <b>{t("Your first wins")}</b>
            <p className="muted small" style={{ margin: "2px 0 0" }}>
              {t("Three steps — then your voice ships.")}
            </p>
          </div>
        </div>
        <button type="button" className="btn ghost sm" onClick={onDismiss}>
          {t("Hide")}
        </button>
      </div>
      <ul className="checklist">
        {steps.map((s) => (
          <li key={s.label} className={s.done ? "done" : ""}>
            <span className={`check-mini ${s.done ? "on" : ""}`}>
              {s.done ? <CheckIcon size={12} /> : null}
            </span>
            <span className="checklist-copy">
              {s.to && !s.done ? (
                <Link to={s.to}>{s.label}</Link>
              ) : (
                <b>{s.label}</b>
              )}
              <span className="muted small">{s.hint}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
