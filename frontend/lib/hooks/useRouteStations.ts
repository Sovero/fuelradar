"use client";

import { useEffect, useRef, useState } from "react";

import { ApiError, apiPost } from "@/lib/api";
import type { MapPoint } from "@/lib/map/types";
import type { RouteStation, StationListQuery } from "@/lib/types";

interface RouteStationsQuery
  extends Pick<
    StationListQuery,
    "city" | "brand" | "fuel" | "status" | "confidence_min" | "queue_max" | "limit" | "offset" | "preferred_brands"
  > {
  polyline: MapPoint[];
  corridor_km: number;
}

interface UseRouteStationsResult {
  stations: RouteStation[];
  loading: boolean;
  error: string | null;
}

export function useRouteStations(enabled: boolean, query: RouteStationsQuery): UseRouteStationsResult {
  const [stations, setStations] = useState<RouteStation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const serialized = JSON.stringify(query);

  useEffect(() => {
    if (!enabled || query.polyline.length < 2) {
      requestId.current += 1;
      setStations([]);
      setLoading(false);
      setError(null);
      return;
    }

    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    apiPost<RouteStation[]>("/route/stations", query)
      .then((data) => {
        if (requestId.current === id) setStations(data);
      })
      .catch((err: unknown) => {
        if (requestId.current !== id) return;
        setStations([]);
        setError(err instanceof ApiError ? err.message : "Не удалось загрузить станции в коридоре");
      })
      .finally(() => {
        if (requestId.current === id) setLoading(false);
      });
    // serialized intentionally captures the complete request body.
  }, [enabled, serialized]); // eslint-disable-line react-hooks/exhaustive-deps

  return { stations, loading, error };
}
