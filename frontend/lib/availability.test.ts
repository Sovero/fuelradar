import { describe, expect, it } from "vitest";
import { countConfirmed, isConfirmedForFuels } from "@/lib/availability";
import type { StationBrief } from "@/lib/types";

function station(statuses: StationBrief["statuses"]): StationBrief {
  return {
    id: "s1",
    name: "АЗС",
    brand: null,
    latitude: 45,
    longitude: 39,
    address: "",
    city: "",
    distance_km: null,
    eta_minutes: null,
    statuses,
    queue: null,
    score: null,
  };
}

describe("isConfirmedForFuels / countConfirmed (R75/R75.1)", () => {
  it("AVAILABLE всегда считается найденным", () => {
    const s = station([{ fuel_code: "AI_95", status: "AVAILABLE", confidence: 90, updated_at: null, expires_at: null }]);
    expect(isConfirmedForFuels(s, ["AI_95"], false)).toBe(true);
  });

  it("LIKELY_AVAILABLE засчитывается только при includeLikely=true", () => {
    const s = station([{ fuel_code: "AI_95", status: "LIKELY_AVAILABLE", confidence: 70, updated_at: null, expires_at: null }]);
    expect(isConfirmedForFuels(s, ["AI_95"], false)).toBe(false);
    expect(isConfirmedForFuels(s, ["AI_95"], true)).toBe(true);
  });

  it("UNKNOWN никогда не считается «найдено» (R15/R75.1)", () => {
    const s = station([{ fuel_code: "AI_95", status: "UNKNOWN", confidence: 0, updated_at: null, expires_at: null }]);
    expect(isConfirmedForFuels(s, ["AI_95"], true)).toBe(false);
  });

  it("countConfirmed считает по всем станциям", () => {
    const stations = [
      station([{ fuel_code: "AI_95", status: "AVAILABLE", confidence: 90, updated_at: null, expires_at: null }]),
      station([{ fuel_code: "AI_95", status: "UNAVAILABLE", confidence: 90, updated_at: null, expires_at: null }]),
    ];
    expect(countConfirmed(stations, ["AI_95"], false)).toBe(1);
  });
});
