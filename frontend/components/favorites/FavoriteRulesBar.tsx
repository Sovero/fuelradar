"use client";

/**
 * Индивидуальные правила мониторинга для избранного (R26 — «для избранных
 * могут действовать индивидуальные правила»): правило на всё избранное сразу
 * (scope {"type":"favorites"}) и по одной станции (scope {"station_id": id}).
 * Полный редактор условий (топливо/очередь/достоверность) — экран «Настройки
 * → Правила» (`AlertRulesPanel`); здесь только быстрый вкл/выкл слежения.
 */

import { useAlertRules } from "@/lib/hooks/useAlertRules";
import { useI18n } from "@/lib/hooks/useI18n";
import type { StationBrief } from "@/lib/types";

export function FavoriteRulesBar({ favorites }: { favorites: StationBrief[] }) {
  const { rules, create, remove } = useAlertRules();
  const { t } = useI18n();

  const favoritesRule = rules.find((r) => {
    const kind = String(r.scope?.type ?? "");
    return kind === "favorites" || r.scope?.favorites === true;
  });

  function ruleForStation(stationId: string) {
    return rules.find((r) => r.scope?.station_id === stationId);
  }

  async function toggleFavoritesRule() {
    if (favoritesRule) await remove(favoritesRule.id);
    else await create({ name: t("favorites.rules.allName"), scope: { type: "favorites" }, is_active: true });
  }

  async function toggleStationRule(station: StationBrief) {
    const existing = ruleForStation(station.id);
    if (existing) await remove(existing.id);
    else await create({ name: station.name || station.id, scope: { station_id: station.id }, is_active: true });
  }

  if (favorites.length === 0) return null;

  return (
    <div className="border-b border-gray-100 px-4 py-2 dark:border-gray-800">
      <button
        type="button"
        onClick={toggleFavoritesRule}
        aria-pressed={Boolean(favoritesRule)}
        className={`mb-2 rounded-full border px-3 py-1 text-xs font-semibold ${
          favoritesRule
            ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
            : "border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
        }`}
      >
        🔔 {favoritesRule ? t("favorites.rules.allOn") : t("favorites.rules.allOff")}
      </button>
      <details className="text-xs text-gray-500 dark:text-gray-400">
        <summary className="cursor-pointer select-none">{t("favorites.rules.perStation")}</summary>
        <ul className="mt-1 flex flex-col gap-1">
          {favorites.map((station) => (
            <li key={station.id} className="flex items-center justify-between gap-2">
              <span className="truncate">{station.name || station.id}</span>
              <button
                type="button"
                onClick={() => toggleStationRule(station)}
                aria-pressed={Boolean(ruleForStation(station.id))}
                className={ruleForStation(station.id) ? "text-emerald-700 dark:text-emerald-400" : "text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"}
              >
                🔔
              </button>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
