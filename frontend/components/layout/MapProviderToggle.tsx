"use client";

import { useMapProviderPreference } from "@/lib/hooks/useMapProviderPreference";

/**
 * Переключатель подложки карты OSM/Яндекс (R102.1). Рендерится только если
 * задан ключ Яндекс.Карт (`hasYandex`) — без ключа переключать нечего, и
 * компонент не должен создавать видимость выбора, которого на самом деле нет.
 */
export function MapProviderToggle() {
  const { choice, setChoice, hasYandex } = useMapProviderPreference();

  if (!hasYandex) return null;

  return (
    <button
      type="button"
      onClick={() => setChoice(choice === "osm" ? "yandex" : "osm")}
      aria-label={`Карта: ${choice === "osm" ? "OSM" : "Яндекс"} — нажмите, чтобы переключить`}
      title="Переключить подложку карты"
      className="rounded-full px-2 py-1 text-xs font-semibold uppercase text-gray-500 hover:bg-black/5 dark:text-gray-400 dark:hover:bg-white/10"
    >
      {choice === "osm" ? "OSM" : "Яндекс"}
    </button>
  );
}
