import { describe, expect, it } from "vitest";

import { HEAT_COLORS, heatCircle, heatLevelFor } from "@/lib/heatmap";
import type { HeatLevel } from "@/lib/types";

const LEVELS: HeatLevel[] = [
  { level: "high", min_availability: 0.67 },
  { level: "medium", min_availability: 0.34 },
  { level: "low", min_availability: 0.0 },
];

describe("heatLevelFor (R50)", () => {
  it("раскладывает доступность по порогам легенды: зелёный/жёлтый/красный", () => {
    expect(heatLevelFor(1.0, LEVELS)).toBe("high");
    expect(heatLevelFor(0.67, LEVELS)).toBe("high");
    expect(heatLevelFor(0.66, LEVELS)).toBe("medium");
    expect(heatLevelFor(0.34, LEVELS)).toBe("medium");
    expect(heatLevelFor(0.33, LEVELS)).toBe("low");
    expect(heatLevelFor(0.0, LEVELS)).toBe("low");
  });

  it("ячейка без определённых статусов не рисуется (нет данных ≠ дефицит)", () => {
    expect(heatLevelFor(null, LEVELS)).toBeNull();
  });

  it("цвета соответствуют брифу §23: зелёный/жёлтый/красный", () => {
    expect(HEAT_COLORS.high).toBe("#16a34a");
    expect(HEAT_COLORS.medium).toBe("#eab308");
    expect(HEAT_COLORS.low).toBe("#dc2626");
  });

  it("heatCircle переносит данные ячейки без изменений", () => {
    const circle = heatCircle({ station_id: "fr_1", lat: 45, lon: 39, known: 1, availability: 0.9 }, "#fff");
    expect(circle).toEqual({ lat: 45, lon: 39, color: "#fff", stationId: "fr_1" });
  });
});
