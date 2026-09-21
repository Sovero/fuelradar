"use client";

/**
 * CRUD правил уведомлений (R26/R34/R77) — GET/POST/PUT/DELETE /alerts (T05/T07).
 * Общий хук для «избранное» (scope {"type":"favorites"}), конкретной станции
 * (scope {"station_id": id}), зоны (scope {"type":"zone","zone_id": id}) и
 * радиуса вокруг точки (scope {"lat","lon"} + distance_km) — соглашение о
 * scope см. `backend/app/alerts/service.py`.
 */

import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut, ApiError } from "@/lib/api";
import type { AlertRuleBody, AlertRuleOut } from "@/lib/types";

export function useAlertRules() {
  const [rules, setRules] = useState<AlertRuleOut[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    apiGet<AlertRuleOut[]>("/alerts")
      .then(setRules)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить правила"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const create = useCallback(async (body: AlertRuleBody) => {
    const rule = await apiPost<AlertRuleOut>("/alerts", body);
    setRules((prev) => [...prev, rule]);
    return rule;
  }, []);

  const update = useCallback(async (id: number, body: AlertRuleBody) => {
    const rule = await apiPut<AlertRuleOut>(`/alerts/${id}`, body);
    setRules((prev) => prev.map((r) => (r.id === id ? rule : r)));
    return rule;
  }, []);

  const remove = useCallback(async (id: number) => {
    await apiDelete(`/alerts/${id}`);
    setRules((prev) => prev.filter((r) => r.id !== id));
  }, []);

  return { rules, loading, error, refetch: load, create, update, remove };
}
