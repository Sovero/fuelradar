"use client";

/** Список станций с сортировками (R31): расстояние/достоверность/наличие/очередь/время/Score. */

import { useFilters } from "@/lib/hooks/useFilters";
import { useI18n } from "@/lib/hooks/useI18n";
import { StationListItem } from "@/components/station/StationListItem";
import type { StationBrief } from "@/lib/types";
import type { SortKey } from "@/lib/filters";
import type { TranslationKey } from "@/lib/i18n";

const SORT_OPTIONS: { key: SortKey; labelKey: TranslationKey }[] = [
  { key: "distance", labelKey: "sort.distance" },
  { key: "confidence", labelKey: "sort.confidence" },
  { key: "availability", labelKey: "sort.availability" },
  { key: "queue", labelKey: "sort.queue" },
  { key: "travel_time", labelKey: "sort.travel_time" },
  { key: "score", labelKey: "sort.score" },
];

export function StationList({ stations, onSelect }: { stations: StationBrief[]; onSelect: (id: string) => void }) {
  const { filters, setFilters } = useFilters();
  const { t } = useI18n();

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2 dark:border-gray-800">
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {stations.length} {t("list.count")}
        </span>
        <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
          {t("list.sort")}
          <select
            value={filters.sort ?? ""}
            onChange={(e) => setFilters({ sort: (e.target.value || null) as SortKey | null })}
            className="rounded-md border border-gray-300 px-2 py-1 dark:border-gray-700 dark:bg-gray-800"
          >
            <option value="">{t("list.sort.default")}</option>
            {SORT_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {t(o.labelKey)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex-1 overflow-y-auto">
        {stations.map((s) => (
          <StationListItem key={s.id} station={s} selectedFuelCodes={filters.fuels} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}
