/** Preferred draft languages — keep labels in sync with app/src/lib/languages.ts */

export const OUTPUT_LANGUAGE_LABELS = {
  en: "English",
  mi: "Te Reo Māori",
  es: "Spanish",
  pt: "Portuguese",
  fr: "French",
  de: "German",
  it: "Italian",
  nl: "Dutch",
  zh: "Chinese (Simplified)",
  ja: "Japanese",
  ko: "Korean",
  hi: "Hindi",
  ar: "Arabic",
  ru: "Russian",
  tr: "Turkish",
  pl: "Polish",
  vi: "Vietnamese",
  th: "Thai",
  id: "Indonesian",
  tl: "Filipino / Tagalog",
};

export function resolveOutputLanguage(traits) {
  const code = traits?.preferred_language;
  if (!code || typeof code !== "string") return null;
  return OUTPUT_LANGUAGE_LABELS[code] || null;
}
