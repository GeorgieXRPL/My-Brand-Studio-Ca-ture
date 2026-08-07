import { useId } from "react";

// Spark — the Brand Studio mascot. A friendly gradient orb with eyes,
// used for empty states, the tour and celebrations (Duolingo-style warmth).

export type SparkMood = "happy" | "excited" | "thinking" | "sleepy";

export default function Spark({ size = 64, mood = "happy" }: { size?: number; mood?: SparkMood }) {
  const gradId = useId().replace(/:/g, "");
  return (
    <span className={`spark spark-${mood}`} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 64 64" width={size} height={size}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#a78bfa" />
            <stop offset="55%" stopColor="#8b5cf6" />
            <stop offset="100%" stopColor="#2dd4ed" />
          </linearGradient>
        </defs>
        <circle cx="32" cy="32" r="26" fill={`url(#${gradId})`} />
        <circle cx="24" cy="22" r="8" fill="rgba(255,255,255,0.28)" />
        {/* eyes */}
        {mood === "sleepy" ? (
          <>
            <path d="M20 30 q4 4 8 0" stroke="#0d1120" strokeWidth="3" fill="none" strokeLinecap="round" />
            <path d="M36 30 q4 4 8 0" stroke="#0d1120" strokeWidth="3" fill="none" strokeLinecap="round" />
          </>
        ) : (
          <>
            <circle className="spark-eye" cx="24" cy="30" r={mood === "excited" ? 4.5 : 3.5} fill="#0d1120" />
            <circle className="spark-eye" cx="40" cy="30" r={mood === "excited" ? 4.5 : 3.5} fill="#0d1120" />
            <circle cx="25.4" cy="28.6" r="1.3" fill="#fff" />
            <circle cx="41.4" cy="28.6" r="1.3" fill="#fff" />
          </>
        )}
        {/* mouth */}
        {mood === "excited" ? (
          <path d="M25 40 q7 8 14 0 z" fill="#0d1120" />
        ) : mood === "thinking" ? (
          <path d="M27 42 h10" stroke="#0d1120" strokeWidth="3" strokeLinecap="round" />
        ) : (
          <path d="M25 40 q7 6 14 0" stroke="#0d1120" strokeWidth="3" fill="none" strokeLinecap="round" />
        )}
        {/* sparkle */}
        <path
          className="spark-star"
          d="M52 10 l1.6 4 4 1.6 -4 1.6 -1.6 4 -1.6 -4 -4 -1.6 4 -1.6 z"
          fill="#fef08a"
        />
      </svg>
    </span>
  );
}
