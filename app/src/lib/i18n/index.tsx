import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isRtl, translate } from "./catalog";
import { DICTS } from "./dicts";

const STORAGE_KEY = "brand.uiLanguage";

type LocaleCtx = {
  locale: string;
  setLocale: (code: string) => void;
  /** Pass English UI copy (or a legacy key). Returns translated string for current locale. */
  t: (phraseOrKey: string, vars?: Record<string, string | number>) => string;
};

const Ctx = createContext<LocaleCtx | null>(null);

export function readStoredLocale(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || "en";
  } catch {
    return "en";
  }
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState(readStoredLocale);

  const setLocale = useCallback((code: string) => {
    const next = code || "en";
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = isRtl(locale) ? "rtl" : "ltr";
  }, [locale]);

  const t = useCallback(
    (phraseOrKey: string, vars?: Record<string, string | number>) => translate(locale, phraseOrKey, vars, DICTS),
    [locale]
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLocale() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useLocale must be used within LanguageProvider");
  return ctx;
}

export function useT() {
  return useLocale().t;
}
