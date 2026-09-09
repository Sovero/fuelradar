"use client";

/** CRUD зон мониторинга (R21/R23) — GET/POST/PUT/DELETE /monitoring-zones (T05). */

import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/hooks/useAuth";
import type { ZoneOut } from "@/lib/types";

export type ZoneBody = Pick<ZoneOut, "name" | "zone_type" | "params">;

export function useMonitoringZones() {
  const { user } = useAuth();
  const [zones, setZones] = useState<ZoneOut[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!user) {
      setZones([]);
      return;
    }
    setLoading(true);
    apiGet<ZoneOut[]>("/monitoring-zones")
      .then(setZones)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить зоны"))
      .finally(() => setLoading(false));
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const create = useCallback(async (body: ZoneBody) => {
    const zone = await apiPost<ZoneOut>("/monitoring-zones", body);
    setZones((prev) => [...prev, zone]);
    return zone;
  }, []);

  const update = useCallback(async (id: number, body: ZoneBody) => {
    const zone = await apiPut<ZoneOut>(`/monitoring-zones/${id}`, body);
    setZones((prev) => prev.map((z) => (z.id === id ? zone : z)));
    return zone;
  }, []);

  const remove = useCallback(async (id: number) => {
    await apiDelete(`/monitoring-zones/${id}`);
    setZones((prev) => prev.filter((z) => z.id !== id));
  }, []);

  return { zones, loading, error, refetch: load, create, update, remove };
}
