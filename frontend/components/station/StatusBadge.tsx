"use client";

import { useMeta } from "@/lib/hooks/useMeta";
import { statusVisual } from "@/lib/map/statusColor";
import { formatConfidence, formatUpdatedAt } from "@/lib/format";
import type { FuelStatusBrief } from "@/lib/types";

/** Строка «вид топлива → статус» в карточке/списке (R30: пустых полей нет — есть «нет данных»). */
export function StatusBadge({ status }: { status: FuelStatusBrief }) {
  const { fuelLabel, statusLabel } = useMeta();
  const visual = statusVisual(status.status);
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-gray-100 bg-gray-50 px-3 py-2 dark:border-gray-800 dark:bg-gray-800/60">
      <div className="flex items-center gap-2">
        <span aria-hidden>{visual.emoji}</span>
        <span className="font-medium text-gray-800 dark:text-gray-200">{fuelLabel(status.fuel_code)}</span>
      </div>
      <div className="text-right text-sm text-gray-600 dark:text-gray-400">
        <div>{statusLabel(status.status)} · {formatConfidence(status.confidence)}</div>
        <div className="text-xs text-gray-400 dark:text-gray-500">обновлено {formatUpdatedAt(status.updated_at)}</div>
      </div>
    </div>
  );
}
