import { describe, expect, it } from "vitest";
import { haversineKm, haversineMeters, isValidLat, isValidLon, shouldRebuildFollowMeZone } from "@/lib/geo";

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
