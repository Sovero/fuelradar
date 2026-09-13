"use client";

import { useCallback, useState } from "react";

export interface GeoPosition {
  lat: number;
  lon: number;
}

interface GeolocationState {
  position: GeoPosition | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  request: () => void;
}

/** Геолокация браузера — запрашивается только по явному действию пользователя (§16.1 №10). */
export function useGeolocation(): GeolocationState {
  const [position, setPosition] = useState<GeoPosition | null>(null);
  const [status, setStatus] = useState<GeolocationState["status"]>("idle");
  const [error, setError] = useState<string | null>(null);

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
        setError(null);
      },
      (err) => {
        // PositionError exposes the numeric code on the error instance; the
        // PERMISSION_DENIED constant is not an instance property in browsers.
        setError(err.code === 1 ? "Доступ к геолокации запрещён — выберите точку вручную" : "Не удалось определить местоположение");
        setStatus("error");
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }, []);

  return { position, status, error, request };
}
