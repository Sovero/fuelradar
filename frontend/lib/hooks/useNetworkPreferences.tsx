"use client";

/**
 * Предпочтения сетей (R77) — персональная настройка (не URL-фильтр), хранится
 * в localStorage по числовому id сети (`/meta` отдаёт его с T10-доводки).
 * Отправляется на backend как `?preferred_brands=id1,id2` — Score.user_preferences
 * для этого запроса считает выбранные сети высшим приоритетом, независимо от
 * общего (одинакового для всех) `station_brands.priority` (`lib/api.ts`,
 * `HomeScreen.tsx`). Клиентский буст порядка (`lib/personalization.ts`) —
 * запасной путь для сортировок, где сервер не пересчитывает score.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

interface NetworkPreferencesState {
  preferredBrandIds: number[];
  toggleBrand: (id: number) => void;
  isPreferred: (id: number) => boolean;
  setPreferredBrandIds: (ids: number[]) => void;
}

const Ctx = createContext<NetworkPreferencesState | null>(null);
const STORAGE_KEY = "fr_preferred_brand_ids";

function readBrandIds(): number[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is number => typeof v === "number") : [];
  } catch {
    return [];
  }
}

function writeBrandIds(ids: number[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // не критично
  }
}

export function NetworkPreferencesProvider({ children }: { children: React.ReactNode }) {
  const [preferredBrandIds, setPreferredBrandIdsState] = useState<number[]>([]);

  useEffect(() => {
    setPreferredBrandIdsState(readBrandIds());
  }, []);

  const setPreferredBrandIds = useCallback((ids: number[]) => {
    setPreferredBrandIdsState(ids);
    writeBrandIds(ids);
  }, []);

  const toggleBrand = useCallback((id: number) => {
    setPreferredBrandIdsState((prev) => {
      const next = prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id];
      writeBrandIds(next);
      return next;
    });
  }, []);

  const isPreferred = useCallback((id: number) => preferredBrandIds.includes(id), [preferredBrandIds]);

  const value = useMemo<NetworkPreferencesState>(
    () => ({ preferredBrandIds, toggleBrand, isPreferred, setPreferredBrandIds }),
    [preferredBrandIds, toggleBrand, isPreferred, setPreferredBrandIds],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNetworkPreferences(): NetworkPreferencesState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useNetworkPreferences должен использоваться внутри NetworkPreferencesProvider");
  return ctx;
}
