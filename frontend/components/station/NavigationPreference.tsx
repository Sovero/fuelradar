"use client";

import { useI18n } from "@/lib/hooks/useI18n";
import type { RouteProvider } from "@/lib/format";

const OPTIONS = [
  { value: "yandex", labelKey: "station.navProvider.yandex" },
  { value: "2gis", labelKey: "station.navProvider.2gis" },
  { value: "google", labelKey: "station.navProvider.google" },
] as const satisfies readonly { value: RouteProvider; labelKey: Parameters<ReturnType<typeof useI18n>["t"]>[0] }[];

/**
 * Выбор внешнего навигатора для кнопки «Маршрут» в карточке станции.
 * Сегмент-контрол: выбранный вариант — aria-pressed, клик сразу сохраняет
 * выбор (useNavigationPreference) и используется следующим открытием карты.
 */
export function NavigationPreference({
  provider,
  onSelect,
}: {
  provider: RouteProvider;
  onSelect: (provider: RouteProvider) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 dark:text-gray-400">{t("station.navProvider")}</span>
      <div role="group" className="flex overflow-hidden rounded-md border border-gray-200 dark:border-gray-700">
        {OPTIONS.map(({ value, labelKey }) => (
          <button
            key={value}
            type="button"
            aria-pressed={provider === value}
            onClick={() => onSelect(value)}
            className={`px-2 py-1 text-xs font-medium transition-colors ${
              provider === value
                ? "bg-blue-600 text-white"
                : "bg-white text-gray-600 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
            }`}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
    </div>
  );
}
