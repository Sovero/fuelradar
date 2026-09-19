"use client";

import { useCallback, useState } from "react";

import { lookupIpPosition } from "@/lib/geoIp";

export interface GeoPosition {
  lat: number;
  lon: number;
}

export type GeoSource = "gps" | "ip";

interface GeolocationState {
  position: GeoPosition | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  /** Откуда пришла точка: «gps» — браузерная геолокация, «ip» — резервный lookup по IP. */
  source: GeoSource | null;
  request: () => void;
}

/**
 * Геолокация браузера — запрашивается только по явному действию пользователя
 * (§16.1 №10). На машинах без GPS-приёмника браузерный провайдер часто
 * недоступен (POSITION_UNAVAILABLE — сетевой location-сервис не отвечает,
 * подтверждено пробником desktop/scripts/geo-probe.cjs), поэтому после отказа
 * устройства делается один резервный запрос по IP (тоже только по клику,
 * R24): город точнее района обычно не даёт, зато «Найти рядом» уезжает
 * в правильный город, а точную точку пользователь задаёт вручную.
 */
export function useGeolocation(): GeolocationState {
  const [position, setPosition] = useState<GeoPosition | null>(null);
  const [status, setStatus] = useState<GeolocationState["status"]>("idle");
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<GeoSource | null>(null);

  const request = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("Геолокация недоступна в этом браузере — выберите точку вручную");
      setStatus("error");
      return;
    }
    setStatus("loading");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPosition({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setStatus("ready");
        setSource("gps");
        setError(null);
      },
      (err) => {
        // PositionError exposes the numeric code on the error instance; the
        // PERMISSION_DENIED constant is not an instance property in browsers.
        if (err.code === 1) {
          setError("Доступ к геолокации запрещён — выберите точку вручную");
          setStatus("error");
          return;
        }
        // POSITION_UNAVAILABLE / TIMEOUT: у машины нет источника координат —
        // пробуем город по IP прежде чем признавать поражение.
        lookupIpPosition()
          .then((result) => {
            setPosition({ lat: result.lat, lon: result.lon });
            setSource("ip");
            setStatus("ready");
            setError(null);
          })
          .catch(() => {
            setError("Не удалось определить местоположение — выберите точку вручную");
            setStatus("error");
          });
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }, []);

  return { position, status, error, source, request };
}
