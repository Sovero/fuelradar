"use client";

import { useI18n } from "@/lib/hooks/useI18n";

/** Переключатель языка интерфейса ru/en (R100), по умолчанию русский. */
export function LocaleToggle() {
  const { locale, setLocale } = useI18n();

  return (
    <button
      type="button"
      onClick={() => setLocale(locale === "ru" ? "en" : "ru")}
      aria-label={locale === "ru" ? "Switch to English" : "Переключить на русский"}
      title={locale === "ru" ? "Switch to English" : "Переключить на русский"}
      className="rounded-full px-2 py-1 text-xs font-semibold uppercase text-gray-500 hover:bg-black/5 dark:text-gray-400 dark:hover:bg-white/10"
    >
      {locale === "ru" ? "EN" : "RU"}
    </button>
  );
}
