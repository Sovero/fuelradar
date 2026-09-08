"use client";

import { useMeta } from "@/lib/hooks/useMeta";
import { useStationHistory } from "@/lib/hooks/useStationDetail";
import { statusVisual } from "@/lib/map/statusColor";
import { Sparkline, type SparklinePoint } from "@/components/station/Sparkline";
import { formatUpdatedAt } from "@/lib/format";

/** Графики истории: топливо, достоверность по времени (R46) — из /stations/{id}/history. */
export function HistoryChart({ stationId, fuelCode }: { stationId: string; fuelCode: string | null }) {
  const { history, loading, error } = useStationHistory(stationId, fuelCode);
  const { statusLabel } = useMeta();

  if (loading) return <p className="text-sm text-gray-400">Загрузка истории…</p>;
  if (error) return <p className="text-sm text-red-600">{error}</p>;

  if (history.length < 2) {
    return (
      <p className="text-sm text-gray-500">
        {history.length === 1 ? "Данных пока мало — только одно наблюдение." : "Наблюдений пока нет."}
      </p>
    );
  }

  const sorted = [...history].sort((a, b) => new Date(a.observed_at).getTime() - new Date(b.observed_at).getTime());
  const points: SparklinePoint[] = sorted.map((h) => ({
    x: new Date(h.observed_at).getTime(),
    y: h.confidence_raw,
    color: statusVisual(h.status).hex,
    label: `${statusLabel(h.status)} · ${Math.round(h.confidence_raw)} — ${h.source}, ${formatUpdatedAt(h.observed_at)}`,
  }));

  return (
    <div>
      <Sparkline points={points} />
      <p className="mt-1 text-xs text-gray-400">Достоверность наблюдений во времени, {sorted.length} точек</p>
    </div>
  );
}
