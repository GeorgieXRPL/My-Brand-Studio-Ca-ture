/** Preferred draft/output languages (Setup → generation + speech). */

export const OUTPUT_LANGUAGES = [
  { code: "en", label: "English", speech: "en-US" },
  { code: "mi", label: "Te Reo Māori", speech: "mi-NZ" },
  { code: "es", label: "Spanish", speech: "es-ES" },
  { code: "pt", label: "Portuguese", speech: "pt-BR" },
  { code: "fr", label: "French", speech: "fr-FR" },
  { code: "de", label: "German", speech: "de-DE" },
  { code: "it", label: "Italian", speech: "it-IT" },
  { code: "nl", label: "Dutch", speech: "nl-NL" },
  { code: "zh", label: "Chinese (Simplified)", speech: "zh-CN" },
  { code: "ja", label: "Japanese", speech: "ja-JP" },
  { code: "ko", label: "Korean", speech: "ko-KR" },
  { code: "hi", label: "Hindi", speech: "hi-IN" },
  { code: "ar", label: "Arabic", speech: "ar-SA" },
  { code: "ru", label: "Russian", speech: "ru-RU" },
  { code: "tr", label: "Turkish", speech: "tr-TR" },
  { code: "pl", label: "Polish", speech: "pl-PL" },
  { code: "vi", label: "Vietnamese", speech: "vi-VN" },
  { code: "th", label: "Thai", speech: "th-TH" },
  { code: "id", label: "Indonesian", speech: "id-ID" },
  { code: "tl", label: "Filipino / Tagalog", speech: "fil-PH" },
] as const;

export type OutputLanguageCode = (typeof OUTPUT_LANGUAGES)[number]["code"];

export function languageLabel(code?: string | null): string | null {
  if (!code) return null;
  return OUTPUT_LANGUAGES.find((l) => l.code === code)?.label ?? null;
}

export function speechLocaleFor(code?: string | null): string {
  if (!code) return "en-US";
  return OUTPUT_LANGUAGES.find((l) => l.code === code)?.speech ?? "en-US";
}

/** Dictation should follow the browser locale, not the draft output language. */
export function dictationLocale(preferred?: string | null): string {
  const browser = typeof navigator !== "undefined" ? navigator.language : "";
  if (browser) return browser;
  return speechLocaleFor(preferred);
}
