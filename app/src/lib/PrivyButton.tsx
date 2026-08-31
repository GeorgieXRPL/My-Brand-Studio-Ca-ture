import { usePrivy } from "@privy-io/react-auth";
import { useT } from "./i18n";

export default function PrivyButton({ className = "" }: { className?: string }) {
  const t = useT();
  const { ready, login } = usePrivy();
  return (
    <button
      type="button"
      className={`btn privy-btn block ${className}`.trim()}
      disabled={!ready}
      onClick={() => {
        login();
      }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          d="M12 2a7 7 0 0 0-7 7v3H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V9a7 7 0 0 0-7-7Zm-5 7a5 5 0 0 1 10 0v3H7V9Zm5 7.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z"
        />
      </svg>
      {t("Continue with Privy")}
    </button>
  );
}
