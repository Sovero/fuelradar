/**
 * Обновление данных GeoJSON-источника MapLibre без потери апдейтов.
 *
 * Зачем отдельный хелпер: наивный гейт `map.isStyleLoaded() && map.getSource(id)`
 * молча теряет обновления. В MapLibre 4 `Style.loaded()` возвращает false не только
 * до загрузки стиля, но и пока обновляется любой источник (`_updatedSources`, его
 * выставляет в том числе `setData` соседнего источника) или грузятся тайлы. Эффект,
 * заставший такое окно, подписывался на `once("load")`, а событие `load` после
 * первого старта карты больше не наступает — данные не применялись до следующего
 * случайного изменения (на живом стенде так не рисовалась линия маршрута).
 *
 * Правильный критерий готовности — существование источника в стиле:
 *   - источника ещё нет (стиль не загружен) → ждём `load`;
 *   - источник есть → применяем сразу, даже если `loaded()` временно false.
 */

/** Минимум MapLibre-карты, нужный хелперу (структурно совместим с maplibregl.Map). */
export interface SourceReadyMap {
  getSource: (id: string) => unknown;
  once: (event: "load", listener: () => void) => void;
}

export function applyWhenSourceReady(map: SourceReadyMap, sourceId: string, apply: () => void): void {
  if (map.getSource(sourceId)) apply();
  else map.once("load", apply);
}
