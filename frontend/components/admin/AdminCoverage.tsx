"use client";

/** Экран покрытия и индекса (R51/R52) — читает фоновые снэпшоты аналитики (T08). */

import { useEffect, useState } from "react";
import { adminGet } from "@/lib/adminApi";
import { useAdminAuth } from "@/lib/hooks/useAdminAuth";
import { useI18n } from "@/lib/hooks/useI18n";
import { ApiError } from "@/lib/api";
import type { CoverageBySourceOut, CoverageOut, DeficitStatsOut, FuelIndexOut } from "@/lib/types";

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      <p className="text-xs uppercase text-gray-400">{label}</p>
      <p className="text-xl font-semibold text-gray-800 dark:text-gray-200">{value}</p>
    </div>
  );
}

export function AdminCoverage() {
  const { markVerified, markInvalid } = useAdminAuth();
  const { t } = useI18n();
  const [coverage, setCoverage] = useState<CoverageOut | null>(null);
  const [bySource, setBySource] = useState<CoverageBySourceOut | null>(null);
  const [fuelIndex, setFuelIndex] = useState<FuelIndexOut | null>(null);
  const [deficit, setDeficit] = useState<DeficitStatsOut | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      adminGet<CoverageOut>("/coverage"),
      adminGet<CoverageBySourceOut>("/coverage-by-source"),
      adminGet<FuelIndexOut>("/fuel-index"),
      adminGet<DeficitStatsOut>("/deficit-stats"),
    ])
      .then(([c, s, f, d]) => {
        setCoverage(c);
        setBySource(s);
        setFuelIndex(f);
        setDeficit(d);
        markVerified();
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) markInvalid(err.message);
        if (err instanceof ApiError && err.status === 503) setError(t("admin.coverage.notReady"));
        else setError(err instanceof ApiError ? err.message : t("admin.loadError"));
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <p className="p-4 text-sm text-gray-400">{t("loading")}</p>;
  if (error) return <p className="p-4 text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!coverage || !bySource || !fuelIndex || !deficit) return null;

  return (
    <div className="flex flex-col gap-6 p-4">
      <section>
        <h2 className="mb-2 text-lg font-semibold">{t("admin.coverage.title")}</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label={t("admin.coverage.discovered")} value={String(coverage.stations_discovered)} />
          <StatCard label={t("admin.coverage.withData")} value={String(coverage.with_fuel_data)} />
          <StatCard label={t("admin.coverage.partial")} value={String(coverage.partial_data)} />
          <StatCard label={t("admin.coverage.percent")} value={coverage.coverage_percent !== null ? `${coverage.coverage_percent}%` : "—"} />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">{t("admin.coverage.bySourceTitle")}</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs uppercase text-gray-500 dark:border-gray-800">
                <th className="py-2 pr-3">{t("admin.sources.col.source")}</th>
                <th className="py-2 pr-3">{t("admin.coverage.recordsBefore")}</th>
                <th className="py-2 pr-3">{t("admin.coverage.uniqueStations")}</th>
              </tr>
            </thead>
            <tbody>
              {bySource.sources.map((s) => (
                <tr key={s.code} className="border-b border-gray-100 dark:border-gray-800">
                  <td className="py-2 pr-3">{s.name}</td>
                  <td className="py-2 pr-3">{s.records_before_dedup}</td>
                  <td className="py-2 pr-3">{s.unique_stations}</td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="py-2 pr-3">{t("admin.coverage.afterDedup")}</td>
                <td />
                <td className="py-2 pr-3">{bySource.unique_stations_after_dedup}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">{t("admin.coverage.fuelIndexTitle")}</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {fuelIndex.items.map((item) => (
            <StatCard key={item.fuel} label={item.fuel} value={item.index !== null ? `${item.index}/100` : "—"} />
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">{t("admin.coverage.deficitTitle")}</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs uppercase text-gray-500 dark:border-gray-800">
                <th className="py-2 pr-3">{t("filters.brand")}</th>
                <th className="py-2 pr-3">{t("station.fuelHeading")}</th>
                <th className="py-2 pr-3">{t("admin.coverage.outages")}</th>
                <th className="py-2 pr-3">{t("admin.coverage.meanAbsence")}</th>
              </tr>
            </thead>
            <tbody>
              {deficit.items.map((d, i) => (
                <tr key={i} className="border-b border-gray-100 dark:border-gray-800">
                  <td className="py-2 pr-3">{d.brand}</td>
                  <td className="py-2 pr-3">{d.fuel}</td>
                  <td className="py-2 pr-3">{d.completed_outages}</td>
                  <td className="py-2 pr-3">{d.mean_absence_minutes !== null ? `${Math.round(d.mean_absence_minutes)} мин` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
