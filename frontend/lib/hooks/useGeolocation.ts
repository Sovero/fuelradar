"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { lookupIpPosition, IpPositionUnplausibleError, type HomeAnchor, type IpLookupResult } from "@/lib/geoIp";
import { DEFAULT_MAP_CENTER } from "@/lib/map/config";
import type { TranslationKey } from "@/lib/i18n";

export interface GeoPosition {
  lat: number;
  lon: number;
}

export type GeoSource = "gps" | "ip";

/** IP-точка, ожидающая подтверждения пользователя: «Вы в X? Показать станции X». */
export interface IpCandidate {
  position: GeoPosition;
  /** Город от провайдера (может быть пустым). */
  place: string;
}

interface GeolocationState {
  position: GeoPosition | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  /** Откуда пришла точка: «gps» — браузерная геолокация, «ip» — резервный lookup по IP. */
  source: GeoSource | null;
  request: () => void;
  /**
   * Город по IP определён, но ещё НЕ применён к карте: нужно подтверждение
   * («Вы в X?»). Пока кандидат не принят, позиция остаётся прежней.
   */
  ipCandidate: IpCandidate | null;
  /** Подтвердить город: точка кандидата становится текущей позицией. */
  confirmIpCandidate: () => void;
  /** Отклонить предложение: кандидат сбрасывается без изменения карты. */
  dismissIpCandidate: () => void;
}

/** Сколько ждём ответа устройства (success ИЛИ error) до самостоятельного решения. */
const GPS_WATCHDOG_MS = 12_000;

/**
 * Геолокация браузера — запрашивается только по явному действию пользователя
 * (§16.1 №10). Практика показала три способа, которыми браузерный провайдер
 * «залипает» на десктопе без GPS-приёмника:
 *
 * 1. POSITION_UNAVAILABLE — сетевой location-сервис (Google NLS) недоступен
 *    (403, корпоративные сети). Спецификацию соблюдают все браузеры.
 * 2. Молчание: ни success-, ни error-коллбек не приходит вообще (проявляется
 *    в некоторых embedded/десктоп-оболочках Chromium при подавленном промпте
 *    разрешения). Таймаут `timeout` в опциях в этом случае НЕ срабатывает.
 * 3. Разрешение уже `denied`, но error-коллбек всё равно не приходит.
 *
 * Поэтому: (а) запрос дублируется собственным сторожем — если за 12 с не
 * пришло НИЧЕГО, сами переходим к резерву; (б) при известном `denied`
 * (permissions API) резерв по IP не делаем — он всё равно правды не даст —
 * а сразу показываем честную ошибку.
 *
 * Успешный сторож снимается, когда устройство ответило.
 *
 * IP-резерв (тоже только по явному клику, R24) НЕ применяется к карте сразу:
 * город предлагается кандидатом — пользователь видит «Вы в X? Показать
 * станции X» и подтверждает или отклоняет. Правдоподобие проверяется заранее
 * относительно центра региона по умолчанию: VPN/прокси может отдать точку в
 * другой стране — такой кандидат даже не показывается (R97i).
 */
export function useGeolocation(t: (key: TranslationKey) => string): GeolocationState {
  const [position, setPosition] = useState<GeoPosition | null>(null);
  const [status, setStatus] = useState<GeolocationState["status"]>("idle");
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<GeoSource | null>(null);
  const [ipCandidate, setIpCandidate] = useState<IpCandidate | null>(null);

  const settledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const request = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError(t("findNearby.unavailable"));
      setStatus("error");
      return;
    }

    settledRef.current = false;
    setStatus("loading");

    const finishError = (message: string) => {
      if (settledRef.current) return;
      settledRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      setError(message);
      setStatus("error");
    };

    const finishPosition = (pos: GeoPosition, src: GeoSource) => {
      if (settledRef.current) return;
      settledRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      setPosition(pos);
      setSource(src);
      setStatus("ready");
      setError(null);
    };

    // Резервный путь: город по IP предлагается кандидатом на подтверждение —
    // карта не двигается, пока пользователь не скажет «да, показать станции».
    const runIpFallback = () => {
      const anchor: HomeAnchor = { lat: DEFAULT_MAP_CENTER[1], lon: DEFAULT_MAP_CENTER[0] };
      lookupIpPosition({ anchor })
        .then((result: IpLookupResult) => {
          if (settledRef.current) return;
          settledRef.current = true;
          if (timerRef.current) clearTimeout(timerRef.current);
          setIpCandidate({ position: { lat: result.lat, lon: result.lon }, place: result.place });
          setStatus("ready");
          setError(null);
        })
        .catch((err: unknown) => {
          finishError(err instanceof IpPositionUnplausibleError ? t("findNearby.ipFar") : t("findNearby.error"));
        });
    };

    const handleDeviceError = (code: number) => {
      // PositionError exposes the numeric code on the error instance; the
      // PERMISSION_DENIED constant is not an instance property in browsers.
      if (code === 1) {
        // Доступ запрещён пользователем/политикой: IP-резерв не меняет ответ,
        // честно сообщаем и предлагаем ручную точку.
        finishError(t("findNearby.denied"));
        return;
      }
      // POSITION_UNAVAILABLE / TIMEOUT: у машины нет источника координат —
      // пробуем город по IP прежде чем признавать поражение.
      runIpFallback();
    };

    navigator.geolocation.getCurrentPosition(
      (pos) => finishPosition({ lat: pos.coords.latitude, lon: pos.coords.longitude }, "gps"),
      (err) => handleDeviceError(err.code),
      { enableHighAccuracy: true, timeout: 10_000 },
    );

    // Сторож: браузер обязан ответить (даже ошибкой), но не всегда делает это
    // (см. пп. 2–3 в докстринге). Ждём чуть дольше опционального timeout,
    // затем решаем сами. При известном `denied` не тратим 12 секунд зря.
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (settledRef.current) return;
      if (typeof navigator.permissions?.query === "function") {
        navigator.permissions
          .query({ name: "geolocation" })
          .then((snapshot) => {
            if (settledRef.current) return;
            if (snapshot.state === "denied") finishError(t("findNearby.denied"));
            else runIpFallback();
          })
          .catch(() => {
            if (!settledRef.current) runIpFallback();
          });
      } else {
        runIpFallback();
      }
    }, GPS_WATCHDOG_MS);
  }, [t]);

  const confirmIpCandidate = useCallback(() => {
    setIpCandidate((candidate) => {
      if (candidate) {
        setPosition(candidate.position);
        setSource("ip");
      }
      return null;
    });
  }, []);

  const dismissIpCandidate = useCallback(() => {
    setIpCandidate(null);
  }, []);

  return { position, status, error, source, request, ipCandidate, confirmIpCandidate, dismissIpCandidate };
}
