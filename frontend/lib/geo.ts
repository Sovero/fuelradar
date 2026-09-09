/**
 * Геовычисления на клиенте (R23/R40): та же формула haversine, что и на
 * backend (`backend/app/dedup/compare.py::distance_km`) — используется, чтобы
 * показать пользователю «вы рядом» и решить, перестраивать ли зону «вокруг
 * меня» (R23.1), без похода на сервер за каждым движением.
 */

const EARTH_RADIUS_KM = 6371.0;

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return haversineKm(lat1, lon1, lat2, lon2) * 1000;
}

export function isValidLat(v: number): boolean {
  return Number.isFinite(v) && v >= -90 && v <= 90;
}

export function isValidLon(v: number): boolean {
  return Number.isFinite(v) && v >= -180 && v <= 180;
}

/** R23.1: «переезд» — новая позиция ушла за порог от прежнего центра зоны. */
export const FOLLOW_ME_REBUILD_THRESHOLD_KM = 2;

export function shouldRebuildFollowMeZone(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  thresholdKm: number = FOLLOW_ME_REBUILD_THRESHOLD_KM,
): boolean {
  return haversineKm(lat1, lon1, lat2, lon2) > thresholdKm;
}
