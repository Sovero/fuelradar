"use client";

/**
 * Покрытие каталога (пост-M16, R58/R94i): сколько АЗС без бренда/телефона/
 * адреса и чем их можно дозаполнить. Только чтение: сам обогащение выполняет
 * штатный инжест (NETWORK_IMPORT_PATH / network_lists), слияние — очередь дедупа.
 */

import { useEffect, useState } from "react";
import { adminGet } from "@/lib/adminApi";
import { useAdminAuth } from "@/lib/hooks/useAdminAuth";
import { useI18n } from "@/lib/hooks/useI18n";
import { ApiError } from "@/lib/api";

type CatalogGapsCandidate = {
  station_id: string;
  station_name: string;
  provider_code: string;
  provider_name: string;
  fields: string[];
};

type CatalogGapsOut = {
  total: number;
  missing: { brand: number; phone: number; address: number; any: number };
  sources: Array<{ code: string; name: string; stations: number; fields: number }>;
  candidates: CatalogGapsCandidate[];
};

function GapCard({ label, value, total }: { label: string; value: number; total: number }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      <p className="text-xs uppercase text-gray-400">{label}</p>
      <p className="text-xl font-semibold text-gray-800 dark:text-gray-200">
        {value} <span className="text-sm font-normal text-gray-400">· {pct}%</span>
      </p>
    </div>
  );
}

const FIELD_KEYS = { brand: true, phone: true, address: true } as const;
type GapField = keyof typeof FIELD_KEYS;

function fieldKey(f: string): `admin.gaps.field.${GapField | "other"}` {
  return `admin.gaps.field.${f in FIELD_KEYS ? (f as GapField) : "other"}` as const;
}

export function AdminCatalogGaps() {
  const { markVerified, markInvalid } = useAdminAuth();
  const { t } = useI18n();
  const [data, setData] = useState<CatalogGapsOut | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminGet<CatalogGapsOut>("/catalog-gaps")
      .then((d) => {
        setData(d);
        markVerified();
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) markInvalid(err.message);
        setError(err instanceof ApiError ? err.message : t("admin.loadError"));
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <p className="p-4 text-sm text-gray-400">{t("loading")}</p>;
  if (error) return <p className="p-4 text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!data) return null;

  return (
    <div className="flex flex-col gap-6 p-4">
      <section>
        <h2 className="mb-2 text-lg font-semibold">{t("admin.gaps.title")}</h2>
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">{t("admin.gaps.subtitle")}</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
            <p className="text-xs uppercase text-gray-400">{t("admin.gaps.total")}</p>
            <p className="text-xl font-semibold text-gray-800 dark:text-gray-200">{data.total}</p>
          </div>
          <GapCard label={t("admin.gaps.noBrand")} value={data.missing.brand} total={data.total} />
          <GapCard label={t("admin.gaps.noPhone")} value={data.missing.phone} total={data.total} />
          <GapCard label={t("admin.gaps.noAddress")} value={data.missing.address} total={data.total} />
          <GapCard label={t("admin.gaps.anyOf")} value={data.missing.any} total={data.total} />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">{t("admin.gaps.sourcesTitle")}</h2>
        {data.sources.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t("admin.gaps.noSources")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs uppercase text-gray-500 dark:border-gray-800">
                  <th className="py-2 pr-3">{t("admin.sources.col.source")}</th>
                  <th className="py-2 pr-3">{t("admin.gaps.col.stations")}</th>
                  <th className="py-2 pr-3">{t("admin.gaps.col.fields")}</th>
                </tr>
              </thead>
              <tbody>
                {data.sources.map((s) => (
                  <tr key={s.code} className="border-b border-gray-100 dark:border-gray-800">
                    <td className="py-2 pr-3">{s.name}</td>
                    <td className="py-2 pr-3">{s.stations}</td>
                    <td className="py-2 pr-3">{s.fields}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">{t("admin.gaps.howTo")}</p>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">{t("admin.gaps.candidatesTitle")}</h2>
        {data.candidates.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t("admin.gaps.noCandidates")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs uppercase text-gray-500 dark:border-gray-800">
                  <th className="py-2 pr-3">{t("admin.gaps.col.station")}</th>
                  <th className="py-2 pr-3">{t("admin.gaps.col.source")}</th>
                  <th className="py-2 pr-3">{t("admin.gaps.col.fillable")}</th>
                </tr>
              </thead>
              <tbody>
                {data.candidates.map((c) => (
                  <tr key={c.station_id} className="border-b border-gray-100 dark:border-gray-800">
                    <td className="py-2 pr-3">
                      {c.station_name || c.station_id}
                      <span className="ml-2 text-xs text-gray-400">{c.station_id}</span>
                    </td>
                    <td className="py-2 pr-3">{c.provider_name}</td>
                    <td className="py-2 pr-3">
                      {c.fields.map((f) => (
                        <span
                          key={f}
                          className="mr-1 inline-block rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                        >
                          {t(fieldKey(f))}
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
