"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, ApiError } from "@/lib/api";
import type { StationBrief, StationListQuery } from "@/lib/types";

const CACHE_KEY = "fr_last_stations";

function readCache(): StationBrief[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as StationBrief[]) : null;
  } catch {
    return null;
  }
}

function writeCache(data: StationBrief[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch {
    // хранилище недоступно/переполнено — не критично, просто не кэшируем
  }
}

interface UseStationsResult {
  stations: StationBrief[];
  loading: boolean;
  error: string | null;
  /** данные показаны из офлайн-кэша, а не со свежего ответа сервера (R05.1) */
  isStale: boolean;
  refetch: () => void;
}

export function useStations(query: StationListQuery): UseStationsResult {
  // Стартуем с пустого списка (детерминированно и на сервере, и при первом клиентском
  // рендере) — иначе useState-инициализатор с localStorage расходится между SSR и CSR
  // и React ругается на hydration mismatch. Офлайн-кэш подставляем ПОСЛЕ монтирования.
  const [stations, setStations] = useState<StationBrief[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isStale, setIsStale] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    const cached = readCache();
    if (cached) {
      setStations(cached);
      setIsStale(true);
    }
  }, []);

  const fetchStations = useCallback(() => {
    const id = ++requestId.current;
    setLoading(true);
    apiGet<StationBrief[]>("/stations", query as Record<string, string | number | boolean | undefined | null>)
      .then((data) => {
        if (requestId.current !== id) return;
        setStations(data);
        setIsStale(false);
        setError(null);
        writeCache(data);
      })
      .catch((err: unknown) => {
        if (requestId.current !== id) return;
        const cached = readCache();
        if (cached) {
          setStations(cached);
          setIsStale(true);
        }
        setError(err instanceof ApiError ? err.message : "Не удалось загрузить станции — проверьте соединение");
      })
      .finally(() => {
        if (requestId.current === id) setLoading(false);
      });
  }, [JSON.stringify(query)]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchStations();
  }, [fetchStations]);

  return { stations, loading, error, isStale, refetch: fetchStations };
}
