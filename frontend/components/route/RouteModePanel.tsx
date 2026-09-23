"use client";

import { useEffect, useState } from "react";

import { formatDistance, formatEtaMinutes } from "@/lib/format";
import { useI18n } from "@/lib/hooks/useI18n";
import type { TranslationKey } from "@/lib/i18n";
import type { MapPoint } from "@/lib/map/types";
import type { RoutePlan, RoutePlanReason, RoutePlanStep } from "@/lib/types";

/** Маневры OSRM → ключи словаря. Незнакомый код честно сводится к «продолжайте». */
const MANEUVER_KEYS: Record<string, TranslationKey> = {
  depart: "route.maneuver.depart",
  arrive: "route.maneuver.arrive",
  notification: "route.maneuver.notification",
  new_name: "route.maneuver.new_name",
  continue: "route.maneuver.continue",
  continue_left: "route.maneuver.continue_left",
  continue_right: "route.maneuver.continue_right",
  turn_left: "route.maneuver.turn_left",
  turn_right: "route.maneuver.turn_right",
  turn_slight_left: "route.maneuver.turn_slight_left",
  turn_slight_right: "route.maneuver.turn_slight_right",
  turn_sharp_left: "route.maneuver.turn_sharp_left",
  turn_sharp_right: "route.maneuver.turn_sharp_right",
  turn_straight: "route.maneuver.turn_straight",
  turn_uturn: "route.maneuver.turn_uturn",
  merge: "route.maneuver.merge",
  merge_left: "route.maneuver.merge_left",
  merge_right: "route.maneuver.merge_right",
  fork_left: "route.maneuver.fork_left",
  fork_right: "route.maneuver.fork_right",
  roundabout: "route.maneuver.roundabout",
  exit_roundabout: "route.maneuver.exit_roundabout",
  on_ramp: "route.maneuver.on_ramp",
  off_ramp: "route.maneuver.off_ramp",
  ramp_left: "route.maneuver.ramp_left",
  ramp_right: "route.maneuver.ramp_right",
  use_lane: "route.maneuver.use_lane",
  end_of_road_left: "route.maneuver.end_of_road_left",
  end_of_road_right: "route.maneuver.end_of_road_right",
};

const REASON_KEYS: Record<RoutePlanReason, TranslationKey> = {
  not_configured: "route.reason.not_configured",
  provider_unavailable: "route.reason.provider_unavailable",
  no_route: "route.reason.no_route",
};

const MAX_VISIBLE_STEPS = 8;

/** Таблица маневров: мнемоника поворотов вместо текста (компактность + считывается с любого языка). */
const STEP_ICONS: Record<string, string> = {
  depart: "◉",
  arrive: "🏁",
  continue: "↑",
  turn_left: "←",
  turn_right: "→",
  turn_slight_left: "↖",
  turn_slight_right: "↗",
  turn_sharp_left: "↰",
  turn_sharp_right: "↱",
  turn_uturn: "⤺",
  merge: "⤞",
  fork_left: "⑂",
  fork_right: "⑂",
  roundabout: "◯",
  exit_roundabout: "↻",
  on_ramp: "⇗",
  off_ramp: "⇘",
};

function maneuverKey(step: RoutePlanStep): TranslationKey {
  const code = step.modifier ? `${step.type}_${step.modifier.replace(/\s+/g, "_")}` : step.type;
  return MANEUVER_KEYS[code] ?? MANEUVER_KEYS[step.type] ?? "route.maneuver.default";
}

function stepIcon(step: RoutePlanStep): string {
  const code = step.modifier ? `${step.type}_${step.modifier.replace(/\s+/g, "_")}` : step.type;
  return STEP_ICONS[code] ?? STEP_ICONS[step.type] ?? "↑";
}

interface RouteModePanelProps {
  active: boolean;
  points: MapPoint[];
  corridorKm: number;
  /** Дорожный маршрут от роутера: геометрия по улицам, реальные км/мин, маневры. */
  plan?: RoutePlan | null;
  planLoading?: boolean;
  planError?: string | null;
  /** Счётчик-триггер «открыть вкладку маневров» (клик по подписи на линии). */
  stepsOpenRequest?: number;
  /** Вызывается после обработки триггера, чтобы родитель мог сбросить счётчик. */
  onStepsOpenHandled?: () => void;
  /** Маневр для подсветки (ближайший к подписи на линии); null — без подсветки. */
  activeStepIndex?: number | null;
  onActiveChange: (active: boolean) => void;
  onCorridorChange: (corridorKm: number) => void;
  onRemovePoint: (index: number) => void;
  onClear: () => void;
}

export function RouteModePanel({
  active,
  points,
  corridorKm,
  plan = null,
  planLoading = false,
  planError = null,
  stepsOpenRequest = 0,
  onStepsOpenHandled,
  activeStepIndex = null,
  onActiveChange,
  onCorridorChange,
  onRemovePoint,
  onClear,
}: RouteModePanelProps) {
  const { t, tt } = useI18n();
  const [corridorInput, setCorridorInput] = useState(String(corridorKm));
  const [stepsOpen, setStepsOpen] = useState(false);

  useEffect(() => setCorridorInput(String(corridorKm)), [corridorKm]);

  // Клик по подписи на линии маршрута открывает вкладку маневров (и только
  // открывает: повторный клик по подписи — просто держим вкладку открытой).
  useEffect(() => {
    if (stepsOpenRequest > 0) {
      setStepsOpen(true);
      onStepsOpenHandled?.();
    }
  }, [stepsOpenRequest, onStepsOpenHandled]);

  const isRoadRoute = Boolean(plan?.is_road_route && plan?.geometry && plan.geometry.length >= 2);
  const steps = plan?.steps ?? [];
  const hasSteps = isRoadRoute && steps.length > 0;
  // Активный шаг (ближайший к подписи на линии) обязан быть видимым, даже если он
  // за пределами первых MAX_VISIBLE_STEPS — иначе подсветки не видно вовсе.
  const visibleCount =
    activeStepIndex !== null && activeStepIndex >= MAX_VISIBLE_STEPS
      ? Math.min(activeStepIndex + 1, steps.length)
      : MAX_VISIBLE_STEPS;
  const extraSteps = Math.max(0, steps.length - visibleCount);

  return (
    <section
      className="border-b border-blue-100 bg-blue-50 px-3 py-2 dark:border-blue-900 dark:bg-blue-950/50"
      aria-label={t("route.honestNote")}
    >
      {/* Лента управления: кнопка режима, статус-лента, счётчик точек, ширина, сброс — одна строка. */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onActiveChange(!active)}
          aria-pressed={active}
          className="rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700"
        >
          {active ? t("route.disable") : t("route.enable")}
        </button>

        {active && (
          <>
            {/* Статус: дорожный/прямая — компактный чип вместо абзацев текста. */}
            {isRoadRoute ? (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-1 text-xs font-medium text-blue-900 dark:bg-blue-900/60 dark:text-blue-100"
                data-testid="route-road-note"
                title={t("route.roadNote")}
              >
                <span aria-hidden>🛣️</span>
                {plan?.distance_km !== null && plan?.distance_km !== undefined
                  ? tt("route.roadShort", {
                      distance: formatDistance(plan.distance_km),
                      eta: formatEtaMinutes(plan.duration_min),
                    })
                  : t("route.roadNote")}
              </span>
            ) : (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800 dark:bg-amber-900/50 dark:text-amber-200"
                data-testid="route-straight-note"
                title={t("route.straightNote")}
              >
                <span aria-hidden>📏</span>
                {planLoading ? t("route.planLoading") : t("route.straightNote")}
              </span>
            )}

            {points.length > 0 && (
              <span className="text-xs font-medium text-blue-800 dark:text-blue-200" data-testid="route-point-count">
                {tt("route.pointCount", { count: points.length })}
              </span>
            )}

            <label className="ml-auto grid items-center gap-1 text-xs font-medium text-blue-950 dark:text-blue-100 md:grid-flow-col md:items-center">
              <span>{t("route.corridorLabel")}</span>
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
                className="w-20 rounded border border-blue-200 bg-white px-2 py-1.5 text-gray-900 dark:border-blue-800 dark:bg-gray-900 dark:text-white"
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
          </>
        )}
      </div>

      {active && (
        <>
          {/* Пояснения и честные причины — компактной строкой, не блоками. */}
          {(plan?.reason || planError) && !isRoadRoute && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
              {plan?.reason ? t(REASON_KEYS[plan.reason]) : planError}
            </p>
          )}
          {planError && isRoadRoute && (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">{planError}</p>
          )}
          <p className="mt-1 text-xs text-blue-800 dark:text-blue-300">{t("route.pickHint")}</p>

          {/* Точки коридора — плотная лента удаляемых чипов. */}
          {points.length > 0 && (
            <ol className="mt-1.5 flex flex-wrap gap-1" aria-label={t("route.pointsLabel")}>
              {points.map((point, index) => (
                <li key={`${point.lat}-${point.lon}-${index}`}>
                  <button
                    type="button"
                    onClick={() => onRemovePoint(index)}
                    aria-label={tt("route.removePoint", { number: index + 1 })}
                    className="rounded border border-blue-200 bg-white px-2 py-1 text-xs tabular-nums text-blue-900 hover:border-red-300 hover:text-red-700 dark:border-blue-800 dark:bg-gray-900 dark:text-blue-100"
                  >
                    {index + 1}: {point.lat.toFixed(4)}, {point.lon.toFixed(4)} ×
                  </button>
                </li>
              ))}
            </ol>
          )}

          {/* Маневры — сворачиваемая вкладка: не занимают место, пока не нужны. */}
          {hasSteps && (
            <div className="mt-1.5">
              <button
                type="button"
                onClick={() => setStepsOpen((open) => !open)}
                aria-expanded={stepsOpen}
                aria-controls="route-steps-list"
                data-testid="route-steps-toggle"
                className="inline-flex items-center gap-1.5 rounded border border-blue-200 bg-white px-2.5 py-1 text-xs font-semibold text-blue-900 hover:bg-blue-100 dark:border-blue-800 dark:bg-gray-900 dark:text-blue-100 dark:hover:bg-blue-950"
              >
                <span aria-hidden className="transition-transform" style={{ transform: stepsOpen ? "rotate(90deg)" : undefined }}>
                  ▶
                </span>
                {t("route.stepsLabel")}
                <span className="rounded-full bg-blue-100 px-1.5 text-[11px] font-medium text-blue-800 dark:bg-blue-900/60 dark:text-blue-200">
                  {steps.length}
                </span>
                <span className="hidden font-normal text-blue-700 dark:text-blue-300 md:inline">
                  {tt("route.roadSummary", {
                    distance: formatDistance(plan?.distance_km ?? 0),
                    eta: formatEtaMinutes(plan?.duration_min ?? 0),
                  })}
                </span>
              </button>
              {stepsOpen && (
                <ol
                  id="route-steps-list"
                  className="mt-1 grid gap-x-4 gap-y-0.5 rounded border border-blue-200 bg-white/70 p-2 text-xs text-blue-900 sm:grid-cols-2 lg:grid-cols-3 dark:border-blue-800 dark:bg-gray-900/70 dark:text-blue-200"
                  aria-label={t("route.stepsLabel")}
                  data-testid="route-steps"
                >
                  {steps.slice(0, visibleCount).map((step, index) => {
                    const isHighlighted = index === activeStepIndex;
                    return (
                      <li
                        key={`${step.type}-${step.modifier}-${index}`}
                        className={`flex min-w-0 items-baseline gap-1.5 rounded px-1 ${
                          isHighlighted
                            ? "bg-blue-600/15 ring-1 ring-blue-500 dark:bg-blue-400/20 dark:ring-blue-400"
                            : ""
                        }`}
                        data-testid={isHighlighted ? "route-step-active" : undefined}
                      >
                        <span
                          aria-hidden
                          className={`inline-flex w-5 shrink-0 justify-center text-sm leading-none ${
                            isHighlighted ? "font-bold text-blue-900 dark:text-blue-100" : "text-blue-700 dark:text-blue-300"
                          }`}
                        >
                          {stepIcon(step)}
                        </span>
                        <span className={`min-w-0 truncate ${isHighlighted ? "font-semibold text-blue-900 dark:text-blue-100" : ""}`}>
                          {t(maneuverKey(step))}
                          {step.street ? ` · ${tt("route.onStreet", { street: step.street })}` : ""}
                          {` · ${formatDistance(step.distance_m / 1000)}`}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
              {stepsOpen && extraSteps > 0 && (
                <p className="mt-1 text-xs text-blue-700 dark:text-blue-300">
                  {tt("route.stepsMore", { count: extraSteps })}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
