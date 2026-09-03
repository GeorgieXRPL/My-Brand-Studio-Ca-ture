import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { CheckIcon } from "./icons";
import { PLATFORMS, PLATFORM_COLORS, PLATFORM_LABELS, type Platform } from "./types";
import { toggleEnabledPlatform } from "./enabledPlatforms";
import { useT } from "./i18n";

type MenuPos =
  | { kind: "up"; left: number; width: number; bottom: number; maxHeight: number }
  | { kind: "down"; left: number; width: number; top: number; maxHeight: number };

function summaryLabel(selected: Platform[], t: (s: string, vars?: Record<string, string | number>) => string) {
  if (selected.length === PLATFORMS.length) return t("All apps");
  if (selected.length <= 2) return selected.map((p) => PLATFORM_LABELS[p]).join(", ");
  return t("{n} apps", { n: selected.length });
}

function PlatformMenu({
  selected,
  onChange,
  disabled,
}: {
  selected: Platform[];
  onChange: (next: Platform[]) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<MenuPos | null>(null);

  function place() {
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const gap = 6;
    const pad = 12;
    const width = Math.min(Math.max(r.width, 240), window.innerWidth - pad * 2);
    let left = r.left;
    if (left + width > window.innerWidth - pad) left = window.innerWidth - pad - width;
    if (left < pad) left = pad;
    const want = Math.min(320, Math.round(window.innerHeight * 0.5));
    const spaceBelow = window.innerHeight - r.bottom - gap - pad;
    const spaceAbove = r.top - gap - pad;
    if (spaceAbove >= spaceBelow) {
      setPos({
        kind: "up",
        left,
        width,
        bottom: window.innerHeight - r.top + gap,
        maxHeight: Math.max(160, Math.min(want, spaceAbove)),
      });
    } else {
      setPos({
        kind: "down",
        left,
        width,
        top: r.bottom + gap,
        maxHeight: Math.max(160, Math.min(want, spaceBelow)),
      });
    }
  }

  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
    const onPointer = (e: PointerEvent) => {
      const n = e.target;
      if (!(n instanceof Node)) return;
      if (wrapRef.current?.contains(n) || menuRef.current?.contains(n)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  return (
    <div className="platform-menu" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="platform-menu-trigger"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("Choose apps")}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="platform-menu-summary">{summaryLabel(selected, t)}</span>
        <svg
          className={`caret ${open ? "open" : ""}`}
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="platform-menu-list"
            role="menu"
            aria-label={t("Choose apps")}
            style={{
              left: pos.left,
              width: pos.width,
              maxHeight: pos.maxHeight,
              ...(pos.kind === "up" ? { bottom: pos.bottom } : { top: pos.top }),
            }}
          >
            {PLATFORMS.map((p) => {
              const on = selected.includes(p);
              return (
                <button
                  key={p}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  className={`platform-menu-item ${on ? "on" : ""}`}
                  onClick={() => onChange(toggleEnabledPlatform(selected, p))}
                >
                  <span className="platform-menu-dot" style={{ background: PLATFORM_COLORS[p] }} />
                  {PLATFORM_LABELS[p]}
                  {on ? <CheckIcon size={16} /> : null}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </div>
  );
}

export default function PlatformPicker({
  selected,
  onChange,
  disabled,
  compact,
}: {
  selected: Platform[];
  onChange: (next: Platform[]) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const t = useT();
  if (compact) {
    return <PlatformMenu selected={selected} onChange={onChange} disabled={disabled} />;
  }
  return (
    <div className="platform-picker">
      <p className="card-desc" style={{ marginTop: 0 }}>
        {t("Draft now only writes for the apps you turn on. Share still lets you pick at send time.")}
      </p>
      <div className="chip-row">
        {PLATFORMS.map((p) => {
          const on = selected.includes(p);
          return (
            <button
              key={p}
              type="button"
              className={`chip-btn ${on ? "on" : ""}`}
              disabled={disabled}
              style={{ "--plat-color": PLATFORM_COLORS[p] } as CSSProperties}
              onClick={() => onChange(toggleEnabledPlatform(selected, p))}
            >
              {PLATFORM_LABELS[p]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
