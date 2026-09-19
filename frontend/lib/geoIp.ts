"use client";

/**
 * Резервное определение местоположения по IP (T-geo).
 *
 * Зачем: на десктопах без GPS-приёмника Chromium берёт координаты из сетевого
 * location-провайдера (Google NLS). В сетях, где он недоступен (ошибка 403 от
 * www.googleapis.com, корпоративные прокси, региональные сети),
 * navigator.geolocation стабильно отвечает POSITION_UNAVAILABLE — подтверждено
 * диагностическим пробником desktop/scripts/geo-probe.cjs и живым прогоном.
 * Резервный провайдер отдаёт город с точностью до района — этого достаточно,
 * чтобы «Найти рядом» уехал в правильный город; точную точку пользователь
 * всегда может задать вручную (настройки приватности).
 *
 * Провайдеры: ipwho.is (HTTPS, без ключа) → ip-api.com (HTTP, без ключа;
 * годится на http-страницах dev/десктоп-оболочки, на HTTPS-проде браузер
 * заблокирует mixed content — поэтому он только вторым). Запросы идут по
 * цепочке до первого успеха; таймаут каждого — 6 с.
 *
 * Приватность (R24): запрос выполняется ТОЛЬКО по явному действию пользователя
 * (клик «Найти топливо рядом»), как и navigator.geolocation. Провайдеру в любом
 * случае виден IP клиента; координаты ответа никуда, кроме фильтров карты,
 * не уходят и не сохраняются в истории позиций.
 */

export interface IpLookupResult {
  lat: number;
  lon: number;
  /** Город, как его назвал провайдер (может быть пустым) — для сообщений пользователю. */
  place: string;
}

const TIMEOUT_MS = 6_000;

type RawResponse = Record<string, unknown>;

const PROVIDERS: ReadonlyArray<{ url: string; parse: (data: RawResponse) => IpLookupResult | string }> = [
  {
    // HTTPS — основной; работает и на https-страницах прода.
    url: "https://ipwho.is/?fields=success,message,latitude,longitude,city",
    parse: (d) => {
      if (d.success !== true) {
        return typeof d.message === "string" ? `ipwho.is: ${d.message}` : "ipwho.is: unexpected response";
      }
      if (typeof d.latitude !== "number" || typeof d.longitude !== "number") {
        return "ipwho.is: missing coordinates";
      }
      return { lat: d.latitude, lon: d.longitude, place: typeof d.city === "string" ? d.city : "" };
    },
  },
  {
    // HTTP — только резерв: на HTTPS-странице такой запрос будет заблокирован
    // как mixed content, но на http (dev, desktop-оболочка) он спасает, когда
    // основной провайдер упёрся в лимит или недоступен.
    url: "http://ip-api.com/json/?fields=status,message,lat,lon,city&lang=ru",
    parse: (d) => {
      if (d.status !== "success") {
        return typeof d.message === "string" ? `ip-api: ${d.message}` : "ip-api: unexpected response";
      }
      if (typeof d.lat !== "number" || typeof d.lon !== "number") {
        return "ip-api: missing coordinates";
      }
      return { lat: d.lat, lon: d.lon, place: typeof d.city === "string" ? d.city : "" };
    },
  },
];

async function tryProvider(provider: (typeof PROVIDERS)[number]): Promise<IpLookupResult> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(provider.url, { signal: timeout.signal, cache: "no-store" });
    if (!res.ok) {
      throw new Error(`ip-lookup HTTP ${res.status}`);
    }
    const data: unknown = await res.json();
    if (!data || typeof data !== "object") {
      throw new Error("ip-lookup: unexpected response");
    }
    const parsed = provider.parse(data as RawResponse);
    if (typeof parsed === "string") {
      throw new Error(parsed);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

/** Перебирает провайдеров по цепочке; бросает последнюю ошибку, если ни один не ответил. */
export async function lookupIpPosition(): Promise<IpLookupResult> {
  let lastError: unknown = new Error("ip-lookup: no providers configured");
  for (const provider of PROVIDERS) {
    try {
      return await tryProvider(provider);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
