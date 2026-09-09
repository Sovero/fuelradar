import { describe, expect, it } from "vitest";
import { applyObservationMode, applyPreferredBrandsOrder, DEFAULT_OBSERVATION_SETTINGS } from "@/lib/personalization";
import type { StationBrief } from "@/lib/types";

function station(id: string, brand: string | null): StationBrief {
  return {
    id,
    name: id,
    brand,
    latitude: 45,
    longitude: 38,
    address: "",
    city: "",
    distance_km: null,
    eta_minutes: null,
    statuses: [],
    queue: null,
    score: null,
  };
}

const stations = [station("a", "Лукойл"), station("b", "Роснефть"), station("c", null), station("d", "Лукойл")];

describe("applyObservationMode (R25)", () => {
  it("режим all — ничего не фильтрует", () => {
    expect(applyObservationMode(stations, DEFAULT_OBSERVATION_SETTINGS, new Set())).toEqual(stations);
  });

  it("режим networks — только выбранные сети; пустой выбор = все станции (не 'ничего')", () => {
    const filtered = applyObservationMode(
      stations,
      { mode: "networks", selectedBrands: ["Роснефть"], excludedStationIds: [] },
      new Set(),
    );
    expect(filtered.map((s) => s.id)).toEqual(["b"]);

    const emptySelection = applyObservationMode(
      stations,
      { mode: "networks", selectedBrands: [], excludedStationIds: [] },
      new Set(),
    );
    expect(emptySelection).toEqual(stations);
  });

  it("режим favorites — только станции из набора избранного", () => {
    const filtered = applyObservationMode(
      stations,
      { mode: "favorites", selectedBrands: [], excludedStationIds: [] },
      new Set(["a", "c"]),
    );
    expect(filtered.map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("режим exclude — исключённые станции не мозолят глаза (R25.1)", () => {
    const filtered = applyObservationMode(
      stations,
      { mode: "exclude", selectedBrands: [], excludedStationIds: ["b"] },
      new Set(),
    );
    expect(filtered.map((s) => s.id)).toEqual(["a", "c", "d"]);
  });
});

describe("applyPreferredBrandsOrder (R77)", () => {
  it("без предпочтений — порядок не меняется", () => {
    expect(applyPreferredBrandsOrder(stations, [])).toEqual(stations);
  });

  it("предпочитаемые сети поднимаются наверх, порядок внутри групп сохраняется", () => {
    const reordered = applyPreferredBrandsOrder(stations, ["Лукойл"]);
    expect(reordered.map((s) => s.id)).toEqual(["a", "d", "b", "c"]);
  });
});
