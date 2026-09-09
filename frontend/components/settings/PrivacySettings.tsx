"use client";

/**
 * Приватность (R24): выключить GPS, точка вручную, «удалить историю позиций».
 * См. `lib/hooks/usePrivacy.tsx` для того, что именно означает «история» тут
 * (CONCERN: backend не хранит трек позиций — удалять на сервере нечего).
 */

import { useState } from "react";
import { usePrivacy } from "@/lib/hooks/usePrivacy";
import { useI18n } from "@/lib/hooks/useI18n";
import { isValidLat, isValidLon } from "@/lib/geo";

export function PrivacySettings() {
  const privacy = usePrivacy();
  const { t } = useI18n();
  const [latInput, setLatInput] = useState(privacy.manualPoint ? String(privacy.manualPoint.lat) : "");
  const [lonInput, setLonInput] = useState(privacy.manualPoint ? String(privacy.manualPoint.lon) : "");
  const [formError, setFormError] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);

  function saveManualPoint() {
    const lat = Number(latInput);
    const lon = Number(lonInput);
    if (!isValidLat(lat) || !isValidLon(lon)) {
      setFormError(t("privacy.manualPoint.invalid"));
      return;
    }
    setFormError(null);
    privacy.setManualPoint({ lat, lon });
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="flex items-start justify-between gap-4 rounded-lg border border-gray-200 p-3 dark:border-gray-800">
        <div>
          <p className="font-medium text-gray-800 dark:text-gray-200">{t("privacy.gps.title")}</p>
          <p className="text-sm text-gray-500 dark:text-gray-400">{t("privacy.gps.description")}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={privacy.gpsEnabled}
          aria-label={t("privacy.gps.title")}
          onClick={() => privacy.setGpsEnabled(!privacy.gpsEnabled)}
          className={`h-6 w-11 shrink-0 rounded-full transition-colors ${privacy.gpsEnabled ? "bg-emerald-600" : "bg-gray-300 dark:bg-gray-700"}`}
        >
          <span className={`block h-5 w-5 translate-y-0.5 rounded-full bg-white transition-transform ${privacy.gpsEnabled ? "translate-x-5" : "translate-x-0.5"}`} />
        </button>
      </section>

      <section className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
        <p className="font-medium text-gray-800 dark:text-gray-200">{t("privacy.manualPoint.title")}</p>
        <p className="mb-2 text-sm text-gray-500 dark:text-gray-400">{t("privacy.manualPoint.description")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            step="any"
            placeholder={t("privacy.manualPoint.lat")}
            value={latInput}
            onChange={(e) => setLatInput(e.target.value)}
            className="w-32 rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
          />
          <input
            type="number"
            step="any"
            placeholder={t("privacy.manualPoint.lon")}
            value={lonInput}
            onChange={(e) => setLonInput(e.target.value)}
            className="w-32 rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
          />
          <button
            type="button"
            onClick={saveManualPoint}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            {t("privacy.manualPoint.save")}
          </button>
          {privacy.manualPoint && (
            <button
              type="button"
              onClick={() => {
                privacy.setManualPoint(null);
                setLatInput("");
                setLonInput("");
              }}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
            >
              {t("privacy.manualPoint.clear")}
            </button>
          )}
        </div>
        {formError && <p className="mt-1 text-sm text-red-600 dark:text-red-400">{formError}</p>}
        {privacy.manualPoint && (
          <p className="mt-1 text-sm text-emerald-700 dark:text-emerald-400">
            {t("privacy.manualPoint.active")}: {privacy.manualPoint.lat.toFixed(5)}, {privacy.manualPoint.lon.toFixed(5)}
          </p>
        )}
      </section>

      <section className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
        <p className="font-medium text-gray-800 dark:text-gray-200">{t("privacy.history.title")}</p>
        <p className="mb-2 text-sm text-gray-500 dark:text-gray-400">{t("privacy.history.description")}</p>
        <button
          type="button"
          onClick={() => {
            privacy.clearHistory();
            setCleared(true);
          }}
          className="rounded-md border border-red-400 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-950"
        >
          {t("privacy.history.clear")}
        </button>
        {cleared && <p className="mt-1 text-sm text-emerald-700 dark:text-emerald-400">{t("privacy.history.cleared")}</p>}
      </section>
    </div>
  );
}
