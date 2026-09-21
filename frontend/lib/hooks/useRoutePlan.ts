"use client";

import { useEffect, useRef, useState } from "react";

import { ApiError, apiPost } from "@/lib/api";
import type { MapPoint } from "@/lib/map/types";
import type { RoutePlan } from "@/lib/types";

interface UseRoutePlanResult {
  /** Последний успешно полученный ответ роутера (в том числе честный отказ). */
  plan: RoutePlan | null;
  loading: boolean;
  error: string | null;
}

const DEBOUNCE_MS = 350;

/**
 * Дорожный маршрут по точкам в порядке движения (R22.1).
 *
 * Запрос уходит только когда точек ≥ 2, с дебаунсом: клики по карте приходят
 * пачками, а роутер не должен получать запрос на каждый промежуточный клик.
 * Ответ с `is_road_route: false` — не ошибка: это честное «роутер недоступен»,
 * и вызывающий код рисует прямую линию (R97i).
 */
export function useRoutePlan(enabled: boolean, points: MapPoint[]): UseRoutePlanResult {
  const [plan, setPlan] = useState<RoutePlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const serialized = JSON.stringify(points);

  useEffect(() => {
    const current = JSON.parse(serialized) as MapPoint[];
    if (!enabled || current.length < 2) {
      requestId.current += 1;
      setPlan(null);
      setLoading(false);
      setError(null);
      return;
    }

    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    const timer = setTimeout(() => {
      apiPost<RoutePlan>("/route/plan", { polyline: current })
        .then((data) => {
          if (requestId.current === id) setPlan(data);
        })
        .catch((err: unknown) => {
          if (requestId.current !== id) return;
          // Сеть/API упали: прежний план не трогаем, но и не молчим.
          setError(err instanceof ApiError ? err.message : "Не удалось построить маршрут по дорогам");
        })
        .finally(() => {
          if (requestId.current === id) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [enabled, serialized]);

  return { plan, loading, error };
}
