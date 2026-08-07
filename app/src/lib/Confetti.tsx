import { useEffect, useState } from "react";

const COLORS = ["#8b5cf6", "#2dd4ed", "#34d399", "#fbbf24", "#f472b6"];

// One-shot celebration burst. Mount it and it cleans itself up.
export default function Confetti({ onDone }: { onDone?: () => void }) {
  const [pieces] = useState(() =>
    Array.from({ length: 26 }, (_, i) => ({
      left: Math.random() * 100,
      delay: Math.random() * 0.35,
      duration: 1 + Math.random() * 0.9,
      color: COLORS[i % COLORS.length],
      size: 6 + Math.random() * 6,
      spin: Math.random() > 0.5 ? 1 : -1,
    }))
  );

  useEffect(() => {
    const t = window.setTimeout(() => onDone?.(), 2200);
    return () => window.clearTimeout(t);
  }, [onDone]);

  return (
    <div className="confetti" aria-hidden="true">
      {pieces.map((p, i) => (
        <i
          key={i}
          style={{
            left: `${p.left}%`,
            width: p.size,
            height: p.size * 0.6,
            background: p.color,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.duration}s`,
            transform: `rotate(${p.spin * 40}deg)`,
          }}
        />
      ))}
    </div>
  );
}

const CELEBRATE_KEY = "celebrate";

export function queueCelebration() {
  sessionStorage.setItem(CELEBRATE_KEY, "1");
}

export function takeCelebration(): boolean {
  const has = sessionStorage.getItem(CELEBRATE_KEY) === "1";
  if (has) sessionStorage.removeItem(CELEBRATE_KEY);
  return has;
}
