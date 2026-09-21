"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, ApiError } from "@/lib/api";
import type { StationBrief } from "@/lib/types";

export function useFavorites() {
  const [favorites, setFavorites] = useState<StationBrief[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    apiGet<StationBrief[]>("/favorites")
      .then((data) => setFavorites(data))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить избранное"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { favorites, loading, error, refetch: load };
}
