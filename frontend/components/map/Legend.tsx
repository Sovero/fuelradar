"use client";

import { useMeta } from "@/lib/hooks/useMeta";
import { useI18n } from "@/lib/hooks/useI18n";
import { statusVisual } from "@/lib/map/statusColor";
import { HEAT_COLORS } from "@/lib/heatmap";
import type { FuelStatusCode } from "@/lib/types";

const LEGEND_ORDER: FuelStatusCode[] = ["AVAILABLE", "LIKELY_AVAILABLE", "LOW_STOCK", "UNAVAILABLE", "UNKNOWN"];

/** Легенда цветов карты (R27.1): ⚪ явно объясняется как «нет данных», не «нет топлива». */
export function Legend({ showHeat = false }: { showHeat?: boolean }) {
  const { statusLabel } = useMeta();
  const { t } = useI18n();
  return (
    <div
      className="pointer-events-none absolute bottom-2 left-2 z-10 rounded-md bg-white/90 p-2 text-xs shadow dark:bg-gray-900/90"
      aria-label="Легенда карты"
    >
      {LEGEND_ORDER.map((code) => (
        <div key={code} className="flex items-center gap-1.5">
          <span>{statusVisual(code).emoji}</span>
          <span className="text-gray-700 dark:text-gray-300">{statusLabel(code)}</span>
        </div>
      ))}
      <div className="mt-1 flex items-center gap-1.5 border-t border-gray-200 pt-1 dark:border-gray-700">
        <span aria-hidden className="inline-block h-3 w-3 rounded-full border-2 border-blue-600" />
        <span className="text-gray-500 dark:text-gray-400">{t("legend.brandRing")}</span>
      </div>
      {showHeat && (
        <div className="mt-1 border-t border-gray-200 pt-1 dark:border-gray-700">
          <p className="font-semibold text-gray-600 dark:text-gray-300">{t("heat.legend.title")}</p>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: HEAT_COLORS.high }} />
            <span className="text-gray-700 dark:text-gray-300">{t("heat.legend.high")}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: HEAT_COLORS.medium }} />
            <span className="text-gray-700 dark:text-gray-300">{t("heat.legend.medium")}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: HEAT_COLORS.low }} />
            <span className="text-gray-700 dark:text-gray-300">{t("heat.legend.low")}</span>
          </div>
          <p className="mt-0.5 max-w-[220px] text-[10px] text-gray-500 dark:text-gray-400">{t("heat.legend.note")}</p>
        </div>
      )}
    </div>
  );
}
