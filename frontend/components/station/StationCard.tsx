"use client";

/**
 * Полная карточка станции (R30, bottom sheet — «Решения по реализации» §16.4:
 * нижний лист вместо модалки на мобильном). Ничего не выдумывает — все поля
 * из ответа `/stations/{id}`; отсутствующие атрибуты показываются как «—» (R30.1).
 */

import { useEffect, useState } from "react";
import { useStationDetail } from "@/lib/hooks/useStationDetail";
import { useMeta } from "@/lib/hooks/useMeta";
import { useI18n } from "@/lib/hooks/useI18n";
import { useObservationMode } from "@/lib/hooks/useObservationMode";
import { StatusBadge } from "@/components/station/StatusBadge";
import { WhyExplanation } from "@/components/station/WhyExplanation";
import { HistoryChart } from "@/components/station/HistoryChart";
import { RouteButton } from "@/components/station/RouteButton";
import { FavoriteButton } from "@/components/station/FavoriteButton";
import { ReportButton } from "@/components/station/ReportButton";
import { LoginPanel } from "@/components/layout/LoginPanel";
import { formatDistance, formatEtaMinutes } from "@/lib/format";

export function StationCard({
  stationId,
  lat,
  lon,
  onClose,
}: {
  stationId: string;
  lat: number | null;
  lon: number | null;
  onClose: () => void;
}) {
  const { station, loading, error } = useStationDetail(stationId, lat, lon);
  const { fuelLabel, queueLabel } = useMeta();
  const { t } = useI18n();
  const { settings: observationSettings, toggleExcluded, isExcluded } = useObservationMode();
  const [historyFuel, setHistoryFuel] = useState<string | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);

  useEffect(() => {
    if (station && !historyFuel && station.statuses.length) {
      setHistoryFuel(station.statuses[0].fuel_code);
    }
  }, [station, historyFuel]);

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 max-h-[85vh] overflow-y-auto rounded-t-2xl border-t border-gray-200 bg-white p-4 shadow-2xl dark:border-gray-800 dark:bg-gray-900 sm:absolute sm:inset-auto sm:right-4 sm:top-4 sm:max-h-[calc(100%-2rem)] sm:w-96 sm:rounded-2xl sm:border">
      <div className="mb-2 flex items-start justify-between">
        <div className="h-1 w-10 self-center rounded-full bg-gray-300 dark:bg-gray-700 sm:hidden" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Закрыть карточку станции"
          className="ml-auto rounded-full p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          ✕
        </button>
      </div>

      {loading && <p className="text-sm text-gray-400">{t("loading")}</p>}
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {station && (
        <div className="flex flex-col gap-3">
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">{station.name || "—"}</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">{station.brand || "Без сети"}</p>
          </div>

          <dl className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <dt className="text-xs uppercase text-gray-400">{t("station.address")}</dt>
              <dd className="text-gray-800 dark:text-gray-200">{station.address || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-gray-400">{t("station.hours")}</dt>
              <dd className="text-gray-800 dark:text-gray-200">{station.opening_hours || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-gray-400">{t("station.distance")}</dt>
              <dd className="text-gray-800 dark:text-gray-200">{formatDistance(station.distance_km)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-gray-400">{t("station.eta")}</dt>
              <dd className="text-gray-800 dark:text-gray-200">{formatEtaMinutes(station.eta_minutes)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-gray-400">{t("station.queue")}</dt>
              <dd className="text-gray-800 dark:text-gray-200">
                {station.queue ? (
                  <>
                    {queueLabel(station.queue.level)}
                    {station.queue.vehicles !== null && <> · {station.queue.vehicles} машин</>}
                    {station.queue.estimated_wait_minutes !== null && <> · ≈{station.queue.estimated_wait_minutes} мин</>}
                  </>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-gray-400">{t("station.phone")}</dt>
              <dd className="text-gray-800 dark:text-gray-200">{station.phone || "—"}</dd>
            </div>
          </dl>

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{t("station.fuelHeading")}</h3>
            {station.statuses.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">{t("station.noFuelData")}</p>
            ) : (
              station.statuses.map((s) => (
                <button key={s.fuel_code} type="button" onClick={() => setHistoryFuel(s.fuel_code)} className="text-left">
                  <StatusBadge status={s} />
                </button>
              ))
            )}
          </div>

          <WhyExplanation explanation={station.status_explanation} />

          <div>
            <h3 className="mb-1 text-sm font-semibold text-gray-700 dark:text-gray-300">
              {t("station.history")} {historyFuel ? `· ${fuelLabel(historyFuel)}` : ""}
            </h3>
            <HistoryChart stationId={station.id} fuelCode={historyFuel} />
          </div>

          <div className="flex gap-2 pt-2">
            <RouteButton lat={station.latitude} lon={station.longitude} />
            <FavoriteButton stationId={station.id} onRequireLogin={() => setLoginOpen(true)} />
            <ReportButton
              stationId={station.id}
              stationLat={station.latitude}
              stationLon={station.longitude}
              onRequireLogin={() => setLoginOpen(true)}
            />
          </div>

          {observationSettings.mode === "exclude" && (
            <button
              type="button"
              onClick={() => toggleExcluded(station.id)}
              className="text-xs text-gray-400 underline hover:text-gray-600 dark:hover:text-gray-200"
            >
              {isExcluded(station.id) ? t("observation.exclude.include") : t("observation.exclude.exclude")}
            </button>
          )}
        </div>
      )}

      {loginOpen && <LoginPanel onClose={() => setLoginOpen(false)} />}
    </div>
  );
}
