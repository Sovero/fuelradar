"use client";

import { buildRouteUrl } from "@/lib/format";
import type { RouteProvider } from "@/lib/format";
import { useI18n } from "@/lib/hooks/useI18n";

const OPTIONS = [
  { value: "yandex", labelKey: "station.navProvider.yandex" },
  { value: "2gis", labelKey: "station.navProvider.2gis" },
  { value: "google", labelKey: "station.navProvider.google" },
] as const satisfies readonly { value: RouteProvider; labelKey: Parameters<ReturnType<typeof useI18n>["t"]>[0] }[];

/**
 * Выбор внешнего навигатора для карточки станции (R80). Сегмент-контрол
 * выбирает провайдера и сохраняет выбор (useNavigationPreference), а ссылка
 * «Открыть в навигаторе ↗» открывает точку станции в выбранном приложении.
 * Без ссылки выбор был бы декоративным: кнопка «Маршрут» строит маршрут на
 * внутренней карте (Route Mode, R22) и выбранный провайдер не использует.
 */
export function NavigationPreference({
  provider,
  onSelect,
  lat,
  lon,
}: {
  provider: RouteProvider;
  onSelect: (provider: RouteProvider) => void;
  lat: number;
  lon: number;
}) {
  const { t, tt } = useI18n();
  const activeOption = OPTIONS.find((option) => option.value === provider) ?? OPTIONS[0];
  const linkTitle = tt("station.navOpen.title", { provider: t(activeOption.labelKey) });

  return (
    <div className="flex flex-wrap items-center gap-2">
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
      <a
        href={buildRouteUrl(lat, lon, provider)}
        target="_blank"
        rel="noopener noreferrer"
        title={linkTitle}
        aria-label={linkTitle}
        className="inline-flex items-center gap-1 rounded-md border border-blue-600 px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-50 dark:border-blue-500 dark:text-blue-300 dark:hover:bg-blue-950"
      >
        {t("station.navOpen")} ↗
      </a>
    </div>
  );
}
