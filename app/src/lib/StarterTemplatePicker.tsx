import { STARTER_TEMPLATES, starterAppLabels } from "./starterTemplates";
import { useT } from "./i18n";

export default function StarterTemplatePicker({
  disabled,
  selectedId,
  onPick,
}: {
  disabled?: boolean;
  selectedId?: string;
  onPick: (id: string) => void;
}) {
  const t = useT();
  return (
    <div className="starter-grid">
      {STARTER_TEMPLATES.map((tpl) => (
        <button
          key={tpl.id}
          type="button"
          className={`starter-card ${selectedId === tpl.id ? "on" : ""}`}
          disabled={disabled}
          onClick={() => onPick(tpl.id)}
        >
          <span className="starter-cat">{t(tpl.category)}</span>
          <strong>{t(tpl.name)}</strong>
          <span className="starter-pitch">{t(tpl.pitch)}</span>
          <span className="starter-apps">{starterAppLabels(tpl).join(" · ")}</span>
        </button>
      ))}
    </div>
  );
}
