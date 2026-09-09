"use client";

/**
 * Форма «Сообщить» (R39): по каждому виду топлива Есть/Нет/Заканчивается/Не
 * знаю + очередь; GPS-подтверждение (R40, <300 м — порог оценивается только
 * backend'ом, здесь просто подсказка «вы рядом»); идемпотентный ключ на
 * станцию+минуту (R39.1 — двойной клик не дублирует, разные минуты не
 * слипаются); офлайн — в очередь на устройстве (R39.2).
 */

import { useEffect, useMemo, useState } from "react";
import { apiPost, ApiError } from "@/lib/api";
import { useMeta } from "@/lib/hooks/useMeta";
import { useI18n } from "@/lib/hooks/useI18n";
import { useGeolocation } from "@/lib/hooks/useGeolocation";
import { usePrivacy } from "@/lib/hooks/usePrivacy";
import { haversineMeters } from "@/lib/geo";
import { enqueueOfflineReport, isNetworkError } from "@/lib/offlineReports";
import type { ReportBody, ReportOut } from "@/lib/types";

const FUEL_ANSWERS = [
  { value: "AVAILABLE", labelKey: "report.fuel.available" as const, cls: "border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" },
  { value: "LOW_STOCK", labelKey: "report.fuel.lowStock" as const, cls: "border-amber-500 bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300" },
  { value: "UNAVAILABLE", labelKey: "report.fuel.unavailable" as const, cls: "border-red-500 bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300" },
  { value: "UNKNOWN", labelKey: "report.fuel.unknown" as const, cls: "border-gray-400 bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300" },
];

const QUEUE_ANSWERS = ["NONE", "LOW", "MEDIUM", "HIGH", "VERY_HIGH"];

function buildIdempotencyKey(stationId: string): string {
  const minuteBucket = Math.floor(Date.now() / 60000);
  return `report:${stationId}:${minuteBucket}`;
}

export function ReportForm({
  stationId,
  stationLat,
  stationLon,
  onClose,
}: {
  stationId: string;
  stationLat: number | null;
  stationLon: number | null;
  onClose: () => void;
}) {
  const { meta, fuelLabel, queueLabel } = useMeta();
  const { t } = useI18n();
  const geo = useGeolocation();
  const privacy = usePrivacy();

  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [queue, setQueue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"idle" | "sent" | "queued" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Ключ фиксируется один раз при открытии формы — повторное нажатие «Отправить»
  // (двойной клик) шлёт тот же ключ и не создаёт второй отчёт (R39.1).
  const [idempotencyKey] = useState(() => buildIdempotencyKey(stationId));

  const reportableFuels = useMemo(
    () => (meta?.fuel_types ?? []).filter((f) => f.code !== "UNKNOWN" && f.code !== "OTHER"),
    [meta],
  );

  useEffect(() => {
    if (privacy.gpsEnabled) geo.request();
    // запрашиваем один раз при открытии формы — намеренно без geo в зависимостях
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [privacy.gpsEnabled]);

  useEffect(() => {
    if (geo.status === "ready" && geo.position) {
      privacy.setLastKnownPosition(geo.position);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo.status, geo.position?.lat, geo.position?.lon]);

  const effectivePosition = privacy.gpsEnabled
    ? geo.position
    : privacy.manualPoint
      ? { lat: privacy.manualPoint.lat, lon: privacy.manualPoint.lon }
      : null;

  const distanceM =
    effectivePosition && stationLat !== null && stationLon !== null
      ? haversineMeters(effectivePosition.lat, effectivePosition.lon, stationLat, stationLon)
      : null;

  function setFuelAnswer(code: string, value: string) {
    setAnswers((prev) => {
      if (prev[code] === value) {
        const next = { ...prev };
        delete next[code];
        return next;
      }
      return { ...prev, [code]: value };
    });
  }

  const hasAnyAnswer = Object.keys(answers).length > 0 || queue !== null;

  async function handleSubmit() {
    if (!hasAnyAnswer) {
      setErrorMessage(t("report.validation.empty"));
      return;
    }
    setBusy(true);
    setErrorMessage(null);
    const body: ReportBody = {
      station_id: stationId,
      fuel: answers,
      queue,
      idempotency_key: idempotencyKey,
      lat: effectivePosition?.lat ?? null,
      lon: effectivePosition?.lon ?? null,
    };
    try {
      await apiPost<ReportOut>("/reports", body);
      setResult("sent");
    } catch (err) {
      if (isNetworkError(err)) {
        enqueueOfflineReport(body);
        setResult("queued");
      } else {
        setResult("error");
        setErrorMessage(err instanceof ApiError ? err.message : t("report.error.generic"));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-md flex-col rounded-lg bg-white p-4 shadow-xl dark:bg-gray-900 dark:text-gray-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t("report.title")}</h2>
          <button type="button" onClick={onClose} aria-label={t("login.close")} className="rounded-full p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800">
            ✕
          </button>
        </div>

        {result === "sent" && (
          <div className="flex flex-col gap-3 py-4 text-center">
            <p className="text-emerald-700 dark:text-emerald-400">{t("report.success")}</p>
            <button type="button" onClick={onClose} className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700">
              {t("login.close")}
            </button>
          </div>
        )}

        {result === "queued" && (
          <div className="flex flex-col gap-3 py-4 text-center">
            <p className="text-amber-700 dark:text-amber-400">{t("report.queued")}</p>
            <button type="button" onClick={onClose} className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700">
              {t("login.close")}
            </button>
          </div>
        )}

        {(result === "idle" || result === "error") && (
          <>
            <div className="overflow-y-auto pr-1">
              {distanceM !== null && (
                <p className="mb-2 text-xs text-emerald-700 dark:text-emerald-400">
                  {distanceM < 300 ? t("report.gps.near") : t("report.gps.far")} · {Math.round(distanceM)} {t("report.gps.meters")}
                </p>
              )}
              {!privacy.gpsEnabled && !privacy.manualPoint && (
                <p className="mb-2 text-xs text-gray-400">{t("report.gps.disabled")}</p>
              )}

              <div className="flex flex-col gap-3">
                {reportableFuels.map((fuel) => (
                  <div key={fuel.code}>
                    <p className="mb-1 text-sm font-medium text-gray-700 dark:text-gray-300">{fuelLabel(fuel.code)}</p>
                    <div className="flex flex-wrap gap-1">
                      {FUEL_ANSWERS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => setFuelAnswer(fuel.code, option.value)}
                          aria-pressed={answers[fuel.code] === option.value}
                          className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                            answers[fuel.code] === option.value
                              ? option.cls
                              : "border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                          }`}
                        >
                          {t(option.labelKey)}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-4">
                <p className="mb-1 text-sm font-medium text-gray-700 dark:text-gray-300">{t("station.queue")}</p>
                <div className="flex flex-wrap gap-1">
                  {QUEUE_ANSWERS.map((level) => (
                    <button
                      key={level}
                      type="button"
                      onClick={() => setQueue((prev) => (prev === level ? null : level))}
                      aria-pressed={queue === level}
                      className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                        queue === level
                          ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                          : "border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                      }`}
                    >
                      {queueLabel(level)}
                    </button>
                  ))}
                </div>
              </div>

              {errorMessage && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{errorMessage}</p>}
            </div>

            <button
              type="button"
              onClick={handleSubmit}
              disabled={busy}
              className="mt-4 w-full rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {busy ? t("report.submitting") : t("report.submit")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
