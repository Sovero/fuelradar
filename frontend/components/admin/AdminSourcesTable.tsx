"use client";

/**
 * Экран источников (R58): «Источник / Состояние / Последний запрос / Ошибки»
 * + «обновить сейчас» (R53.1/R58.1) — ставит задание воркеру, не собирает
 * синхронно (R83, `POST /admin/sources/{id}/refresh`).
 *
 * Внизу — пополняемый список URL сетевых списков АЗС (GET/PUT
 * /admin/sources/network-lists): хранится в БД, .env — только стартовый дефолт.
 * Адаптер читает список при каждом запуске сбора, поэтому добавленная ссылка
 * подхватывается следующим тиком воркера без перезапуска.
 */

import { Fragment, useCallback, useEffect, useState } from "react";
import { adminGet, adminPatch, adminPost, adminPut } from "@/lib/adminApi";
import { useAdminAuth } from "@/lib/hooks/useAdminAuth";
import { useI18n } from "@/lib/hooks/useI18n";
import { formatUpdatedAt, formatUtcDateTime } from "@/lib/format";
import { ApiError } from "@/lib/api";
import type { AdminSourceOut } from "@/lib/types";

const SOURCE_STATUSES = ["ACTIVE", "RESEARCH_REQUIRED", "NOT_USED"] as const;

const HEALTH_COLOR: Record<string, string> = {
  OK: "text-emerald-700 dark:text-emerald-400",
  DEGRADED: "text-amber-700 dark:text-amber-400",
  DOWN: "text-red-700 dark:text-red-400",
  UNKNOWN: "text-gray-400",
};

interface NetworkListsState {
  urls: string[];
  source: "db" | "env";
}

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

  const [networkLists, setNetworkLists] = useState<NetworkListsState | null>(null);
  const [nlText, setNlText] = useState("");
  const [nlSaving, setNlSaving] = useState(false);
  const [nlNotice, setNlNotice] = useState<string | null>(null);
  const [nlError, setNlError] = useState<string | null>(null);

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

  useEffect(() => {
    adminGet<NetworkListsState>("/sources/network-lists")
      .then((data) => {
        setNetworkLists(data);
        setNlText(data.urls.join("\n"));
        setNlError(null);
      })
      .catch((err: unknown) => setNlError(err instanceof ApiError ? err.message : t("admin.loadError")));
  }, [t]);

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

  async function saveNetworkLists() {
    setNlSaving(true);
    setNlNotice(null);
    setNlError(null);
    try {
      const urls = nlText
        .split(/[\n;]+/)
        .map((u) => u.trim())
        .filter(Boolean);
      const res = await adminPut<NetworkListsState & { count: number; previous_count: number; activated: boolean; job_id: number | null }>(
        "/sources/network-lists",
        { urls },
      );
      setNetworkLists({ urls: res.urls, source: res.source });
      setNlText(res.urls.join("\n"));
      if (res.source === "env") {
        setNlNotice(t("admin.sources.networkLists.defaultRestored"));
      } else if (res.activated) {
        setNlNotice(t("admin.sources.networkLists.savedActivated").replace("{count}", String(res.count)));
      } else {
        setNlNotice(t("admin.sources.networkLists.saved").replace("{count}", String(res.count)));
      }
      load();
    } catch (err) {
      setNlError(err instanceof ApiError ? err.message : t("admin.loadError"));
    } finally {
      setNlSaving(false);
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
                  {/* R58: у файловых источников видно, какой именно файл читается и
                      когда он обновлялся — иначе это выясняют по «джоба упала». */}
                  {s.file && (
                    <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                      {t("admin.sources.file")}{" "}
                      <span className="break-all font-mono" title={s.file.path}>{s.file.path}</span>
                      {" · "}
                      {s.file.exists ? (
                        <span title={formatUtcDateTime(s.file.modified_at) ?? undefined}>
                          {t("admin.sources.fileUpdated").replace("{time}", formatUpdatedAt(s.file.modified_at))}
                        </span>
                      ) : (
                        <span>{t("admin.sources.fileMissing")}</span>
                      )}
                      {s.file.explicit && <> · {t("admin.sources.fileExplicit")}</>}
                    </p>
                  )}
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

      {/* Пополняемый список URL сетевых списков АЗС: БД поверх .env-дефолта,
          подхватывается следующим тиком воркера (адаптер читает список лениво). */}
      <section className="mt-6 border-t border-gray-200 pt-4 dark:border-gray-800">
        <h3 className="text-base font-semibold">{t("admin.sources.networkLists.title")}</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {t("admin.sources.networkLists.hint")}
        </p>
        {networkLists && (
          <p className="mt-1 text-xs text-gray-400">
            {networkLists.source === "db"
              ? t("admin.sources.networkLists.fromDb").replace("{count}", String(networkLists.urls.length))
              : t("admin.sources.networkLists.fromEnv").replace("{count}", String(networkLists.urls.length))}
          </p>
        )}
        {nlNotice && <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">{nlNotice}</p>}
        {nlError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{nlError}</p>}
        <textarea
          value={nlText}
          onChange={(e) => setNlText(e.target.value)}
          rows={5}
          spellCheck={false}
          placeholder={"https://example.com/stations.json\nhttps://example2.ru/azs.csv"}
          className="mt-2 w-full max-w-3xl rounded-md border border-gray-300 px-3 py-2 font-mono text-xs dark:border-gray-700 dark:bg-gray-800"
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={saveNetworkLists}
            disabled={nlSaving}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
          >
            {nlSaving ? t("common.saving") : t("admin.sources.networkLists.save")}
          </button>
          <span className="text-xs text-gray-400">{t("admin.sources.networkLists.formats")}</span>
        </div>
      </section>
    </div>
  );
}
