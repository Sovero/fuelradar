"use client";

/**
 * Ознакомительный тур (R101) — показывается один раз при первом визите,
 * состояние «пройден/пропущен» хранится в localStorage (без бэкенда, без
 * привязки к профилю — работает и для анонима). Можно пропустить в любой
 * момент и запустить повторно (например из шапки — см. TourRestartButton).
 * Если localStorage недоступен (приватный режим и т.п.) — тур просто не
 * показывается сам, но кнопка «показать тур ещё раз» продолжает работать
 * в рамках текущей сессии (без сохранения).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

interface OnboardingState {
  open: boolean;
  start: () => void;
  finish: () => void;
}

const OnboardingContext = createContext<OnboardingState | null>(null);
const STORAGE_KEY = "fr_tour_completed";

export function OnboardingProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      const done = window.localStorage.getItem(STORAGE_KEY);
      if (!done) setOpen(true);
    } catch {
      // localStorage недоступен — просто не показываем автозапуск тура
    }
  }, []);

  const start = useCallback(() => setOpen(true), []);

  const finish = useCallback(() => {
    setOpen(false);
    try {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // не критично — тур просто предложат снова в следующий визит
    }
  }, []);

  const value = useMemo<OnboardingState>(() => ({ open, start, finish }), [open, start, finish]);

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

export function useOnboarding(): OnboardingState {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error("useOnboarding должен использоваться внутри OnboardingProvider");
  return ctx;
}
