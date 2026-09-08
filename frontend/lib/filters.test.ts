import { describe, expect, it } from "vitest";
import { DEFAULT_FILTERS, filtersFromSearchParams, filtersToSearchParams } from "@/lib/filters";

describe("filters <-> URL", () => {
  it("сериализует и разбирает фильтры без потерь", () => {
    const filters = {
      ...DEFAULT_FILTERS,
      fuels: ["AI_95", "DT"],
      radiusKm: 20,
      brand: "ЛУКОЙЛ",
      status: "AVAILABLE",
      confidenceMin: 80,
      queueMax: "LOW",
      search: "Красная",
      includeLikely: true,
      tab: "list" as const,
      station: "fr_station_1",
      lat: 45.03,
      lon: 38.97,
    };
    const params = filtersToSearchParams(filters);
    const parsed = filtersFromSearchParams(params);
    expect(parsed).toEqual(filters);
  });

  it("значения по умолчанию не попадают в URL (пустой query для дефолтных фильтров)", () => {
    const params = filtersToSearchParams(DEFAULT_FILTERS);
    expect(params.toString()).toBe("");
  });

  it("переключение вкладок не теряет остальные фильтры (R32.1)", () => {
    const params = new URLSearchParams("fuels=AI_95&radius=20&tab=map");
    const filters = filtersFromSearchParams(params);
    const switched = filtersToSearchParams({ ...filters, tab: "favorites" });
    const reparsed = filtersFromSearchParams(switched);
    expect(reparsed.fuels).toEqual(["AI_95"]);
    expect(reparsed.radiusKm).toBe(20);
    expect(reparsed.tab).toBe("favorites");
  });
});
