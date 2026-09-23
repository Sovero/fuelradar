"use client";

import { useEffect, useState } from "react";
import { useFilters } from "@/lib/hooks/useFilters";
import { useGeolocation } from "@/lib/hooks/useGeolocation";
import { usePrivacy } from "@/lib/hooks/usePrivacy";
import { useI18n } from "@/lib/hooks/useI18n";
import { DEFAULT_RADIUS_KM } from "@/lib/filters";

const RADIUS_PRESETS = [5, 10, 20, 30, 50];

/** Выбор топлива/радиуса и кнопка «Найти топливо рядом» (R73, §104). GPS — только если разрешено в приватности (R24). */
export function TopControls() {
  const { filters, setFilters } = useFilters();
  const { t, tt } = useI18n();
  const geo = useGeolocation(t);
  const privacy = usePrivacy();
  const [customRadius, setCustomRadius] = useState(false);
  const [privacyNotice, setPrivacyNotice] = useState(false);

  function findNearby() {
    if (!privacy.gpsEnabled) {
      if (privacy.manualPoint) {
        setFilters({ lat: privacy.manualPoint.lat, lon: privacy.manualPoint.lon });
      } else {
        setPrivacyNotice(true);
      }
      return;
    }
    setPrivacyNotice(false);
    geo.request();
  }

  // Карта уезжает только на GPS-точку или на ПОДТВЕРЖДЁННУЮ IP-точку:
  // city-candidate из IP-резерва сначала показывается в баннере «Вы в X?».
  useEffect(() => {
    if (geo.status === "ready" && geo.position) {
      if (filters.lat !== geo.position.lat || filters.lon !== geo.position.lon) {
        setFilters({ lat: geo.position.lat, lon: geo.position.lon });
      }
      privacy.setLastKnownPosition(geo.position);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo.status, geo.position?.lat, geo.position?.lon]);

  const candidate = geo.ipCandidate;
  const candidateCity = candidate?.place?.trim() || "";

  return (
    <div className="flex flex-col gap-2 px-4 pb-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2">
        <label htmlFor="fr-radius" className="text-sm text-gray-600 dark:text-gray-400">
          {t("radius.label")}
        </label>
        {customRadius ? (
          <input
            id="fr-radius"
            type="number"
            min={1}
            max={500}
            value={filters.radiusKm}
            onChange={(e) => setFilters({ radiusKm: Number(e.target.value) || DEFAULT_RADIUS_KM })}
            className="w-20 rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800"
          />
        ) : (
          <select
            id="fr-radius"
            value={RADIUS_PRESETS.includes(filters.radiusKm) ? filters.radiusKm : "custom"}
            onChange={(e) => {
              if (e.target.value === "custom") {
                setCustomRadius(true);
              } else {
                setFilters({ radiusKm: Number(e.target.value) });
              }
            }}
            className="rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800"
          >
            {RADIUS_PRESETS.map((km) => (
              <option key={km} value={km}>
                {km} км
              </option>
            ))}
            <option value="custom">{t("radius.custom")}</option>
          </select>
        )}
      </div>
      <button
        type="button"
        data-tour="find-nearby"
        onClick={findNearby}
        disabled={geo.status === "loading"}
        className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
      >
        {geo.status === "loading" ? t("findNearby.loading") : t("findNearby.idle")}
      </button>
      {geo.error && <p className="text-sm text-red-600 dark:text-red-400">{geo.error}</p>}
      {geo.status === "ready" && geo.source === "ip" && (
        <p className="text-xs text-gray-500 dark:text-gray-400">{t("findNearby.ipSource")}</p>
      )}
      {candidate && (
        <div
          role="status"
          data-testid="ip-city-banner"
          className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
        >
          <span>
            {candidateCity
              ? tt("findNearby.ipConfirm", { city: candidateCity })
              : t("findNearby.ipConfirmUnknown")}
          </span>
          <button
            type="button"
            onClick={geo.confirmIpCandidate}
            className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700"
          >
            {candidateCity
              ? tt("findNearby.ipConfirmYes", { city: candidateCity })
              : t("findNearby.ipConfirmYesUnknown")}
          </button>
          <button
            type="button"
            onClick={geo.dismissIpCandidate}
            className="rounded-md border border-amber-400 px-3 py-1 text-xs font-medium hover:bg-amber-100 dark:border-amber-600 dark:hover:bg-amber-900"
          >
            {t("findNearby.ipConfirmNo")}
          </button>
        </div>
      )}
      {privacyNotice && <p className="text-sm text-amber-700 dark:text-amber-400">{t("privacy.gps.blockedNotice")}</p>}
    </div>
  );
}
