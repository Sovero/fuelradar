import { describe, expect, it } from "vitest";
import { buildPricePoints, priceRangeLabel } from "./priceHistory";
import type { HistoryItem } from "./types";

const entry = (overrides: Partial<HistoryItem>): HistoryItem => ({
  confidence_raw: 90,
  fuel_code: "AI_95",
  status: "AVAILABLE",
  source: "OSM",
  observed_at: "2026-09-08T10:00:00",
  received_at: null,
  ...overrides,
});

describe("buildPricePoints", () => {
  it("пустая история → нет точек", () => {
    expect(buildPricePoints([])).toEqual([]);
  });

  it("только записи без цены → нет точек", () => {
    const history = [entry({ observed_at: "2026-09-08T10:00:00" })];
    expect(buildPricePoints(history)).toEqual([]);
  });

  it("одна цена → одна точка без пометки о пропусках", () => {
    const history = [
      entry({ observed_at: "2026-09-08T10:00:00" }),
      entry({ price: 59.9, price_currency: "RUB", source: "Пользовательские отчёты", observed_at: "2026-09-08T11:00:00" }),
    ];
    const points = buildPricePoints(history);
    expect(points).toHaveLength(1);
    expect(points[0].y).toBeCloseTo(59.9);
    expect(points[0].label).toContain("59.90");
    expect(points[0].label).toContain("₽");
    expect(points[0].label).toContain("Пользовательские отчёты");
    expect(points[0].label).not.toContain("без цены");
  });

  it("точки в хронологическом порядке независимо от порядка входа", () => {
    const history = [
      entry({ price: 61.0, observed_at: "2026-09-08T12:00:00" }),
      entry({ price: 59.5, observed_at: "2026-09-08T09:00:00" }),
    ];
    const points = buildPricePoints(history);
    expect(points).toHaveLength(2);
    expect(points[0].y).toBeCloseTo(59.5);
    expect(points[1].y).toBeCloseTo(61.0);
  });

  it("пропуск считается честно: записи без цены перед точкой — в подписи", () => {
    const history = [
      entry({ price: 58.0, observed_at: "2026-09-08T09:00:00" }),
      entry({ observed_at: "2026-09-08T10:00:00" }),
      entry({ observed_at: "2026-09-08T11:00:00" }),
      entry({ price: 60.0, observed_at: "2026-09-08T12:00:00" }),
    ];
    const points = buildPricePoints(history);
    expect(points).toHaveLength(2);
    expect(points[0].label).not.toContain("без цены");
    expect(points[1].label).toContain("2 записей без цены");
  });

  it("валюта из наблюдения, не хардкод", () => {
    const history = [entry({ price: 1.99, price_currency: "USD", observed_at: "2026-09-08T09:00:00" })];
    const points = buildPricePoints(history);
    expect(points[0].label).toContain("USD");
    expect(points[0].label).not.toContain("₽");
  });

  it("priceRangeLabel: пустой набор → null", () => {
    expect(priceRangeLabel([])).toBeNull();
  });

  it("priceRangeLabel: одна цена → null (диапазона нет, подпись не нужна)", () => {
    const history = [entry({ price: 59.9, observed_at: "2026-09-08T09:00:00" })];
    expect(priceRangeLabel(history)).toBeNull();
  });

  it("priceRangeLabel: диапазон мин—макс по ценовым точкам с валютой", () => {
    const history = [
      entry({ price: 58.0, observed_at: "2026-09-08T09:00:00" }),
      entry({ price: 63.7, observed_at: "2026-09-08T12:00:00" }),
      entry({ price: 61.0, observed_at: "2026-09-08T15:00:00" }),
    ];
    expect(priceRangeLabel(history)).toBe("58.00 ₽ — 63.70 ₽");
  });

  it("priceRangeLabel: цена одинаковая во всех точках → null (мин = макс)", () => {
    const history = [
      entry({ price: 60.0, observed_at: "2026-09-08T09:00:00" }),
      entry({ price: 60.0, observed_at: "2026-09-08T12:00:00" }),
    ];
    expect(priceRangeLabel(history)).toBeNull();
  });

  it("priceRangeLabel: валюта берётся из наблюдений", () => {
    const history = [
      entry({ price: 1.5, price_currency: "USD", observed_at: "2026-09-08T09:00:00" }),
      entry({ price: 2.5, price_currency: "USD", observed_at: "2026-09-08T12:00:00" }),
    ];
    expect(priceRangeLabel(history)).toBe("1.50 USD — 2.50 USD");
  });
});
