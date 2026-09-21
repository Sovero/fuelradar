"use client";

import { useFavorites } from "@/lib/hooks/useFavorites";
import { useFilters } from "@/lib/hooks/useFilters";
import { useI18n } from "@/lib/hooks/useI18n";
import { StationList } from "@/components/station/StationList";
import { FavoriteRulesBar } from "@/components/favorites/FavoriteRulesBar";

/** Вкладка «Избранное» (R26) — один общий список приложения; пустое избранное подсказывает найти станцию (R26.1). */
export function FavoritesPanel({ onSelect }: { onSelect: (id: string) => void }) {
  const { favorites, loading, error } = useFavorites();
  const { setFilters } = useFilters();
  const { t } = useI18n();

  if (loading) return <p className="p-4 text-sm text-gray-400">{t("loading.favorites")}</p>;
  if (error) return <p className="p-4 text-sm text-red-600 dark:text-red-400">{error}</p>;

  if (favorites.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 p-6 text-center">
        <p className="text-gray-600 dark:text-gray-400">{t("favorites.empty")}</p>
        <button
          type="button"
          onClick={() => setFilters({ tab: "map" })}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
        >
          {t("favorites.findStation")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <FavoriteRulesBar favorites={favorites} />
      <div className="flex-1 overflow-hidden">
        <StationList stations={favorites} onSelect={onSelect} />
      </div>
    </div>
  );
}
