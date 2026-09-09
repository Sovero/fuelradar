/**
 * Режимы наблюдения (R25) и предпочтения сетей (R77) — чистые функции без
 * React/сети, чтобы их можно было проверить юнит-тестами напрямую. Настройки
 * персональные (не URL-фильтр §32.1) — хранятся в localStorage через
 * `lib/hooks/useObservationMode.tsx` / `useNetworkPreferences.tsx`, здесь
 * только применение к уже полученному от API списку станций.
 *
 * R77 (предпочтения сетей) с доводки после слепой приёмки: `/meta` отдаёт
 * числовой `id` сети, `GET /stations`/`/stations/{id}` принимают
 * `preferred_brands=<id,...>` и персонализируют `user_preferences` в Score
 * на backend (`HomeScreen.tsx` передаёт его в запрос). `applyPreferredBrandsOrder`
 * здесь остаётся запасным клиентским бустом порядка для сортировок, которые
 * не используют score (например `sort=distance`).
 *
 * Режим «выбранные сети»/«с исключениями» (R25) — по-прежнему фильтр списка/
 * карты на клиенте (сравнение по имени сети), не персистентный скоуп правила
 * уведомлений: у него другая задача (что показывать), не влияние на Score.
 */

import type { StationBrief } from "@/lib/types";

export type ObservationMode = "all" | "networks" | "favorites" | "exclude";

export interface ObservationSettings {
  mode: ObservationMode;
  selectedBrands: string[];
  excludedStationIds: string[];
}

export const DEFAULT_OBSERVATION_SETTINGS: ObservationSettings = {
  mode: "all",
  selectedBrands: [],
  excludedStationIds: [],
};

/**
 * Применяет режим наблюдения (R25) к списку станций для карты/списка.
 * `favoriteIds` нужен только для режима "favorites" — станции остаются в
 * "избранном" списке независимо (там своя вкладка), это фильтр общего списка.
 */
export function applyObservationMode(
  stations: StationBrief[],
  settings: ObservationSettings,
  favoriteIds: ReadonlySet<string>,
): StationBrief[] {
  switch (settings.mode) {
    case "networks":
      if (settings.selectedBrands.length === 0) return stations;
      return stations.filter((s) => s.brand !== null && settings.selectedBrands.includes(s.brand));
    case "favorites":
      return stations.filter((s) => favoriteIds.has(s.id));
    case "exclude":
      if (settings.excludedStationIds.length === 0) return stations;
      return stations.filter((s) => !settings.excludedStationIds.includes(s.id));
    case "all":
    default:
      return stations;
  }
}

/**
 * Предпочтения сетей (R77) — влияют на порядок списка. Сортировка API
 * (`sort=score`, где Score уже учитывает статический приоритет сети — см.
 * `station_brands.priority`/`ranking/score.py`) не персонализирована. Здесь —
 * стабильный клиентский буст: станции предпочитаемых сетей поднимаются в
 * начало, порядок внутри каждой группы (предпочитаемые/остальные) сохраняется
 * как пришёл от API — так сортировка по расстоянию/очереди и т.п. внутри
 * группы не ломается.
 */
export function applyPreferredBrandsOrder(stations: StationBrief[], preferredBrands: string[]): StationBrief[] {
  if (preferredBrands.length === 0) return stations;
  const preferred: StationBrief[] = [];
  const rest: StationBrief[] = [];
  for (const s of stations) {
    if (s.brand !== null && preferredBrands.includes(s.brand)) preferred.push(s);
    else rest.push(s);
  }
  return [...preferred, ...rest];
}
