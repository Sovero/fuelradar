"use client";

import { useCallback, useEffect, useState } from "react";
import type { RouteProvider } from "@/lib/format";

const STORAGE_KEY = "fuelradar:nav-provider";
const PROVIDERS: RouteProvider[] = ["yandex", "2gis", "google"];

function isRouteProvider(value: string | null): value is RouteProvider {
  return (PROVIDERS as string[]).includes(value ?? "");
}

/**
 * Выбор внешнего навигатора (spec: «Выбор навигатора в карточке станции»).
 * Дефолт — Яндекс.Карты; сохранённое значение из localStorage валидируется:
 * чужое/битое отбрасывается к дефолту, а не ломает тип.
 */
export function useNavigationPreference() {
  const [provider, setProviderState] = useState<RouteProvider>("yandex");

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (isRouteProvider(stored)) {
        setProviderState(stored);
      }
    } catch {
      // localStorage недоступен — остаёмся на дефолте
    }
  }, []);

  const setProvider = useCallback((next: RouteProvider) => {
    setProviderState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // нет доступа к хранилищу — выбор живёт до перезагрузки, честно
    }
  }, []);

  return { provider, setProvider };
}
