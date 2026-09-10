"use client";

/**
 * Полная панель фильтров (R32): топливо, сеть, доступность, достоверность,
 * очередь, радиус + поиск. Применяется и к карте, и к списку — состояние общее
 * (useFilters, хранится в URL), не сбрасывается при переключении вкладок (R32.1).
 */

import { useState } from "react";
import { useFilters } from "@/lib/hooks/useFilters";
import { useMeta } from "@/lib/hooks/useMeta";
import { useI18n } from "@/lib/hooks/useI18n";

const QUEUE_ORDER = ["NONE", "LOW", "MEDIUM", "HIGH", "VERY_HIGH"];

export function FiltersPanel() {
  const { filters, setFilters } = useFilters();
  const { meta, statusLabel, queueLabel } = useMeta();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  const brands = meta?.station_brands ?? [];
  const statuses = meta?.fuel_statuses ?? [];
  const queueLevels = (meta?.queue_levels ?? []).filter((q) => QUEUE_ORDER.includes(q.code)).sort((a, b) => QUEUE_ORDER.indexOf(a.code) - QUEUE_ORDER.indexOf(b.code));

  return (
    <div className="border-b border-gray-200 bg-white px-4 py-2 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-center gap-2">
        <input
          type="search"
          value={filters.search}
          onChange={(e) => setFilters({ search: e.target.value })}
          placeholder={t("search.placeholder")}
          aria-label={t("search.label")}
          className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
        />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
        >
          {t("filters.toggle")} {open ? "▲" : "▼"}
        </button>
      </div>

      {open && (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <p className="text-xs text-gray-400 sm:col-span-2 lg:col-span-3">{t("filters.note")}</p>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-semibold uppercase text-gray-500">{t("filters.brand")}</span>
            <select
              value={filters.brand ?? ""}
              onChange={(e) => setFilters({ brand: e.target.value || null })}
              className="rounded-md border border-gray-300 px-2 py-1.5 dark:border-gray-700 dark:bg-gray-800"
            >
              <option value="">{t("filters.brand.any")}</option>
              {brands.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-semibold uppercase text-gray-500">{t("filters.status")}</span>
            <select
              value={filters.status ?? ""}
              onChange={(e) => setFilters({ status: e.target.value || null })}
              className="rounded-md border border-gray-300 px-2 py-1.5 dark:border-gray-700 dark:bg-gray-800"
            >
              <option value="">{t("filters.status.any")}</option>
              {statuses.map((s) => (
                <option key={s.code} value={s.code}>
                  {statusLabel(s.code)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-semibold uppercase text-gray-500">
              {t("filters.confidenceMin")} {filters.confidenceMin ?? 0}%
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={filters.confidenceMin ?? 0}
              onChange={(e) => setFilters({ confidenceMin: Number(e.target.value) || null })}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-semibold uppercase text-gray-500">{t("filters.queueMax")}</span>
            <select
              value={filters.queueMax ?? ""}
              onChange={(e) => setFilters({ queueMax: e.target.value || null })}
              className="rounded-md border border-gray-300 px-2 py-1.5 dark:border-gray-700 dark:bg-gray-800"
            >
              <option value="">{t("filters.queueMax.any")}</option>
              {queueLevels.map((q) => (
                <option key={q.code} value={q.code}>
                  {queueLabel(q.code)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-semibold uppercase text-gray-500">{t("filters.priceMax")}</span>
            <input
              type="number"
              min={0}
              step={0.5}
              value={filters.priceMax ?? ""}
              onChange={(e) => {
                const raw = e.target.value;
                const n = raw === "" ? null : Number(raw);
                setFilters({ priceMax: n !== null && Number.isFinite(n) && n > 0 ? n : null });
              }}
              disabled={filters.fuels.length !== 1}
              aria-describedby="price-max-hint"
              placeholder={t("filters.priceMax")}
              className="rounded-md border border-gray-300 px-2 py-1.5 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800"
            />
            <span id="price-max-hint" className="text-xs text-gray-400">{t("filters.priceMax.hint")}</span>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-semibold uppercase text-gray-500">{t("filters.radius")}</span>
            <input
              type="number"
              min={1}
              max={500}
              value={filters.radiusKm}
              onChange={(e) => setFilters({ radiusKm: Number(e.target.value) || 1 })}
              className="rounded-md border border-gray-300 px-2 py-1.5 dark:border-gray-700 dark:bg-gray-800"
            />
          </label>

          <div className="sm:col-span-2 lg:col-span-3">
            <button
              type="button"
              onClick={() =>
                setFilters({ brand: null, status: null, confidenceMin: null, queueMax: null, priceMax: null, search: "" })
              }
              className="text-sm text-gray-500 underline hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            >
              {t("filters.reset")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
