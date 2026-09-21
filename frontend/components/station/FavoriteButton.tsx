"use client";

import { useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { useI18n } from "@/lib/hooks/useI18n";

/** «В избранное» (R26/R30) — один общий список приложения, вход не нужен. */
export function FavoriteButton({ stationId }: { stationId: string }) {
  const { t } = useI18n();
  const [isFavorite, setIsFavorite] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiGet<{ id: string }[]>("/favorites")
      .then((rows) => {
        if (!cancelled) setIsFavorite(rows.some((r) => r.id === stationId));
      })
      .catch(() => {
        if (!cancelled) setIsFavorite(false);
      });
    return () => {
      cancelled = true;
    };
  }, [stationId]);

  async function toggle() {
    setBusy(true);
    try {
      if (isFavorite) {
        await apiDelete(`/favorites/${encodeURIComponent(stationId)}`);
        setIsFavorite(false);
      } else {
        await apiPost(`/favorites/${encodeURIComponent(stationId)}`);
        setIsFavorite(true);
      }
    } catch {
      // тихо игнорируем — кнопка не должна ронять карточку
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
