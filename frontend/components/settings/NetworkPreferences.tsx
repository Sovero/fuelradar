"use client";

/**
 * Предпочтения сетей (R77) — теперь настоящая персонализация Score: выбранная
 * сеть уходит в backend как `?preferred_brands=<id>` (см. `HomeScreen.tsx`),
 * а не только клиентский буст порядка.
 */

import { useMeta } from "@/lib/hooks/useMeta";
import { useNetworkPreferences } from "@/lib/hooks/useNetworkPreferences";
import { useI18n } from "@/lib/hooks/useI18n";

export function NetworkPreferences() {
  const { meta } = useMeta();
  const { preferredBrandIds, toggleBrand } = useNetworkPreferences();
  const { t } = useI18n();
  const brands = meta?.station_brands ?? [];

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-gray-500 dark:text-gray-400">{t("networkPrefs.description")}</p>
      <div className="flex flex-wrap gap-1">
        {brands.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => toggleBrand(b.id)}
            aria-pressed={preferredBrandIds.includes(b.id)}
            className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
              preferredBrandIds.includes(b.id)
                ? "border-amber-500 bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                : "border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            }`}
          >
            {preferredBrandIds.includes(b.id) ? "★ " : "☆ "}
            {b.name}
          </button>
        ))}
        {brands.length === 0 && <p className="text-sm text-gray-400">{t("networkPrefs.empty")}</p>}
      </div>
    </div>
  );
}
