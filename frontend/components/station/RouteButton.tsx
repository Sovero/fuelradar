"use client";

import { buildRouteUrl } from "@/lib/format";
import { useI18n } from "@/lib/hooks/useI18n";

/**
 * Кнопка «Маршрут» в карточке станции.
 *
 * Основное поведение — маршрут на ВНУТРЕННЕЙ карте: включается режим коридора
 * (Route Mode), станция становится точкой назначения, старт — позиция
 * пользователя, если известна (иначе её добавляют кликом по карте). Линия
 * строится по дорогам и улицам (R22.1, роутер из конфигурации); если роутер
 * недоступен, остаётся прямая с честной причиной в панели.
 *
 * Fallback на внешний навигатор — только если карточку отрисовали без
 * обработчика (нет карты рядом); в основном экране обработчик всегда есть.
 */
export function RouteButton({
  lat,
  lon,
  onBuildRoute,
}: {
  lat: number;
  lon: number;
  onBuildRoute?: (lat: number, lon: number) => void;
}) {
  const { t } = useI18n();

  if (!onBuildRoute) {
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

  return (
    <button
      type="button"
      onClick={() => onBuildRoute(lat, lon)}
      className="flex-1 rounded-md bg-blue-600 px-3 py-2 text-center text-sm font-semibold text-white hover:bg-blue-700"
    >
      🧭 {t("station.route")}
    </button>
  );
}
