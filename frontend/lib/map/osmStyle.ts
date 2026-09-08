import type { StyleSpecification } from "maplibre-gl";

/**
 * Растровые тайлы OpenStreetMap по умолчанию (R61) — без ключей API.
 * Провайдер тайлов сознательно вынесен сюда отдельной константой, чтобы
 * его можно было заменить конфигурацией, не трогая код карты.
 */
export const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";
/** Общедоступный шрифтовый сервер MapLibre (без ключа) — нужен для text-field слоёв
 * кластеров и составных маркеров (глифы не связаны с растровыми тайлами OSM). */
export const GLYPHS_URL = "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf";

export function buildOsmStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sources: {
      osm: {
        type: "raster",
        tiles: [OSM_TILE_URL],
        tileSize: 256,
        attribution: OSM_ATTRIBUTION,
        maxzoom: 19,
      },
    },
    layers: [
      {
        id: "osm-tiles",
        type: "raster",
        source: "osm",
      },
    ],
  };
}
