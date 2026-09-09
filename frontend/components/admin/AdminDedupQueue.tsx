"use client";

/** Очередь подтверждения слияний (T03/R10) — GET/POST /admin/dedup-queue. */

import { useCallback, useEffect, useState } from "react";
import { adminGet, adminPost } from "@/lib/adminApi";
import { useAdminAuth } from "@/lib/hooks/useAdminAuth";
import { useI18n } from "@/lib/hooks/useI18n";
import { ApiError } from "@/lib/api";
import type { DedupCandidate } from "@/lib/types";

export function AdminDedupQueue() {
  const { markVerified, markInvalid } = useAdminAuth();
  const { t } = useI18n();
  const [items, setItems] = useState<DedupCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    adminGet<DedupCandidate[]>("/dedup-queue")
      .then((data) => {
        setItems(data);
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

  async function act(candidate: DedupCandidate, action: "merge" | "new_station") {
    setBusyId(candidate.record_id);
    try {
      await adminPost("/dedup-queue", {
        record_id: candidate.record_id,
        action,
        target_record_id: action === "merge" ? candidate.suggested_record_id : undefined,
      });
      setItems((prev) => prev.filter((c) => c.record_id !== candidate.record_id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("admin.loadError"));
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <p className="p-4 text-sm text-gray-400">{t("loading")}</p>;
  if (error) return <p className="p-4 text-sm text-red-600 dark:text-red-400">{error}</p>;

  return (
    <div className="p-4">
      <h2 className="mb-3 text-lg font-semibold">{t("admin.dedup.title")}</h2>
      {items.length === 0 && <p className="text-sm text-gray-400">{t("admin.dedup.empty")}</p>}
      <ul className="flex flex-col gap-2">
        {items.map((c) => (
          <li key={c.record_id} className="rounded-md border border-gray-200 p-3 text-sm dark:border-gray-800">
            <p className="font-medium text-gray-800 dark:text-gray-200">
              {c.name_raw || "—"} <span className="text-xs text-gray-400">({c.source_name ?? c.source})</span>
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">{c.brand_raw} · {c.address_raw}</p>
            {c.suggested_station_id && (
              <p className="text-xs text-blue-700 dark:text-blue-400">
                {t("admin.dedup.suggested")}: {c.suggested_station_id} ({c.score !== null ? `${Math.round(c.score * 100)}%` : "—"})
              </p>
            )}
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => act(c, "merge")}
                disabled={busyId === c.record_id || !c.suggested_record_id}
                className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
              >
                {t("admin.dedup.merge")}
              </button>
              <button
                type="button"
                onClick={() => act(c, "new_station")}
                disabled={busyId === c.record_id}
                className="rounded-md border border-gray-300 px-3 py-1 text-xs hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-800"
              >
                {t("admin.dedup.newStation")}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
