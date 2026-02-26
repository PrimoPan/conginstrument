export type AppLocale = "zh-CN" | "en-US";

export const DEFAULT_LOCALE: AppLocale = "zh-CN";

export function normalizeLocale(input: any): AppLocale {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) return DEFAULT_LOCALE;
  if (raw === "en" || raw === "en-us" || raw.startsWith("en-")) return "en-US";
  if (raw === "zh" || raw === "zh-cn" || raw.startsWith("zh-")) return "zh-CN";
  return DEFAULT_LOCALE;
}

export function isEnglishLocale(locale?: string | null): boolean {
  return normalizeLocale(locale) === "en-US";
}

export function localeName(locale?: string | null): string {
  return isEnglishLocale(locale) ? "English" : "简体中文";
}
