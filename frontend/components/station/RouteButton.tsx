"use client";

import { buildRouteUrl } from "@/lib/format";
import { useI18n } from "@/lib/hooks/useI18n";

/** Кнопка «Маршрут» — deep-link на внешний навигатор (R80), без встроенной навигации. */
export function RouteButton({ lat, lon }: { lat: number; lon: number }) {
  const { t } = useI18n();
  return (
    <a
      href={buildRouteUrl(lat, lon, "yandex")}
      target="_blank"
      rel="noopener noreferrer"
      className="flex-1 rounded-md bg-blue-600 px-3 py-2 text-center text-sm font-semibold text-white hover:bg-blue-700"
    >
      🧭 {t("station.route")}
    </a>
  );
}
