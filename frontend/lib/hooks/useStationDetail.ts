"use client";

import { useEffect, useState } from "react";
import { apiGet, ApiError } from "@/lib/api";
import type { HistoryItem, StationDetail } from "@/lib/types";

export function useStationDetail(stationId: string | null, lat: number | null, lon: number | null) {
  const [station, setStation] = useState<StationDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!stationId) {
      setStation(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiGet<StationDetail>(`/stations/${encodeURIComponent(stationId)}`, { lat: lat ?? undefined, lon: lon ?? undefined })
      .then((data) => {
        if (!cancelled) setStation(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Не удалось загрузить станцию");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [stationId, lat, lon]);

  return { station, loading, error };
}

export function useStationHistory(stationId: string | null, fuelCode: string | null) {
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!stationId) {
      setHistory([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiGet<HistoryItem[]>(`/stations/${encodeURIComponent(stationId)}/history`, { fuel: fuelCode ?? undefined })
      .then((data) => {
        if (!cancelled) setHistory(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Не удалось загрузить историю");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [stationId, fuelCode]);

  return { history, loading, error };
}
