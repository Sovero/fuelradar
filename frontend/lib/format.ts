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

/** R78: цена с валютой; отсутствие данных — «нет данных», никогда не 0 (R78.3). */
export function formatPrice(
  price: number | null | undefined,
  currency: string | null | undefined = "RUB",
  labels: { noData: string } = { noData: "нет данных" },
): string {
  if (price === null || price === undefined) return labels.noData;
  const value = price.toFixed(2);
  if (currency === "RUB") return `${value} ₽`;
  return `${value} ${currency ?? ""}`.trim();
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

/**
 * Naive-UTC ISO от backend → Date.
 *
 * Без «Z» браузер прочитал бы такое время как локальное и показал сдвиг на часы,
 * поэтому зона дочитывается явно; мусор/пусто → null (не выдумываем дату).
 */
export function parseUtcIso(isoDate: string | null | undefined): Date | null {
  if (!isoDate) return null;
  const withZone = /[Zz]|[+-]\d{2}:\d{2}$/.test(isoDate) ? isoDate : `${isoDate}Z`;
  const at = new Date(withZone);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Точная дата-время в зоне пользователя — для подсказок (title), где «3 мин назад» мало. */
export function formatUtcDateTime(isoDate: string | null | undefined): string | null {
  return parseUtcIso(isoDate)?.toLocaleString() ?? null;
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
