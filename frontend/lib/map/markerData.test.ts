import { describe, expect, it } from "vitest";
import { buildStationMarker } from "@/lib/map/markerData";
import type { StationBrief } from "@/lib/types";

function station(overrides: Partial<StationBrief> = {}): StationBrief {
  return {
    id: "fr_station_1",
    name: "Тестовая АЗС",
    brand: null,
    latitude: 45.0,
    longitude: 39.0,
    address: "",
    city: "",
    distance_km: null,
    eta_minutes: null,
    statuses: [],
    queue: null,
    score: null,
    ...overrides,
  };
}

describe("buildStationMarker", () => {
  it("без выбора топлива берёт агрегат — лучший из имеющихся статусов", () => {
    const s = station({
      statuses: [
        { fuel_code: "AI_92", status: "UNAVAILABLE", confidence: 90, updated_at: null, expires_at: null },
        { fuel_code: "AI_95", status: "AVAILABLE", confidence: 95, updated_at: null, expires_at: null },
      ],
    });
    const marker = buildStationMarker(s, []);
    expect(marker.color).toBe("#16a34a"); // зелёный — по AVAILABLE
  });

  it("составной маркер: до 2-3 значков при нескольких выбранных видах топлива (R28)", () => {
    const s = station({
      statuses: [
        { fuel_code: "AI_95", status: "AVAILABLE", confidence: 90, updated_at: null, expires_at: null },
        { fuel_code: "DT", status: "UNAVAILABLE", confidence: 80, updated_at: null, expires_at: null },
      ],
    });
    const marker = buildStationMarker(s, ["AI_95", "DT"]);
    expect(marker.badges).toHaveLength(2);
    expect(marker.badges.find((b) => b.fuelCode === "AI_95")?.ok).toBe(true);
    expect(marker.badges.find((b) => b.fuelCode === "DT")?.ok).toBe(false);
  });

  it("выбранное топливо без наблюдений — UNKNOWN («нет данных»), а не «нет топлива» (R15)", () => {
    const s = station({ statuses: [] });
    const marker = buildStationMarker(s, ["AI_95"]);
    expect(marker.badges).toHaveLength(1);
    expect(marker.badges[0].status).toBe("UNKNOWN");
    expect(marker.badges[0].ok).toBe(false);
    expect(marker.color).toBe("#9ca3af");
  });

  it("не более 3 значков даже если выбрано больше видов топлива", () => {
    const s = station({
      statuses: [
        { fuel_code: "AI_92", status: "AVAILABLE", confidence: 90, updated_at: null, expires_at: null },
        { fuel_code: "AI_95", status: "AVAILABLE", confidence: 90, updated_at: null, expires_at: null },
        { fuel_code: "AI_98", status: "AVAILABLE", confidence: 90, updated_at: null, expires_at: null },
        { fuel_code: "DT", status: "AVAILABLE", confidence: 90, updated_at: null, expires_at: null },
      ],
    });
    const marker = buildStationMarker(s, ["AI_92", "AI_95", "AI_98", "DT"]);
    expect(marker.badges.length).toBeLessThanOrEqual(3);
  });

  it("независимая станция (без brand) — маркер без кольца сети (R103)", () => {
    const s = station({ brand: null });
    const marker = buildStationMarker(s, []);
    expect(marker.ringColor).toBeNull();
  });

  it("станция с сетью — маркер получает кольцо цветом сети, не подменяя заливку статуса (R103)", () => {
    const s = station({
      brand: "Лукойл",
      statuses: [{ fuel_code: "AI_95", status: "AVAILABLE", confidence: 95, updated_at: null, expires_at: null }],
    });
    const marker = buildStationMarker(s, []);
    expect(marker.ringColor).not.toBeNull();
    expect(marker.color).toBe("#16a34a"); // заливка статуса не изменилась
  });
});
