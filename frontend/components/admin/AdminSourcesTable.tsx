"use client";

/**
 * Экран источников (R58): «Источник / Состояние / Последний запрос / Ошибки»
 * + «обновить сейчас» (R53.1/R58.1) — ставит задание воркеру, не собирает
 * синхронно (R83, `POST /admin/sources/{id}/refresh`).
 */

import { useCallback, useEffect, useState } from "react";
import { adminGet, adminPost } from "@/lib/adminApi";
import { useAdminAuth } from "@/lib/hooks/useAdminAuth";
import { useI18n } from "@/lib/hooks/useI18n";
import { formatUpdatedAt } from "@/lib/format";
import { ApiError } from "@/lib/api";
import type { AdminSourceOut } from "@/lib/types";

const HEALTH_COLOR: Record<string, string> = {
  OK: "text-emerald-700 dark:text-emerald-400",
  DEGRADED: "text-amber-700 dark:text-amber-400",
  DOWN: "text-red-700 dark:text-red-400",
  UNKNOWN: "text-gray-400",
};

export function AdminSourcesTable() {
  const { markVerified, markInvalid } = useAdminAuth();
  const { t } = useI18n();
  const [sources, setSources] = useState<AdminSourceOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    adminGet<AdminSourceOut[]>("/sources")
      .then((data) => {
        setSources(data);
        setError(null);
        markVerified();
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) markInvalid(err.message);
        setError(err instanceof ApiError ? err.message : t("admin.loadError"));
      })
      .finally(() => setLoading(false));
  }, [markVerified, markInvalid, t]);

  useEffect(() => {
    load();
  }, [load]);

  async function refresh(id: number) {
    setRefreshingId(id);
    setNotice(null);
    try {
      const res = await adminPost<{ job_id: number; status: string }>(`/sources/${id}/refresh`);
      setNotice(t("admin.sources.refreshQueued").replace("{status}", res.status));
      load();
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : t("admin.loadError"));
    } finally {
      setRefreshingId(null);
    }
  }

  if (loading) return <p className="p-4 text-sm text-gray-400">{t("loading")}</p>;
  if (error) return <p className="p-4 text-sm text-red-600 dark:text-red-400">{error}</p>;

  return (
    <div className="p-4">
      <h2 className="mb-3 text-lg font-semibold">{t("admin.sources.title")}</h2>
      {notice && <p className="mb-2 text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs uppercase text-gray-500 dark:border-gray-800">
              <th className="py-2 pr-3">{t("admin.sources.col.source")}</th>
              <th className="py-2 pr-3">{t("admin.sources.col.state")}</th>
              <th className="py-2 pr-3">{t("admin.sources.col.lastRequest")}</th>
              <th className="py-2 pr-3">{t("admin.sources.col.errors")}</th>
              <th className="py-2 pr-3" />
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.id} className="border-b border-gray-100 dark:border-gray-800">
                <td className="py-2 pr-3">
                  <p className="font-medium text-gray-800 dark:text-gray-200">{s.name}</p>
                  <p className="text-xs text-gray-400">{s.code} · {s.status}</p>
                </td>
                <td className={`py-2 pr-3 font-medium ${HEALTH_COLOR[s.health.state] ?? "text-gray-500"}`}>{s.health.state}</td>
                <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">
                  {s.health.last_check_at ? formatUpdatedAt(s.health.last_check_at) : t("admin.sources.never")}
                </td>
                <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">
                  {s.health.consecutive_failures > 0 ? (
                    <span title={s.health.last_error}>
                      {s.health.consecutive_failures} · {s.health.last_error || t("admin.sources.errorUnknown")}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="py-2 pr-3">
                  <button
                    type="button"
                    onClick={() => refresh(s.id)}
                    disabled={refreshingId === s.id || s.status !== "ACTIVE"}
                    title={s.status !== "ACTIVE" ? t("admin.sources.notActive") : undefined}
                    className="rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-800"
                  >
                    {refreshingId === s.id ? t("admin.sources.refreshing") : t("admin.sources.refreshNow")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
