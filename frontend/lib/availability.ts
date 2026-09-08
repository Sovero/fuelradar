import type { StationBrief } from "@/lib/types";

/**
 * «Найдено» ли топливо у станции — подтверждённое наличие по выбранным видам
 * (R75/R75.1): AVAILABLE всегда считается найденным; LIKELY_AVAILABLE — только
 * если явно включено «Показывать вероятное наличие». UNKNOWN/UNAVAILABLE/др.
 * никогда не считаются «найдено» — инвариант R15 (UNKNOWN ≠ UNAVAILABLE, но и
 * не «есть»).
 */
export function isConfirmedForFuels(station: StationBrief, fuelCodes: string[], includeLikely: boolean): boolean {
  const relevant = fuelCodes.length ? station.statuses.filter((s) => fuelCodes.includes(s.fuel_code)) : station.statuses;
  return relevant.some((s) => s.status === "AVAILABLE" || (includeLikely && s.status === "LIKELY_AVAILABLE"));
}

export function countConfirmed(stations: StationBrief[], fuelCodes: string[], includeLikely: boolean): number {
  return stations.filter((s) => isConfirmedForFuels(s, fuelCodes, includeLikely)).length;
}
