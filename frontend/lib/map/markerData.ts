import type { StationBrief } from "@/lib/types";
import { brandRingColor } from "@/lib/map/brandColor";
import { statusRank, statusVisual } from "@/lib/map/statusColor";
import type { MarkerBadge, StationMarker } from "@/lib/map/types";

/**
 * Строит данные маркера станции по выбранным видам топлива (R27/R28).
 * Без выбора топлива — по агрегату (наилучший из имеющихся статусов, R27 п.1).
 * До 2-3 значков на маркере (R28: «95 ✅ / ДТ ❌»). Кольцо сети (R103) —
 * отдельный слой поверх заливки статуса, не подменяет и не смешивается с ней.
 */
export function buildStationMarker(station: StationBrief, selectedFuelCodes: string[]): StationMarker {
  const relevant = selectedFuelCodes.length
    ? station.statuses.filter((s) => selectedFuelCodes.includes(s.fuel_code))
    : station.statuses;

  const badges: MarkerBadge[] = relevant
    .slice()
    .sort((a, b) => a.fuel_code.localeCompare(b.fuel_code))
    .slice(0, 3)
    .map((s) => ({ fuelCode: s.fuel_code, status: s.status, ok: statusVisual(s.status).ok }));

  // Если топливо выбрано, но по нему вообще нет статуса — считать это UNKNOWN (нет данных),
  // а не «нет топлива» (R15/R27.1).
  if (selectedFuelCodes.length && badges.length === 0) {
    for (const code of selectedFuelCodes.slice(0, 3)) {
      badges.push({ fuelCode: code, status: "UNKNOWN", ok: false });
    }
  }

  const best = badges.reduce<MarkerBadge | null>((acc, b) => {
    if (!acc || statusRank(b.status) > statusRank(acc.status)) return b;
    return acc;
  }, null);

  return {
    id: station.id,
    lat: station.latitude,
    lon: station.longitude,
    color: statusVisual(best?.status ?? "UNKNOWN").hex,
    badges,
    ringColor: brandRingColor(station.brand),
  };
}

export function buildStationMarkers(stations: StationBrief[], selectedFuelCodes: string[]): StationMarker[] {
  return stations.map((s) => buildStationMarker(s, selectedFuelCodes));
}
