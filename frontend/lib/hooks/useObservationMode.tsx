"use client";

/**
 * Режим наблюдения (R25): все / выбранные сети / избранные / с исключениями.
 * Персональная настройка, не URL-фильтр (§32.1 — та часть, что не адресуется
 * диплинком) — хранится в localStorage. Применение к списку станций — чистые
 * функции `lib/personalization.ts` (там же объяснение ограничений R77/сеть).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { DEFAULT_OBSERVATION_SETTINGS, type ObservationMode, type ObservationSettings } from "@/lib/personalization";

interface ObservationModeState {
  settings: ObservationSettings;
  setMode: (mode: ObservationMode) => void;
  setSelectedBrands: (brands: string[]) => void;
  toggleExcluded: (stationId: string) => void;
  isExcluded: (stationId: string) => boolean;
}

const Ctx = createContext<ObservationModeState | null>(null);
const STORAGE_KEY = "fr_observation_mode";

function readSettings(): ObservationSettings {
  if (typeof window === "undefined") return DEFAULT_OBSERVATION_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_OBSERVATION_SETTINGS;
    const parsed = JSON.parse(raw);
    return {
      mode: (["all", "networks", "favorites", "exclude"] as ObservationMode[]).includes(parsed?.mode)
        ? parsed.mode
        : "all",
      selectedBrands: Array.isArray(parsed?.selectedBrands) ? parsed.selectedBrands : [],
      excludedStationIds: Array.isArray(parsed?.excludedStationIds) ? parsed.excludedStationIds : [],
    };
  } catch {
    return DEFAULT_OBSERVATION_SETTINGS;
  }
}

function writeSettings(settings: ObservationSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // не критично — режим просто не переживёт перезагрузку
  }
}

export function ObservationModeProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettingsState] = useState<ObservationSettings>(DEFAULT_OBSERVATION_SETTINGS);

  useEffect(() => {
    setSettingsState(readSettings());
  }, []);

  const update = useCallback((patch: Partial<ObservationSettings>) => {
    setSettingsState((prev) => {
      const next = { ...prev, ...patch };
      writeSettings(next);
      return next;
    });
  }, []);

  const setMode = useCallback((mode: ObservationMode) => update({ mode }), [update]);
  const setSelectedBrands = useCallback((selectedBrands: string[]) => update({ selectedBrands }), [update]);
  const toggleExcluded = useCallback(
    (stationId: string) => {
      setSettingsState((prev) => {
        const has = prev.excludedStationIds.includes(stationId);
        const next = {
          ...prev,
          excludedStationIds: has
            ? prev.excludedStationIds.filter((id) => id !== stationId)
            : [...prev.excludedStationIds, stationId],
        };
        writeSettings(next);
        return next;
      });
    },
    [],
  );
  const isExcluded = useCallback((stationId: string) => settings.excludedStationIds.includes(stationId), [settings.excludedStationIds]);

  const value = useMemo<ObservationModeState>(
    () => ({ settings, setMode, setSelectedBrands, toggleExcluded, isExcluded }),
    [settings, setMode, setSelectedBrands, toggleExcluded, isExcluded],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useObservationMode(): ObservationModeState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useObservationMode должен использоваться внутри ObservationModeProvider");
  return ctx;
}
