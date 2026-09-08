"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/hooks/useAuth";
import type { StationBrief } from "@/lib/types";

export function useFavorites() {
  const { user } = useAuth();
  const [favorites, setFavorites] = useState<StationBrief[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!user) {
      setFavorites([]);
      return;
    }
    setLoading(true);
    apiGet<StationBrief[]>("/favorites")
      .then((data) => setFavorites(data))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить избранное"))
      .finally(() => setLoading(false));
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  return { favorites, loading, error, refetch: load };
}
