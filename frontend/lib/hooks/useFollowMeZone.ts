"use client";

/**
 * «Следить вокруг меня» (R23): динамическая CIRCLE-зона вокруг текущей
 * позиции, которая перестраивается при значимом переезде (R23.1), а не при
 * каждом дрожании GPS — порог см. `lib/geo.ts::shouldRebuildFollowMeZone`.
 * Использует уже существующий CRUD зон (`useMonitoringZones`) — «следить
 * вокруг меня» это обычная CIRCLE-зона, помеченная именем, плюс фоновое
 * наблюдение позиции (`watchPosition`), которое обновляет её координаты.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { shouldRebuildFollowMeZone } from "@/lib/geo";
import type { ZoneBody } from "@/lib/hooks/useMonitoringZones";
import type { ZoneOut } from "@/lib/types";

const ENABLED_KEY = "fr_follow_me_enabled";
const RADIUS_KEY = "fr_follow_me_radius_km";
const ZONE_ID_KEY = "fr_follow_me_zone_id";

export const FOLLOW_ME_ZONE_NAME = "Вокруг меня";

interface UseFollowMeZoneArgs {
  zones: ZoneOut[];
  create: (body: ZoneBody) => Promise<ZoneOut>;
  update: (id: number, body: ZoneBody) => Promise<ZoneOut>;
}

export function useFollowMeZone({ zones, create, update }: UseFollowMeZoneArgs) {
  const [enabled, setEnabledState] = useState(false);
  const [radiusKm, setRadiusKmState] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const zoneIdRef = useRef<number | null>(null);

  useEffect(() => {
    try {
      setEnabledState(window.localStorage.getItem(ENABLED_KEY) === "1");
      const storedRadius = Number(window.localStorage.getItem(RADIUS_KEY));
      if (Number.isFinite(storedRadius) && storedRadius > 0) setRadiusKmState(storedRadius);
      const storedZoneId = Number(window.localStorage.getItem(ZONE_ID_KEY));
      if (Number.isFinite(storedZoneId) && storedZoneId > 0) zoneIdRef.current = storedZoneId;
    } catch {
      // localStorage недоступен — начинаем с выключенного состояния
    }
  }, []);

  const zone = zoneIdRef.current !== null ? zones.find((z) => z.id === zoneIdRef.current) ?? null : null;

  const handlePosition = useCallback(
    async (lat: number, lon: number) => {
      try {
        if (!zone) {
          const created = await create({ name: FOLLOW_ME_ZONE_NAME, zone_type: "CIRCLE", params: { lat, lon, radius_km: radiusKm } });
          zoneIdRef.current = created.id;
          try {
            window.localStorage.setItem(ZONE_ID_KEY, String(created.id));
          } catch {
            // не критично
          }
          return;
        }
        const zoneLat = Number(zone.params.lat);
        const zoneLon = Number(zone.params.lon);
        if (shouldRebuildFollowMeZone(lat, lon, zoneLat, zoneLon)) {
          await update(zone.id, { name: zone.name, zone_type: "CIRCLE", params: { lat, lon, radius_km: radiusKm } });
        }
      } catch {
        setError("Не удалось обновить зону «Вокруг меня»");
      }
    },
    [zone, radiusKm, create, update],
  );

  const stopWatch = useCallback(() => {
    if (watchIdRef.current !== null && typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current);
    }
    watchIdRef.current = null;
  }, []);

  const enable = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("Геолокация недоступна в этом браузере");
      return;
    }
    setError(null);
    setEnabledState(true);
    try {
      window.localStorage.setItem(ENABLED_KEY, "1");
    } catch {
      // не критично
    }
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => handlePosition(pos.coords.latitude, pos.coords.longitude),
      () => setError("Не удалось определить местоположение — «следить вокруг меня» приостановлено"),
      { enableHighAccuracy: true, maximumAge: 60_000, timeout: 20_000 },
    );
  }, [handlePosition]);

  const disable = useCallback(() => {
    stopWatch();
    setEnabledState(false);
    try {
      window.localStorage.setItem(ENABLED_KEY, "0");
    } catch {
      // не критично
    }
  }, [stopWatch]);

  const setRadiusKm = useCallback((km: number) => {
    setRadiusKmState(km);
    try {
      window.localStorage.setItem(RADIUS_KEY, String(km));
    } catch {
      // не критично
    }
  }, []);

  useEffect(() => stopWatch, [stopWatch]);

  return { enabled, radiusKm, setRadiusKm, enable, disable, zone, error };
}
