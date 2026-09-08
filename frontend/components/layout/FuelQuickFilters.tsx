"use client";

import { useMeta } from "@/lib/hooks/useMeta";
import { useFilters } from "@/lib/hooks/useFilters";
import { selectableFuelTypes } from "@/lib/fuel";
import { useI18n } from "@/lib/hooks/useI18n";

/** Быстрые фильтры топлива [92][95][100][ДТ] (R73) — виды берутся из /meta, не хардкодятся.
 * Единственный источник выбора топлива для фильтров — панель «Фильтры» (R32) на него ссылается,
 * а не дублирует список (см. FiltersPanel). */
export function FuelQuickFilters() {
  const { meta, fuelLabel } = useMeta();
  const { filters, setFilters } = useFilters();
  const { t } = useI18n();
  const fuels = selectableFuelTypes(meta?.fuel_types ?? []);

  function toggle(code: string) {
    const active = filters.fuels.includes(code);
    setFilters({ fuels: active ? filters.fuels.filter((f) => f !== code) : [...filters.fuels, code] });
  }

  if (!fuels.length) return null;

  return (
    <div className="px-4 pb-2" data-tour="fuel">
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">{t("fuel.heading")}</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t("fuel.groupLabel")}>
        {fuels.map((fuel) => {
          const active = filters.fuels.includes(fuel.code);
          return (
            <button
              key={fuel.code}
              type="button"
              onClick={() => toggle(fuel.code)}
              aria-pressed={active}
              className={`rounded-full border px-3 py-1 text-sm font-medium transition ${
                active
                  ? "border-emerald-600 bg-emerald-600 text-white"
                  : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
              }`}
            >
              {fuelLabel(fuel.code)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
