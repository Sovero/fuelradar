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

/** Длина полилинии по прямой (сумма haversine-сегментов) — для подписи маршрута. */
export function polylineLengthKm(points: ReadonlyArray<{ lat: number; lon: number }>): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineKm(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
  }
  return total;
}

/**
 * Точка на половине длины полилинии (по кумулятивному haversine) — место подписи
 * расстояния/ETA на линии маршрута. Для двух точек это середина отрезка.
 */
export function midpointAlong(points: ReadonlyArray<{ lat: number; lon: number }>): { lat: number; lon: number } | null {
  if (points.length < 2) return null;
  const segments = points.slice(1).map((point, index) => haversineKm(points[index].lat, points[index].lon, point.lat, point.lon));
  const total = segments.reduce((sum, length) => sum + length, 0);
  if (total === 0) return { lat: points[0].lat, lon: points[0].lon };
  let passed = 0;
  for (let i = 0; i < segments.length; i++) {
    if (passed + segments[i] >= total / 2) {
      const ratio = (total / 2 - passed) / segments[i];
      return {
        lat: points[i].lat + (points[i + 1].lat - points[i].lat) * ratio,
        lon: points[i].lon + (points[i + 1].lon - points[i].lon) * ratio,
      };
    }
    passed += segments[i];
  }
  return { lat: points[points.length - 1].lat, lon: points[points.length - 1].lon };
}

/**
 * Прореживает длинную геометрию маршрута до `maxPoints`, сохраняя первую и
 * последнюю точки. Нужна, чтобы коридор станций считался по реальной дорожной
 * линии (её может быть несколько тысяч точек, а API принимает до 100).
 */
export function decimatePolyline<T extends { lat: number; lon: number }>(
  points: ReadonlyArray<T>,
  maxPoints: number,
): Array<{ lat: number; lon: number }> {
  const plain = points.map((point) => ({ lat: point.lat, lon: point.lon }));
  if (plain.length <= maxPoints || maxPoints < 2) return plain;
  const step = (plain.length - 1) / (maxPoints - 1);
  const kept = Array.from({ length: maxPoints }, (_, index) => plain[Math.round(index * step)]);
  kept[maxPoints - 1] = plain[plain.length - 1];
  return kept;
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
