"use client";

/**
 * Пользовательский переключатель карты OSM/Яндекс (R102.1). Показывается в UI
 * только если задан непустой `NEXT_PUBLIC_YANDEX_MAPS_API_KEY` (см. hasYandex);
 * без ключа выбор всегда OSM и переключить нечего. Выбор хранится в
 * localStorage на устройстве — как тема (R99) и язык (R100). Дефолт при первом
 * визите — OSM независимо от наличия ключа: Яндекс включается только явным
 * действием пользователя, никогда не сам по себе.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { MapLibreProvider, YandexMapProvider, hasYandexMapsKey } from "@/lib/map";
import type { MapProviderComponent } from "@/lib/map/types";

export type MapProviderChoice = "osm" | "yandex";

interface MapProviderPreferenceState {
  choice: MapProviderChoice;
  setChoice: (choice: MapProviderChoice) => void;
  hasYandex: boolean;
  ProviderComponent: MapProviderComponent;
}

const Ctx = createContext<MapProviderPreferenceState | null>(null);
const STORAGE_KEY = "fr_map_provider";

export function MapProviderPreferenceProvider({ children }: { children: React.ReactNode }) {
  const hasYandex = hasYandexMapsKey();
  // SSR-безопасный дефолт: OSM и на сервере, и при первом клиентском рендере
  // (см. урок с useStations — читать localStorage в инициализаторе нельзя).
  const [choice, setChoiceState] = useState<MapProviderChoice>("osm");

  useEffect(() => {
    if (!hasYandex) return; // без ключа переключать некуда — всегда OSM
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "yandex") setChoiceState("yandex");
    } catch {
      // localStorage недоступен — остаёмся на дефолтном OSM для этой сессии
    }
  }, [hasYandex]);

  const setChoice = useCallback(
    (next: MapProviderChoice) => {
      if (next === "yandex" && !hasYandex) return; // нельзя включить без ключа
      setChoiceState(next);
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // не критично — выбор просто не переживёт перезагрузку
      }
    },
    [hasYandex],
  );

  const ProviderComponent = useMemo<MapProviderComponent>(
    () => (choice === "yandex" && hasYandex ? YandexMapProvider : MapLibreProvider),
    [choice, hasYandex],
  );

  const value = useMemo<MapProviderPreferenceState>(
    () => ({ choice, setChoice, hasYandex, ProviderComponent }),
    [choice, setChoice, hasYandex, ProviderComponent],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMapProviderPreference(): MapProviderPreferenceState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useMapProviderPreference должен использоваться внутри MapProviderPreferenceProvider");
  return ctx;
}
