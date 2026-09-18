"use client";

/**
 * Журнал действий администраторов (R67, M16): кто, что и когда менял.
 * `GET /admin/action-log[?action=&limit=&offset=]` — append-only, только чтение.
 * Отличается от журнала загрузок (AdminCollectionLog): там — запуски сбора,
 * здесь — административные действия (merge/split, смена ролей, блокировки,
 * refresh источников, отказы авторизации).
 */

import { useCallback, useEffect, useState } from "react";
import { adminGet } from "@/lib/adminApi";
import { useAdminAuth } from "@/lib/hooks/useAdminAuth";
import { useI18n } from "@/lib/hooks/useI18n";
import { formatUpdatedAt } from "@/lib/format";
import { ApiError } from "@/lib/api";
import type { AdminActionLogPage } from "@/lib/types";

const PAGE_SIZE = 25;

export function AdminActionLogView() {
  const { markVerified, markInvalid } = useAdminAuth();
  const { t } = useI18n();
  const [page, setPage] = useState<AdminActionLogPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [actionFilter, setActionFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    adminGet<AdminActionLogPage>("/action-log", {
      limit: PAGE_SIZE,
      offset,
      action: actionFilter || undefined,
    })
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
  }, [offset, actionFilter, markVerified, markInvalid, t]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="p-4">
      <h2 className="mb-1 text-lg font-semibold">{t("admin.audit.title")}</h2>
      <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">{t("admin.audit.hint")}</p>

      <div className="mb-3 flex items-center gap-2">
        <input
          type="text"
          placeholder={t("admin.audit.filterPlaceholder")}
          value={actionFilter}
          onChange={(e) => {
            setActionFilter(e.target.value);
            setOffset(0);
          }}
          className="w-64 rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
        />
      </div>

      {loading && !page ? (
        <p className="text-sm text-gray-400">{t("loading")}</p>
      ) : error ? (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs uppercase text-gray-500 dark:border-gray-800">
                  <th className="py-2 pr-3">{t("admin.audit.col.when")}</th>
                  <th className="py-2 pr-3">{t("admin.audit.col.actor")}</th>
                  <th className="py-2 pr-3">{t("admin.audit.col.action")}</th>
                  <th className="py-2 pr-3">{t("admin.audit.col.target")}</th>
                  <th className="py-2 pr-3">{t("admin.audit.col.details")}</th>
                </tr>
              </thead>
              <tbody>
                {(page?.items ?? []).map((entry) => (
                  <tr key={entry.id} className="border-b border-gray-100 dark:border-gray-800">
                    <td className="py-2 pr-3 text-gray-500 dark:text-gray-400">{formatUpdatedAt(entry.created_at)}</td>
                    <td className="py-2 pr-3">{entry.actor}</td>
                    <td className="py-2 pr-3 font-medium">{entry.action}</td>
                    <td className="py-2 pr-3 text-gray-500 dark:text-gray-400">
                      {entry.target_type}
                      {entry.target_id ? `#${entry.target_id}` : ""}
                    </td>
                    <td className="py-2 pr-3 text-xs text-gray-500 dark:text-gray-400">
                      {Object.keys(entry.payload).length > 0 ? JSON.stringify(entry.payload) : "—"}
                    </td>
                  </tr>
                ))}
                {page?.items.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-4 text-center text-gray-400">
                      {t("admin.audit.empty")}
                    </td>
                  </tr>
                )}
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
        </>
      )}
    </div>
  );
}
