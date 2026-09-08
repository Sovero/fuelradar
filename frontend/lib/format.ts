/** Форматирование чисел/времени для карточек и списка (R30/R74/R93). */

export function formatDistance(km: number | null | undefined): string {
  if (km === null || km === undefined) return "—";
  if (km < 1) return `${Math.round(km * 1000)} м`;
  return `${km.toFixed(1)} км`;
}

export function formatEtaMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "—";
  return `${Math.round(minutes)} мин`;
}

export function formatConfidence(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return "—";
  return `${Math.round(pct)}%`;
}

export function formatAgeMinutes(minutes: number): string {
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} ч ${rest} мин назад` : `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  return `${days} дн назад`;
}

/** Возраст наблюдения по ISO-времени обновления (updated_at из FuelStatusBrief). */
export function formatUpdatedAt(isoDate: string | null | undefined, now: Date = new Date()): string {
  if (!isoDate) return "нет данных";
  const updated = new Date(isoDate.endsWith("Z") ? isoDate : `${isoDate}Z`);
  const minutes = Math.max(0, Math.round((now.getTime() - updated.getTime()) / 60000));
  return formatAgeMinutes(minutes);
}

/** Внешний навигатор по координатам станции (R80) — deep-link, без встроенной навигации. */
export function buildRouteUrl(lat: number, lon: number, provider: "yandex" | "google" = "yandex"): string {
  if (provider === "google") {
    return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
  }
  return `https://yandex.ru/maps/?rtext=~${lat},${lon}&rtt=auto`;
}
