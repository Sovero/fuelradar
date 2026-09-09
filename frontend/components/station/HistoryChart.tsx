"use client";

import { useMeta } from "@/lib/hooks/useMeta";
import { useQueueHistory, useStationHistory } from "@/lib/hooks/useStationDetail";
import { statusVisual } from "@/lib/map/statusColor";
import { Sparkline, type SparklinePoint } from "@/components/station/Sparkline";
import { formatUpdatedAt } from "@/lib/format";

// Порядок и цвет по возрастанию очереди — своей палитры для очереди в проекте
// ещё не было, шкала качественная (0..4), NONE зелёный -> VERY_HIGH красный.
const QUEUE_LEVEL_ORDER: Record<string, number> = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, VERY_HIGH: 4 };
const QUEUE_LEVEL_COLOR: Record<string, string> = {
  NONE: "#22c55e",
  LOW: "#84cc16",
  MEDIUM: "#eab308",
  HIGH: "#f97316",
  VERY_HIGH: "#ef4444",
};

/** Графики истории: топливо+достоверность, очередь по времени (R46) — из /stations/{id}/(queue-)history. */
export function HistoryChart({ stationId, fuelCode }: { stationId: string; fuelCode: string | null }) {
  const { history, loading, error } = useStationHistory(stationId, fuelCode);
  const queueHistoryState = useQueueHistory(stationId);
  const { statusLabel, queueLabel } = useMeta();

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

  const queueSorted = [...queueHistoryState.history]
    .filter((q) => q.level in QUEUE_LEVEL_ORDER)
    .sort((a, b) => new Date(a.observed_at).getTime() - new Date(b.observed_at).getTime());
  const queuePoints: SparklinePoint[] = queueSorted.map((q) => ({
    x: new Date(q.observed_at).getTime(),
    y: QUEUE_LEVEL_ORDER[q.level],
    color: QUEUE_LEVEL_COLOR[q.level],
    label: `${queueLabel(q.level)}${q.vehicles !== null ? ` · ${q.vehicles}` : ""} — ${q.source}, ${formatUpdatedAt(q.observed_at)}`,
  }));

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Sparkline points={points} />
        <p className="mt-1 text-xs text-gray-400">Достоверность наблюдений во времени, {sorted.length} точек</p>
      </div>
      {queuePoints.length >= 2 ? (
        <div>
          <Sparkline points={queuePoints} />
          <p className="mt-1 text-xs text-gray-400">Очередь во времени, {queuePoints.length} точек</p>
        </div>
      ) : (
        <p className="text-xs text-gray-400">По очереди наблюдений пока мало.</p>
      )}
    </div>
  );
}
