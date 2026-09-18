"use client";

/**
 * Экран источников (R58): «Источник / Состояние / Последний запрос / Ошибки»
 * + «обновить сейчас» (R53.1/R58.1) — ставит задание воркеру, не собирает
 * синхронно (R83, `POST /admin/sources/{id}/refresh`).
 */

import { Fragment, useCallback, useEffect, useState } from "react";
import { adminGet, adminPatch, adminPost } from "@/lib/adminApi";
import { useAdminAuth } from "@/lib/hooks/useAdminAuth";
import { useI18n } from "@/lib/hooks/useI18n";
import { formatUpdatedAt } from "@/lib/format";
import { ApiError } from "@/lib/api";
import type { AdminSourceOut } from "@/lib/types";

const SOURCE_STATUSES = ["ACTIVE", "RESEARCH_REQUIRED", "NOT_USED"] as const;

const HEALTH_COLOR: Record<string, string> = {
  OK: "text-emerald-700 dark:text-emerald-400",
  DEGRADED: "text-amber-700 dark:text-amber-400",
  DOWN: "text-red-700 dark:text-red-400",
  UNKNOWN: "text-gray-400",
};

export function AdminSourcesTable() {
  const { markVerified, markInvalid, isAdmin } = useAdminAuth();
  const { t } = useI18n();
  const [sources, setSources] = useState<AdminSourceOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTrust, setEditTrust] = useState("");
  const [editStatus, setEditStatus] = useState("ACTIVE");
  const [editInterval, setEditInterval] = useState("");
  const [saving, setSaving] = useState(false);

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

  function startEdit(s: AdminSourceOut) {
    setEditingId(s.id);
    setEditTrust(String(s.trust));
    setEditStatus(s.status);
    setEditInterval(String(s.min_interval_minutes));
    setNotice(null);
  }

  async function saveEdit() {
    if (editingId === null) return;
    const trust = Number(editTrust);
    const interval = Number(editInterval);
    if (editTrust.trim() === "" || editInterval.trim() === "" || Number.isNaN(trust) || Number.isNaN(interval)) {
      setNotice(t("admin.sources.invalidNumber"));
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const res = await adminPatch<{ changed: boolean }>(`/sources/${editingId}`, {
        trust,
        status: editStatus,
        min_interval_minutes: interval,
      });
      setNotice(res.changed ? t("admin.sources.saved") : t("admin.sources.noChanges"));
      setEditingId(null);
      load();
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : t("admin.loadError"));
    } finally {
      setSaving(false);
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
              <th className="py-2 pr-3">{t("admin.sources.col.trust")}</th>
              <th className="py-2 pr-3" />
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <Fragment key={s.id}>
              <tr className="border-b border-gray-100 dark:border-gray-800">
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
                <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">
                  {s.trust.toFixed(2)} · {s.min_interval_minutes} мин
                </td>
                <td className="py-2 pr-3">
                  {isAdmin ? (
                    <button
                      type="button"
                      onClick={() => (editingId === s.id ? setEditingId(null) : startEdit(s))}
                      className="mr-2 rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
                    >
                      {editingId === s.id ? t("admin.sources.edit.cancel") : t("admin.sources.edit")}
                    </button>
                  ) : null}
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => refresh(s.id)}
                      disabled={refreshingId === s.id || s.status !== "ACTIVE"}
                      title={s.status !== "ACTIVE" ? t("admin.sources.notActive") : undefined}
                      className="rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-800"
                    >
                      {refreshingId === s.id ? t("admin.sources.refreshing") : t("admin.sources.refreshNow")}
                    </button>
                  )}
                </td>
              </tr>
              {editingId === s.id && (
                <tr className="border-b border-gray-100 bg-gray-50 dark:border-gray-800 dark:bg-gray-800/40">
                  <td colSpan={6} className="py-3 pr-3">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <label className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                        {t("admin.sources.col.trust")}
                        <input
                          type="number"
                          min={0}
                          max={1}
                          step={0.05}
                          value={editTrust}
                          onChange={(e) => setEditTrust(e.target.value)}
                          className="w-20 rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800"
                        />
                      </label>
                      <label className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                        {t("admin.sources.col.status")}
                        <select
                          value={editStatus}
                          onChange={(e) => setEditStatus(e.target.value)}
                          className="rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800"
                        >
                          {SOURCE_STATUSES.map((st) => (
                            <option key={st} value={st}>{st}</option>
                          ))}
                        </select>
                      </label>
                      <label className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                        {t("admin.sources.col.interval")}
                        <input
                          type="number"
                          min={1}
                          step={5}
                          value={editInterval}
                          onChange={(e) => setEditInterval(e.target.value)}
                          className="w-24 rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800"
                        />
                      </label>
                      <button
                        type="button"
                        onClick={saveEdit}
                        disabled={saving}
                        className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
                      >
                        {saving ? t("admin.sources.saving") : t("admin.sources.save")}
                      </button>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
