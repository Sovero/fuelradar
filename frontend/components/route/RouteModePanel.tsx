"use client";

import { useEffect, useState } from "react";

import { useI18n } from "@/lib/hooks/useI18n";
import type { MapPoint } from "@/lib/map/types";

interface RouteModePanelProps {
  active: boolean;
  points: MapPoint[];
  corridorKm: number;
  onActiveChange: (active: boolean) => void;
  onCorridorChange: (corridorKm: number) => void;
  onRemovePoint: (index: number) => void;
  onClear: () => void;
}

export function RouteModePanel({
  active,
  points,
  corridorKm,
  onActiveChange,
  onCorridorChange,
  onRemovePoint,
  onClear,
}: RouteModePanelProps) {
  const { t, tt } = useI18n();
  const [corridorInput, setCorridorInput] = useState(String(corridorKm));

  useEffect(() => setCorridorInput(String(corridorKm)), [corridorKm]);

  return (
    <section className="border-b border-blue-100 bg-blue-50 px-3 py-2 dark:border-blue-900 dark:bg-blue-950/50">
      <button
        type="button"
        onClick={() => onActiveChange(!active)}
        aria-pressed={active}
        className="rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700"
      >
        {active ? t("route.disable") : t("route.enable")}
      </button>

      {active && (
        <div className="mt-2 grid gap-2 text-sm md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
          <div>
            <p className="font-medium text-blue-950 dark:text-blue-100">{t("route.honestNote")}</p>
            <p className="text-xs text-blue-800 dark:text-blue-300">{t("route.pickHint")}</p>
            <p className="mt-1 text-xs text-blue-700 dark:text-blue-300">
              {tt("route.pointCount", { count: points.length })}
            </p>
            {points.length > 0 && (
              <ol className="mt-1 flex flex-wrap gap-1" aria-label={t("route.pointsLabel")}>
                {points.map((point, index) => (
                  <li key={`${point.lat}-${point.lon}-${index}`}>
                    <button
                      type="button"
                      onClick={() => onRemovePoint(index)}
                      aria-label={tt("route.removePoint", { number: index + 1 })}
                      className="rounded border border-blue-200 bg-white px-2 py-1 text-xs text-blue-900 hover:border-red-300 hover:text-red-700 dark:border-blue-800 dark:bg-gray-900 dark:text-blue-100"
                    >
                      {index + 1}: {point.lat.toFixed(4)}, {point.lon.toFixed(4)} ×
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-xs font-medium text-blue-950 dark:text-blue-100">
              {t("route.corridorLabel")}
              <input
                type="number"
                min="0.5"
                max="50"
                step="0.5"
                value={corridorInput}
                aria-label={t("route.corridorLabel")}
                onChange={(event) => {
                  const next = event.target.value;
                  setCorridorInput(next);
                  const value = Number(next);
                  if (next !== "" && Number.isFinite(value) && value >= 0.5 && value <= 50) {
                    onCorridorChange(value);
                  }
                }}
                className="w-24 rounded border border-blue-200 bg-white px-2 py-1.5 text-gray-900 dark:border-blue-800 dark:bg-gray-900 dark:text-white"
              />
            </label>
            <button
              type="button"
              onClick={onClear}
              disabled={points.length === 0}
              className="rounded border border-blue-200 bg-white px-2 py-1.5 text-xs text-blue-900 disabled:opacity-50 dark:border-blue-800 dark:bg-gray-900 dark:text-blue-100"
            >
              {t("route.clear")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
