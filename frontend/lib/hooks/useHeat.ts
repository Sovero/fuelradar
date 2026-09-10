"use client";

/** R50: тепловая карта включается отдельно (isHeatmapOn) и грузится только тогда. */

import { useCallback, useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import type { HeatResponse } from "@/lib/types";

export function useHeat(enabled: boolean, fuels?: string[]) {
  const [data, setData] = useState<HeatResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<"unavailable" | "error" | null>(null);

  const key = fuels?.length ? fuels.join(",") : "";

  const reload = useCallback(() => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    apiGet<HeatResponse>("/heat/cells", key ? { fuels: key } : undefined)
      .then((response) => {
        setData(response);
        setError(null);
      })
      .catch((err: unknown) => {
        setData(null);
        setError(err instanceof Error && "status" in err && (err as { status?: number }).status === 503 ? "unavailable" : "error");
      })
      .finally(() => setLoading(false));
  }, [enabled, key]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, loading, error, reload };
}
