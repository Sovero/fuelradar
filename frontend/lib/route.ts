/**
 * Дорожный маршрут: чистая геометрия шагов (R22.1).
 *
 * Подпись расстояния стоит на середине линии, а вкладка маневров подсвечивает
 * шаг, в диапазон которого попадает эта отметка. Точку подсвеченного маневра
 * берём из самого шага (координаты `maneuver.location` отдаёт роутер), а если
 * их нет — интерполируем по геометрии на накопленную дистанцию начала шага.
 * Отсюда карта знает, куда перелетать по клику на подпись.
 */

import type { MapPoint } from "@/lib/map/types";
import { pointAlongRatio } from "@/lib/geo";
import type { RoutePlanStep } from "@/lib/types";

/** Подсвеченный шаг маршрута и точка маневра, к которой перелетает камера. */
export interface ActiveRouteStep {
  index: number;
  /** Координаты маневра; null — ни шаг, ни геометрия их не дали (перелетать некуда). */
  point: MapPoint | null;
}

/** Подпись стоит на половине длины маршрута — та же доля ищет активный шаг. */
const LABEL_FRACTION = 0.5;

function maneuverPoint(
  step: RoutePlanStep,
  geometry: ReadonlyArray<MapPoint> | null | undefined,
  startRatio: number,
): MapPoint | null {
  if (typeof step.lat === "number" && typeof step.lon === "number") {
    return { lat: step.lat, lon: step.lon };
  }
  if (!geometry || geometry.length < 2) return null;
  return pointAlongRatio(geometry, startRatio);
}

/**
 * Шаг, на который попадает отметка `fraction` длины маршрута (по умолчанию —
 * середина, где стоит подпись), и точка его маневра.
 *
 * `null` — шагов нет или длина маршрута неизвестна: подсвечивать и перелетать
 * не к чему. Если сумма шагов короче маршрута (роутер отдал усечённый список),
 * активным становится последний шаг — как и раньше.
 */
export function stepAtFraction(
  steps: ReadonlyArray<RoutePlanStep>,
  geometry: ReadonlyArray<MapPoint> | null | undefined,
  distanceKm: number | null | undefined,
  fraction: number = LABEL_FRACTION,
): ActiveRouteStep | null {
  if (steps.length === 0) return null;
  if (typeof distanceKm !== "number" || !(distanceKm > 0)) return null;

  const totalM = distanceKm * 1000;
  const targetM = totalM * Math.min(1, Math.max(0, fraction));
  let passed = 0;

  // Шаг i покрывает [passed, passed + distance_m); маневр стоит в начале шага.
  for (let index = 0; index < steps.length - 1; index++) {
    const end = passed + (steps[index].distance_m || 0);
    if (targetM < end) {
      return { index, point: maneuverPoint(steps[index], geometry, passed / totalM) };
    }
    passed = end;
  }

  const lastIndex = steps.length - 1;
  return { index: lastIndex, point: maneuverPoint(steps[lastIndex], geometry, passed / totalM) };
}
