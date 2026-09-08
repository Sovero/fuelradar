"use client";

import { useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/hooks/useAuth";
import { useI18n } from "@/lib/hooks/useI18n";
import type { StationBrief } from "@/lib/types";

/** «В избранное» (R26/R30) — требует профиль (R65); анонимному пользователю предлагаем войти. */
export function FavoriteButton({ stationId, onRequireLogin }: { stationId: string; onRequireLogin: () => void }) {
  const { user } = useAuth();
  const { t } = useI18n();
  const [isFavorite, setIsFavorite] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) {
      setIsFavorite(null);
      return;
    }
    let cancelled = false;
    apiGet<StationBrief[]>("/favorites")
      .then((rows) => {
        if (!cancelled) setIsFavorite(rows.some((r) => r.id === stationId));
      })
      .catch(() => {
        if (!cancelled) setIsFavorite(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, stationId]);

  async function toggle() {
    if (!user) {
      onRequireLogin();
      return;
    }
    setBusy(true);
    try {
      if (isFavorite) {
        await apiDelete(`/favorites/${encodeURIComponent(stationId)}`);
        setIsFavorite(false);
      } else {
        await apiPost(`/favorites/${encodeURIComponent(stationId)}`);
        setIsFavorite(true);
      }
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        // тихо игнорируем — кнопка не должна ронять карточку
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-pressed={isFavorite === true}
      className={`flex-1 rounded-md border px-3 py-2 text-sm font-semibold ${
        isFavorite
          ? "border-amber-500 bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
          : "border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
      }`}
    >
      {isFavorite ? `★ ${t("station.favorite.added")}` : `☆ ${t("station.favorite.add")}`}
    </button>
  );
}
