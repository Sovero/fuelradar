"use client";

/**
 * Режимы наблюдения (R25): все / выбранные сети / избранные / с исключениями.
 * Применяется к карте/списку на главном экране (`HomeScreen.tsx` через
 * `lib/personalization.ts`). См. предупреждение там же про ограничение: это
 * клиентский фильтр, не персистентный скоуп правила уведомлений (нет brand_id
 * во `/meta`).
 */

import { useMeta } from "@/lib/hooks/useMeta";
import { useObservationMode } from "@/lib/hooks/useObservationMode";
import { useI18n } from "@/lib/hooks/useI18n";
import type { ObservationMode } from "@/lib/personalization";

const MODES: ObservationMode[] = ["all", "networks", "favorites", "exclude"];

export function ObservationModeSettings() {
  const { settings, setMode, setSelectedBrands } = useObservationMode();
  const { meta } = useMeta();
  const { t } = useI18n();
  const brands = meta?.station_brands ?? [];

  function toggleBrand(name: string) {
    setSelectedBrands(
      settings.selectedBrands.includes(name)
        ? settings.selectedBrands.filter((b) => b !== name)
        : [...settings.selectedBrands, name],
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-gray-500 dark:text-gray-400">{t("observation.description")}</p>
      <div className="flex flex-col gap-2">
        {MODES.map((mode) => (
          <label key={mode} className="flex items-center gap-2 text-sm">
            <input type="radio" name="observation-mode" checked={settings.mode === mode} onChange={() => setMode(mode)} />
            {t(`observation.mode.${mode}` as const)}
          </label>
        ))}
      </div>

      {settings.mode === "networks" && (
        <div className="mt-2">
          <p className="mb-1 text-xs font-semibold uppercase text-gray-500">{t("observation.networks.pick")}</p>
          <div className="flex flex-wrap gap-1">
            {brands.map((b) => (
              <button
                key={b.name}
                type="button"
                onClick={() => toggleBrand(b.name)}
                aria-pressed={settings.selectedBrands.includes(b.name)}
                className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                  settings.selectedBrands.includes(b.name)
                    ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                    : "border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                }`}
              >
                {b.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {settings.mode === "exclude" && (
        <p className="text-xs text-gray-400">{t("observation.exclude.hint")}</p>
      )}
    </div>
  );
}
