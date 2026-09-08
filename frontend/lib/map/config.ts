/**
 * Начальный вид карты, когда ещё нет геолокации/выбранной станции. Это
 * только положение камеры по умолчанию, а не данные станций/топлива — не
 * подпадает под R98i. Координаты берутся из окружения (R04/R81: без региона,
 * зашитого в код), пилотный регион Краснодара — только пример в .env.example.
 */
function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const DEFAULT_MAP_CENTER: [number, number] = [
  envFloat("NEXT_PUBLIC_DEFAULT_MAP_LON", 38.9753),
  envFloat("NEXT_PUBLIC_DEFAULT_MAP_LAT", 45.0355),
]; // [lon, lat]
export const DEFAULT_MAP_ZOOM = 12;
export const NEARBY_ZOOM = 13;
