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
 * Проверка правдоподобия: IP-провайдер видит внешний адрес (VPN/прокси/CDN-вход
 * оператора) и может вернуть точку в другой стране. Такая точка хуже отсутствия:
 * карта улетает за тысячи км и «рядом» показывает пустоту. Поэтому перед
 * применением ответ проверяется на удалённость от домашнего якоря региона
 * (центр по умолчанию из env) — слишком далёкие ответы отбрасываются, и
 * пользователь получает честную ошибку вместо перелёта не туда (R97i).
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

import { haversineKm } from "@/lib/geo";

export interface IpLookupResult {
  lat: number;
  lon: number;
  /** Город, как его назвал провайдер (может быть пустым) — для сообщений пользователю. */
  place: string;
}

/** Домашний якорь: точка, рядом с которой IP-ответ считается правдоподобным. */
export interface HomeAnchor {
  lat: number;
  lon: number;
}

export interface LookupIpOptions {
  /** Якорь домашнего региона + максимальное расстояние до него в км. */
  anchor?: HomeAnchor;
  maxDistanceKm?: number;
}

/** Радиус правдоподобия по умолчанию: Щедрый запас поверх городского радиуса. */
export const IP_FAR_THRESHOLD_KM = 150;

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

/** IP-точка слишком далеко от домашнего якоря (VPN/прокси в другой стране). */
export class IpPositionUnplausibleError extends Error {
  constructor(
    public readonly distanceKm: number,
    public readonly thresholdKm: number,
  ) {
    super(`ip-lookup: result ${Math.round(distanceKm)} km away from home region (limit ${thresholdKm} km)`);
    this.name = "IpPositionUnplausibleError";
  }
}

/**
 * Память о том, что сеть отвечает «не отсюда» (VPN/прокси). Заполняется при
 * первом отклонённом IP-ответе; настройки приватности показывают по ней
 * предупреждение заранее — до того, как пользователь нажмёт «Найти рядом».
 * Сессия-уровень: обновляется при новой проверке, в localStorage не пишется.
 */
let networkFarFromHome = false;

export function isNetworkFarFromHome(): boolean {
  return networkFarFromHome;
}

/** Для тестов: сбросить сессионный флаг. */
export function resetNetworkFarFromHome(): void {
  networkFarFromHome = false;
}

/** Для тестов: пометить сеть «не отсюда» без сетевого вызова. */
export function markNetworkFarFromHome(): void {
  networkFarFromHome = true;
}

/**
 * Перебирает провайдеров по цепочке; бросает последнюю ошибку, если ни один
 * не ответил. С якорем: ответ правдоподобного радиуса — успех, дальний —
 * отбрасывается и цепочка продолжается (у обоих провайдеров один внешний IP,
 * так что на практике это приведёт к честной ошибке, а не к перелёту не туда).
 */
export async function lookupIpPosition(options: LookupIpOptions = {}): Promise<IpLookupResult> {
  const { anchor, maxDistanceKm = IP_FAR_THRESHOLD_KM } = options;
  let lastError: unknown = new Error("ip-lookup: no providers configured");
  let farError: IpPositionUnplausibleError | null = null;
  for (const provider of PROVIDERS) {
    try {
      const result = await tryProvider(provider);
      const distance = anchor ? haversineKm(anchor.lat, anchor.lon, result.lat, result.lon) : 0;
      if (anchor && distance > maxDistanceKm) {
        // Дальняя точка: помечаем сеть «не отсюда» (важно для подсказки в
        // приватности — см. isNetworkFarFromHome), запоминаем причину и
        // пробуем следующего провайдера.
        networkFarFromHome = true;
        farError = new IpPositionUnplausibleError(distance, maxDistanceKm);
        lastError = farError;
        continue;
      }
      return result;
    } catch (err) {
      lastError = err;
    }
  }
  throw farError ?? lastError;
}
