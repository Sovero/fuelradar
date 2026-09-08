"use client";

/**
 * Переключение языка интерфейса (R100) — русский/английский, по умолчанию
 * русский (регион пилота). Хранится в localStorage на устройстве. Покрывает
 * статичные тексты интерфейса; переводы из `/meta` (виды топлива, статусы)
 * — там же, `name_en` с откатом на `name_ru`, если для конкретного пункта
 * английского перевода нет — см. lib/hooks/useMeta.tsx.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { DEFAULT_LOCALE, type Locale, type TranslationKey, translate, translateTemplate } from "@/lib/i18n";

interface I18nState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey) => string;
  /** Перевод с подстановкой {token} — для шаблонов вроде empty.headline. */
  tt: (key: TranslationKey, values: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nState | null>(null);
const STORAGE_KEY = "fr_locale";

function readStoredLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "ru" || stored === "en" ? stored : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    setLocaleState(readStoredLocale());
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage недоступен (приватный режим и т.п.) — просто не сохраняем выбор
    }
  }, []);

  const value = useMemo<I18nState>(
    () => ({
      locale,
      setLocale,
      t: (key: TranslationKey) => translate(locale, key),
      tt: (key: TranslationKey, values: Record<string, string | number>) => translateTemplate(locale, key, values),
    }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nState {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n должен использоваться внутри I18nProvider");
  return ctx;
}
