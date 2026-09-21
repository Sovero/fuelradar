import { describe, expect, it } from "vitest";
import { decimatePolyline, haversineKm, haversineMeters, isValidLat, isValidLon, midpointAlong, polylineLengthKm, shouldRebuildFollowMeZone } from "@/lib/geo";

describe("decimatePolyline (R22.1)", () => {
  it("короткую линию не трогает", () => {
    const points = [
      { lat: 45.0, lon: 38.9 },
      { lat: 45.01, lon: 38.91 },
    ];
    expect(decimatePolyline(points, 100)).toEqual(points);
  });

  it("длинную сводит к лимиту, сохраняя начало и конец (порядок движения)", () => {
    const points = Array.from({ length: 1000 }, (_, index) => ({ lat: 45 + index * 0.0001, lon: 38.9 }));
    const kept = decimatePolyline(points, 100);

    expect(kept).toHaveLength(100);
    expect(kept[0]).toEqual(points[0]);
    expect(kept[99]).toEqual(points[999]);
    // Порядок по широте не ломается — линия остаётся направленной.
    expect(kept[50].lat).toBeGreaterThan(kept[10].lat);
  });
});

describe("haversineKm/haversineMeters", () => {
  it("нулевое расстояние в одной и той же точке", () => {
    expect(haversineKm(45.0, 38.97, 45.0, 38.97)).toBeCloseTo(0, 6);
  });

  it("известное расстояние между двумя точками (~ город vs пригород)", () => {
    // ~1 градус широты ≈ 111 км
    const km = haversineKm(45.0, 38.0, 46.0, 38.0);
    expect(km).toBeGreaterThan(110);
    expect(km).toBeLessThan(112);
  });

  it("haversineMeters = haversineKm * 1000", () => {
    const km = haversineKm(45.0, 38.0, 45.01, 38.01);
    expect(haversineMeters(45.0, 38.0, 45.01, 38.01)).toBeCloseTo(km * 1000, 6);
  });
});

describe("isValidLat/isValidLon", () => {
  it("границы диапазона", () => {
    expect(isValidLat(90)).toBe(true);
    expect(isValidLat(-90)).toBe(true);
    expect(isValidLat(90.0001)).toBe(false);
    expect(isValidLon(180)).toBe(true);
    expect(isValidLon(-180.5)).toBe(false);
  });

  it("не число / NaN — невалидны", () => {
    expect(isValidLat(NaN)).toBe(false);
    expect(isValidLon(Infinity)).toBe(false);
  });
});

describe("shouldRebuildFollowMeZone (R23.1)", () => {
  it("небольшое дрожание GPS не требует перестройки зоны", () => {
    // ~200 м смещения — меньше порога 2 км
    expect(shouldRebuildFollowMeZone(45.0, 38.0, 45.002, 38.0)).toBe(false);
  });

  it("значимый переезд требует перестройки", () => {
    // ~1 градус широты ≈ 111 км — точно за порогом
    expect(shouldRebuildFollowMeZone(45.0, 38.0, 45.05, 38.0)).toBe(true);
  });

  it("порог настраиваемый", () => {
    expect(shouldRebuildFollowMeZone(45.0, 38.0, 45.02, 38.0, 1)).toBe(true);
    expect(shouldRebuildFollowMeZone(45.0, 38.0, 45.02, 38.0, 10)).toBe(false);
  });
});

describe("polylineLengthKm", () => {
  it("две точки — длина отрезка, как haversine", () => {
    const points = [
      { lat: 45.0, lon: 38.94 },
      { lat: 45.0, lon: 38.99 },
    ];
    expect(polylineLengthKm(points)).toBeCloseTo(haversineKm(45.0, 38.94, 45.0, 38.99), 9);
  });

  it("сумма по трём точкам", () => {
    const points = [
      { lat: 45.0, lon: 38.94 },
      { lat: 45.0, lon: 38.99 },
      { lat: 45.01, lon: 38.99 },
    ];
    const expected = haversineKm(45.0, 38.94, 45.0, 38.99) + haversineKm(45.0, 38.99, 45.01, 38.99);
    expect(polylineLengthKm(points)).toBeCloseTo(expected, 9);
  });

  it("мало точек / нулевая линия — ноль", () => {
    expect(polylineLengthKm([])).toBe(0);
    expect(polylineLengthKm([{ lat: 45, lon: 38 }])).toBe(0);
    expect(polylineLengthKm([{ lat: 45, lon: 38 }, { lat: 45, lon: 38 }])).toBe(0);
  });
});

describe("midpointAlong", () => {
  it("для двух точек — середина отрезка", () => {
    const mid = midpointAlong([
      { lat: 45.0, lon: 38.94 },
      { lat: 45.0, lon: 39.0 },
    ]);
    expect(mid).not.toBeNull();
    expect(mid!.lat).toBeCloseTo(45.0, 9);
    expect(mid!.lon).toBeCloseTo(38.97, 9);
  });

  it("мало точек — null", () => {
    expect(midpointAlong([])).toBeNull();
    expect(midpointAlong([{ lat: 45, lon: 38 }])).toBeNull();
  });

  it("совпадающие точки — первая точка, без деления на ноль", () => {
    const mid = midpointAlong([
      { lat: 45.0, lon: 38.94 },
      { lat: 45.0, lon: 38.94 },
    ]);
    expect(mid).toEqual({ lat: 45.0, lon: 38.94 });
  });
});
