import { MapLibreProvider } from "@/lib/map/maplibre-provider";
import { YandexMapProvider } from "@/lib/map/yandex-provider";
import type { MapProviderComponent } from "@/lib/map/types";

export { MapLibreProvider, YandexMapProvider };

/**
 * Слой карты абстрагирован за `MapProviderProps` (R61) — сегодня две
 * реализации: MapLibre GL + OSM-тайлы (бесплатно, по умолчанию) и Яндекс.Карты
 * (платный сервис, опционально). Какая из них показана — решает пользователь
 * через переключатель в шапке (R102.1, только если задан ключ), это состояние
 * живёт в `lib/hooks/useMapProviderPreference.tsx`, а не здесь: этот модуль
 * лишь предоставляет сами компоненты-реализации и признак доступности Яндекса.
 */
export function hasYandexMapsKey(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_YANDEX_MAPS_API_KEY);
}

/** Точка выбора для мест без интерактивного переключателя (например тестов) — по умолчанию OSM. */
export function defaultMapProvider(): MapProviderComponent {
  return MapLibreProvider;
}

export * from "@/lib/map/types";
