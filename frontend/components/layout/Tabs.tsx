"use client";

import type { TabKey } from "@/lib/filters";
import { useFilters } from "@/lib/hooks/useFilters";
import { useI18n } from "@/lib/hooks/useI18n";
import type { TranslationKey } from "@/lib/i18n";

const TABS: { key: TabKey; labelKey: TranslationKey }[] = [
  { key: "map", labelKey: "tabs.map" },
  { key: "list", labelKey: "tabs.list" },
  { key: "favorites", labelKey: "tabs.favorites" },
];

/** Табы Карта/Список/Избранное (R73) — состояние фильтров общее, не сбрасывается (R32.1). */
export function Tabs() {
  const { filters, setFilters } = useFilters();
  const { t } = useI18n();

  return (
    <div role="tablist" aria-label="Разделы" data-tour="tabs" className="flex border-b border-gray-200 bg-white px-4 dark:border-gray-800 dark:bg-gray-900">
      {TABS.map((tab) => (
        <button
          key={tab.key}
          role="tab"
          aria-selected={filters.tab === tab.key}
          onClick={() => setFilters({ tab: tab.key })}
          className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
            filters.tab === tab.key
              ? "border-emerald-600 text-emerald-700 dark:text-emerald-400"
              : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          }`}
        >
          {t(tab.labelKey)}
        </button>
      ))}
    </div>
  );
}
