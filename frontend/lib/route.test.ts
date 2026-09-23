import { describe, expect, it } from "vitest";

import { stepAtFraction } from "@/lib/route";
import type { MapPoint } from "@/lib/map/types";
import type { RoutePlanStep } from "@/lib/types";

function step(overrides: Partial<RoutePlanStep> = {}): RoutePlanStep {
  return {
    type: "turn",
    modifier: "right",
    street: "ул. Северная",
    distance_m: 100,
    duration_s: 15,
    ...overrides,
  };
}

const GEOMETRY: MapPoint[] = [
  { lat: 45.0, lon: 38.9 },
  { lat: 45.0, lon: 38.96 },
];

describe("stepAtFraction (подсвеченный маневр маршрута)", () => {
  it("берёт шаг, в диапазон которого попадает середина маршрута", () => {
    const steps = [
      step({ type: "depart", distance_m: 120, lat: 45.0, lon: 38.9 }),
      step({ distance_m: 3100, lat: 45.01, lon: 38.92 }),
      step({ type: "arrive", distance_m: 0, lat: 45.02, lon: 38.96 }),
    ];

    // Маршрут 4.2 км → отметка 2.1 км попадает во второй шаг (120..3220 м).
    const active = stepAtFraction(steps, GEOMETRY, 4.2);

    expect(active?.index).toBe(1);
    expect(active?.point).toEqual({ lat: 45.01, lon: 38.92 });
  });

  it("интерполирует точку по геометрии, когда роутер не отдал координаты маневра", () => {
    const steps = [
      step({ type: "depart", distance_m: 3000, street: null }),
      step({ distance_m: 1000, street: null }),
    ];

    // Старый backend без lat/lon: точка — на 0.0 доли линии, то есть в начале.
    const active = stepAtFraction(steps, GEOMETRY, 4.0);

    expect(active?.index).toBe(0);
    expect(active?.point?.lat).toBeCloseTo(45.0, 5);
    expect(active?.point?.lon).toBeCloseTo(38.9, 5);
  });

  it("возвращает последний шаг, когда сумма шагов короче маршрута (усечённый список)", () => {
    const steps = [step({ distance_m: 100 }), step({ distance_m: 100, lat: 45.03, lon: 38.94 })];

    const active = stepAtFraction(steps, null, 5.0);

    expect(active?.index).toBe(1);
    expect(active?.point).toEqual({ lat: 45.03, lon: 38.94 });
  });

  it("без шагов или без дистанции активного маневра нет", () => {
    expect(stepAtFraction([], GEOMETRY, 4.2)).toBeNull();
    expect(stepAtFraction([step()], GEOMETRY, null)).toBeNull();
    expect(stepAtFraction([step()], GEOMETRY, 0)).toBeNull();
  });

  it("без координат и без геометрии отдаёт шаг без точки (перелетать некуда)", () => {
    const active = stepAtFraction([step({ distance_m: 1000 })], null, 1.0);

    expect(active?.index).toBe(0);
    expect(active?.point).toBeNull();
  });

  it("доля вне 0..1 зажимается в границы", () => {
    const steps = [step({ distance_m: 1000, lat: 45.0, lon: 38.9 }), step({ distance_m: 1000, lat: 45.1, lon: 38.99 })];

    expect(stepAtFraction(steps, null, 2.0, -1)?.index).toBe(0);
    expect(stepAtFraction(steps, null, 2.0, 2)?.index).toBe(1);
  });
});
