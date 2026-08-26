import type { CSSProperties } from "react";
import { PLATFORMS, PLATFORM_COLORS, PLATFORM_LABELS, type Platform } from "./types";
import { toggleEnabledPlatform } from "./enabledPlatforms";
import { useT } from "./i18n";

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
  return (
    <div className="platform-picker">
      {!compact && (
        <p className="card-desc" style={{ marginTop: 0 }}>
          {t("Draft now only writes for the apps you turn on. Share still lets you pick at send time.")}
        </p>
      )}
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
