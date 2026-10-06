"use client";

import { useCallback, useEffect, useState } from "react";
import { REFRESH_SECONDS_DEFAULT, normalizeRefreshSeconds } from "@/lib/collectionCycles";

const STORAGE_KEY = "fuelradar:cycles-refresh-seconds";

/**
 * Период автообновления админской вкладки «Циклы сбора» (по прямой просьбе
 * оператора: поле для ручного ввода, по умолчанию 60 с).
 *
 * Хранится в localStorage, как остальные пользовательские предпочтения: значение
 * переживает перезагрузку и переключение вкладок админки. Хранилище недоступно —
 * настройка живёт до перезагрузки, но не ломает страницу; битое/чужое значение
 * нормализуется той же чистой функцией, что и ввод в поле.
 */
export function useCyclesRefresh() {
  const [seconds, setSecondsState] = useState(REFRESH_SECONDS_DEFAULT);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored !== null) setSecondsState(normalizeRefreshSeconds(stored));
    } catch {
      // localStorage недоступен — остаёмся на дефолте, честно
    }
  }, []);

  const setSeconds = useCallback((next: unknown) => {
    const value = normalizeRefreshSeconds(next);
    setSecondsState(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      // нет доступа к хранилищу — период действует до перезагрузки
    }
  }, []);

  return { seconds, setSeconds };
}
