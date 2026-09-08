"use client";

/** Карточка списка по макету §107 (R74): «ЛУКОЙЛ, ул.…, AI-95 ● Есть, 91%, 3.8 км · 9 мин, очередь: небольшая, обновлено 12 мин назад». */

import { useMeta } from "@/lib/hooks/useMeta";
import { statusVisual } from "@/lib/map/statusColor";
import { formatConfidence, formatDistance, formatEtaMinutes, formatUpdatedAt } from "@/lib/format";
import type { StationBrief } from "@/lib/types";

export function StationListItem({
  station,
  selectedFuelCodes,
  onSelect,
}: {
  station: StationBrief;
  selectedFuelCodes: string[];
  onSelect: (id: string) => void;
}) {
  const { fuelLabel, statusLabel, queueLabel } = useMeta();

  const relevant = selectedFuelCodes.length ? station.statuses.filter((s) => selectedFuelCodes.includes(s.fuel_code)) : station.statuses;
  const best = relevant.slice().sort((a, b) => b.confidence - a.confidence)[0] ?? null;
  const visual = statusVisual(best?.status);

  return (
    <button
      type="button"
      onClick={() => onSelect(station.id)}
      className="flex w-full flex-col gap-1 border-b border-gray-100 px-4 py-3 text-left hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/60"
    >
      <div className="flex items-center justify-between">
        <span className="font-semibold text-gray-900 dark:text-gray-100">
          {station.brand || "Без сети"}
          {station.score !== null && <span className="ml-2 text-xs font-normal text-gray-400">score {Math.round(station.score)}</span>}
        </span>
        <span aria-hidden>{visual.emoji}</span>
      </div>
      <p className="truncate text-sm text-gray-600 dark:text-gray-400">{station.address || "Адрес неизвестен"}</p>
      <p className="text-sm text-gray-700 dark:text-gray-300">
        {best ? (
          <>
            {fuelLabel(best.fuel_code)} · {statusLabel(best.status)}, {formatConfidence(best.confidence)} подтверждение
          </>
        ) : (
          "Нет данных по выбранному топливу"
        )}
      </p>
      <p className="text-xs text-gray-400 dark:text-gray-500">
        {formatDistance(station.distance_km)} · {formatEtaMinutes(station.eta_minutes)} в пути · очередь:{" "}
        {station.queue ? queueLabel(station.queue.level) : "—"} · обновлено {formatUpdatedAt(best?.updated_at)}
      </p>
    </button>
  );
}
