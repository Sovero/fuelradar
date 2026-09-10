/** R50: уровни heatmap из брифа — зелёный/жёлтый/красный + текст (R50.1). */

import type { HeatCell, HeatLevel } from "@/lib/types";

export type HeatLevelName = "high" | "medium" | "low";

export const HEAT_COLORS: Record<HeatLevelName, string> = {
  high: "#16a34a", // зелёный — высокая доступность
  medium: "#eab308", // жёлтый — снижение
  low: "#dc2626", // красный — дефицит
};

/** Уровень по порогам легенды ответа /heat/cells (порядок: от большего порога). */
export function heatLevelFor(
  availability: number | null,
  levels: HeatLevel[],
): HeatLevelName | null {
  if (availability === null) return null; // «нет данных» — ячейка не рисуется
  for (const { level, min_availability } of levels) {
    if (availability >= min_availability) return level as HeatLevelName;
  }
  return "low";
}

/** Круги для обеих реализаций карты — один источник формы и цвета. */
export function heatCircle(
  cell: HeatCell,
  color: string,
): { lat: number; lon: number; color: string; stationId: string } {
  return { lat: cell.lat, lon: cell.lon, color, stationId: cell.station_id };
}
