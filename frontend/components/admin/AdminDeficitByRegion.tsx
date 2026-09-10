"use client";

/** R79: районы дефицита — те же TTL-censored агрегаты по city/region (R47),
 * с размером выборки и честным предупреждением о пилотном объёме (R79.1). */

import { useEffect, useState } from "react";
import { adminGet } from "@/lib/adminApi";
import { useAdminAuth } from "@/lib/hooks/useAdminAuth";
import { useI18n } from "@/lib/hooks/useI18n";
import { ApiError } from "@/lib/api";
import type { DeficitByRegionOut } from "@/lib/types";

export function AdminDeficitByRegion() {
  const { markVerified, markInvalid } = useAdminAuth();
  const { t } = useI18n();
  const [dimension, setDimension] = useState<"city" | "region">("city");
  const [data, setData] = useState<DeficitByRegionOut | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    adminGet<DeficitByRegionOut>("/deficit-by-region", { dimension })
      .then((response) => {
        setData(response);
        markVerified();
      })
      .catch((err: unknown) => {
        setData(null);
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) markInvalid(err.message);
        else if (err instanceof ApiError && err.status === 503) setError(t("admin.coverage.notReady"));
        else setError(err instanceof ApiError ? err.message : t("admin.loadError"));
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimension]);

  if (loading) return <p className="p-4 text-sm text-gray-400">{t("loading")}</p>;
  if (error) return <p className="p-4 text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!data) return null;

  return (
    <section className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{t("admin.bi.title")}</h2>
        <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
          {t("admin.bi.dimension")}
          <select
            value={dimension}
            onChange={(event) => setDimension(event.target.value as "city" | "region")}
            className="rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
          >
            <option value="city">{t("admin.bi.byCity")}</option>
            <option value="region">{t("admin.bi.byRegion")}</option>
          </select>
        </label>
      </div>

      <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
        {t("admin.bi.pilotWarning")}
      </p>

      {data.items.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t("admin.bi.empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs uppercase text-gray-500 dark:border-gray-800">
                <th className="py-2 pr-3">{t(data.dimension === "city" ? "admin.bi.col.area" : "admin.bi.col.area")}</th>
                <th className="py-2 pr-3">{t("admin.bi.col.fuel")}</th>
                <th className="py-2 pr-3">{t("admin.bi.col.streams")}</th>
                <th className="py-2 pr-3">{t("admin.bi.col.stations")}</th>
                <th className="py-2 pr-3">{t("admin.bi.col.outages")}</th>
                <th className="py-2 pr-3">{t("admin.bi.col.meanAbsence")}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item, index) => (
                <tr key={index} className="border-b border-gray-100 dark:border-gray-800">
                  <td className="py-2 pr-3">{item.city ?? item.region ?? "—"}</td>
                  <td className="py-2 pr-3">{item.fuel}</td>
                  <td className="py-2 pr-3">{item.observed_source_streams}</td>
                  <td className="py-2 pr-3">{item.stations_observed}</td>
                  <td className="py-2 pr-3">{item.completed_outages}</td>
                  <td className="py-2 pr-3">
                    {item.mean_absence_minutes !== null ? Math.round(item.mean_absence_minutes) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
