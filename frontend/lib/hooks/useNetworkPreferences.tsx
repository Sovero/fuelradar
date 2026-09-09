"use client";

/**
 * Предпочтения сетей (R77) — персональная настройка (не URL-фильтр), хранится
 * в localStorage. `/meta` не отдаёт числовой id сети и `GET /stations` не
 * принимает `preferred_brands` (см. CONCERNS отчёта T10) — поэтому влияние на
 * порядок списка ограничено клиентским бустом (`lib/personalization.ts`), а
 * не персонализацией серверного Score.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

interface NetworkPreferencesState {
  preferredBrands: string[];
  toggleBrand: (name: string) => void;
  isPreferred: (name: string) => boolean;
  setPreferredBrands: (names: string[]) => void;
}

const Ctx = createContext<NetworkPreferencesState | null>(null);
const STORAGE_KEY = "fr_preferred_brands";

function readBrands(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeBrands(names: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
  } catch {
    // не критично
  }
}

export function NetworkPreferencesProvider({ children }: { children: React.ReactNode }) {
  const [preferredBrands, setPreferredBrandsState] = useState<string[]>([]);

  useEffect(() => {
    setPreferredBrandsState(readBrands());
  }, []);

  const setPreferredBrands = useCallback((names: string[]) => {
    setPreferredBrandsState(names);
    writeBrands(names);
  }, []);

  const toggleBrand = useCallback((name: string) => {
    setPreferredBrandsState((prev) => {
      const next = prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name];
      writeBrands(next);
      return next;
    });
  }, []);

  const isPreferred = useCallback((name: string) => preferredBrands.includes(name), [preferredBrands]);

  const value = useMemo<NetworkPreferencesState>(
    () => ({ preferredBrands, toggleBrand, isPreferred, setPreferredBrands }),
    [preferredBrands, toggleBrand, isPreferred, setPreferredBrands],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNetworkPreferences(): NetworkPreferencesState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useNetworkPreferences должен использоваться внутри NetworkPreferencesProvider");
  return ctx;
}
