"use client";

/**
 * Ознакомительный тур (R101) — 4 шага по ключевым элементам главного экрана:
 * выбор топлива, радиус/«рядом», табы Карта/Список/Избранное, карта. Простой
 * самописный оверлей (без сторонней библиотеки) — подсветка целевого элемента
 * по его положению на экране + подсказка рядом. Показывается один раз при
 * первом визите (localStorage, см. useOnboarding); можно пропустить в любой
 * момент и запустить снова из шапки.
 */

import { useEffect, useMemo, useState } from "react";
import { useOnboarding } from "@/lib/hooks/useOnboarding";
import { useI18n } from "@/lib/hooks/useI18n";
import type { TranslationKey } from "@/lib/i18n";

interface Step {
  target: string; // CSS-селектор [data-tour="..."]
  titleKey: TranslationKey;
  bodyKey: TranslationKey;
}

const STEPS: Step[] = [
  { target: '[data-tour="fuel"]', titleKey: "tour.fuel.title", bodyKey: "tour.fuel.body" },
  { target: '[data-tour="find-nearby"]', titleKey: "tour.findNearby.title", bodyKey: "tour.findNearby.body" },
  { target: '[data-tour="tabs"]', titleKey: "tour.tabs.title", bodyKey: "tour.tabs.body" },
  { target: '[data-tour="map"]', titleKey: "tour.map.title", bodyKey: "tour.map.body" },
];

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function measure(selector: string): Rect | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

export function OnboardingTour() {
  const { open, finish } = useOnboarding();
  const { t, tt } = useI18n();
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);

  const step = STEPS[stepIndex];

  useEffect(() => {
    if (!open) return;
    setStepIndex(0);
  }, [open]);

  useEffect(() => {
    if (!open || !step) return;

    function update() {
      setRect(measure(step.target));
    }
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    // Цель тура (например карта/фильтры) может ещё не отрисоваться на момент показа
    // тура (данные из /meta грузятся асинхронно) — недолго перепроверяем позицию.
    const interval = window.setInterval(update, 300);
    const timeout = window.setTimeout(() => window.clearInterval(interval), 4000);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [open, step]);

  const tooltipStyle = useMemo(() => {
    if (!rect) return { top: "50%", left: "50%", transform: "translate(-50%, -50%)" } as const;
    const spaceBelow = window.innerHeight - (rect.top + rect.height);
    const placeBelow = spaceBelow > 180 || rect.top < 180;
    return placeBelow
      ? { top: `${rect.top + rect.height + 12}px`, left: `${Math.min(Math.max(rect.left, 12), window.innerWidth - 320)}px` }
      : { top: `${rect.top - 12}px`, left: `${Math.min(Math.max(rect.left, 12), window.innerWidth - 320)}px`, transform: "translateY(-100%)" };
  }, [rect]);

  if (!open || !step) return null;

  const isLast = stepIndex === STEPS.length - 1;

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label={t(step.titleKey)}>
      <svg className="pointer-events-none absolute inset-0 h-full w-full">
        <defs>
          <mask id="fr-tour-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {rect && (
              <rect
                x={rect.left - 6}
                y={rect.top - 6}
                width={rect.width + 12}
                height={rect.height + 12}
                rx={10}
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect x="0" y="0" width="100%" height="100%" fill="rgba(15,23,42,0.6)" mask="url(#fr-tour-mask)" />
      </svg>
      {rect && (
        <div
          className="pointer-events-none absolute rounded-lg ring-2 ring-emerald-400"
          style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }}
        />
      )}

      <div
        className="absolute w-[300px] max-w-[90vw] rounded-lg bg-white p-4 shadow-2xl dark:bg-gray-900 dark:text-gray-100"
        style={tooltipStyle}
      >
        <p className="text-xs font-medium text-gray-400">{tt("tour.step", { current: stepIndex + 1, total: STEPS.length })}</p>
        <h3 className="mt-1 text-base font-semibold">{t(step.titleKey)}</h3>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{t(step.bodyKey)}</p>
        <div className="mt-3 flex items-center justify-between">
          <button type="button" onClick={finish} className="text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
            {t("tour.skip")}
          </button>
          <button
            type="button"
            onClick={() => (isLast ? finish() : setStepIndex((i) => i + 1))}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700"
          >
            {isLast ? t("tour.done") : t("tour.next")}
          </button>
        </div>
      </div>
    </div>
  );
}
