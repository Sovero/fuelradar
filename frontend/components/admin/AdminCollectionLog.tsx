"use client";

/**
 * Журнал загрузок (R104): история запусков сбора — ручных и по расписанию.
 * `GET /admin/collection-log[?provider_id=&limit=&offset=]` + построчные
 * сообщения запуска при разворачивании строки (`GET /admin/collection-log/{id}/details`).
 */

import { Fragment, useCallback, useEffect, useState } from "react";
import { adminGet } from "@/lib/adminApi";
import { useAdminAuth } from "@/lib/hooks/useAdminAuth";
import { useI18n } from "@/lib/hooks/useI18n";
import { formatUpdatedAt } from "@/lib/format";
import { ApiError } from "@/lib/api";
import type { CollectionLogDetail, CollectionLogPage } from "@/lib/types";

const PAGE_SIZE = 25;

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "DONE" || status === "SUCCESS"
      ? "text-emerald-700 dark:text-emerald-400"
      : status === "FAILED"
        ? "text-red-700 dark:text-red-400"
        : "text-gray-500";
  return <span className={cls}>{status}</span>;
}

function DetailsRow({ jobId }: { jobId: number }) {
  const { t } = useI18n();
  const [details, setDetails] = useState<CollectionLogDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminGet<CollectionLogDetail[]>(`/collection-log/${jobId}/details`)
      .then(setDetails)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : t("admin.loadError")));
  }, [jobId, t]);

  if (error) return <p className="px-4 py-2 text-xs text-red-600 dark:text-red-400">{error}</p>;
  if (!details) return <p className="px-4 py-2 text-xs text-gray-400">{t("loading")}</p>;
  if (details.length === 0) return <p className="px-4 py-2 text-xs text-gray-400">{t("admin.log.noDetails")}</p>;

  return (
    <ul className="bg-gray-50 px-4 py-2 text-xs dark:bg-gray-900/60">
      {details.map((d, i) => (
        <li key={i} className="border-b border-gray-100 py-1 last:border-b-0 dark:border-gray-800">
          <span className="text-gray-400">{formatUpdatedAt(d.created_at)}</span> · <span className="font-medium">{d.level}</span> — {d.message}
        </li>
      ))}
    </ul>
  );
}

export function AdminCollectionLog() {
  const { markVerified, markInvalid } = useAdminAuth();
  const { t } = useI18n();
  const [page, setPage] = useState<CollectionLogPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    adminGet<CollectionLogPage>("/collection-log", { limit: PAGE_SIZE, offset })
      .then((data) => {
        setPage(data);
        setError(null);
        markVerified();
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) markInvalid(err.message);
        setError(err instanceof ApiError ? err.message : t("admin.loadError"));
      })
      .finally(() => setLoading(false));
  }, [offset, markVerified, markInvalid, t]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && !page) return <p className="p-4 text-sm text-gray-400">{t("loading")}</p>;
  if (error) return <p className="p-4 text-sm text-red-600 dark:text-red-400">{error}</p>;

  return (
    <div className="p-4">
      <h2 className="mb-3 text-lg font-semibold">{t("admin.log.title")}</h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs uppercase text-gray-500 dark:border-gray-800">
              <th className="py-2 pr-3">{t("admin.log.col.source")}</th>
              <th className="py-2 pr-3">{t("admin.log.col.type")}</th>
              <th className="py-2 pr-3">{t("admin.log.col.trigger")}</th>
              <th className="py-2 pr-3">{t("admin.log.col.status")}</th>
              <th className="py-2 pr-3">{t("admin.log.col.records")}</th>
              <th className="py-2 pr-3">{t("admin.log.col.started")}</th>
            </tr>
          </thead>
          <tbody>
            {(page?.items ?? []).map((item) => (
              <Fragment key={item.id}>
                <tr
                  className="cursor-pointer border-b border-gray-100 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/60"
                  onClick={() => setExpanded((prev) => (prev === item.id ? null : item.id))}
                >
                  <td className="py-2 pr-3">{item.provider_name ?? item.provider_code ?? "—"}</td>
                  <td className="py-2 pr-3">{item.job_type}</td>
                  <td className="py-2 pr-3">{item.trigger}</td>
                  <td className="py-2 pr-3"><StatusBadge status={item.status} /></td>
                  <td className="py-2 pr-3">
                    {item.records_count ?? 0}
                    {item.error_count ? <span className="text-red-600 dark:text-red-400"> · {item.error_count} {t("admin.log.errors")}</span> : null}
                  </td>
                  <td className="py-2 pr-3 text-gray-500 dark:text-gray-400">{item.started_at ? formatUpdatedAt(item.started_at) : "—"}</td>
                </tr>
                {expanded === item.id && (
                  <tr>
                    <td colSpan={6} className="p-0">
                      <DetailsRow jobId={item.id} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center justify-between text-sm">
        <button
          type="button"
          onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
          disabled={offset === 0}
          className="rounded-md border border-gray-300 px-2 py-1 disabled:opacity-40 dark:border-gray-700"
        >
          {t("admin.log.prevPage")}
        </button>
        <span className="text-gray-400">{t("admin.log.total")}: {page?.total ?? 0}</span>
        <button
          type="button"
          onClick={() => setOffset((o) => o + PAGE_SIZE)}
          disabled={!page || offset + PAGE_SIZE >= page.total}
          className="rounded-md border border-gray-300 px-2 py-1 disabled:opacity-40 dark:border-gray-700"
        >
          {t("admin.log.nextPage")}
        </button>
      </div>
    </div>
  );
}
