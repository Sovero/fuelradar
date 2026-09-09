"use client";

import { useMemo, useState } from "react";
import { FiltersProvider, useFilters } from "@/lib/hooks/useFilters";
import { useMeta } from "@/lib/hooks/useMeta";
import { useAuth } from "@/lib/hooks/useAuth";
import { useI18n } from "@/lib/hooks/useI18n";
import { useStations } from "@/lib/hooks/useStations";
import { useFavorites } from "@/lib/hooks/useFavorites";
import { useObservationMode } from "@/lib/hooks/useObservationMode";
import { useNetworkPreferences } from "@/lib/hooks/useNetworkPreferences";
import { countConfirmed } from "@/lib/availability";
import { applyObservationMode, applyPreferredBrandsOrder } from "@/lib/personalization";
import { apiPost, ApiError } from "@/lib/api";
import { Header } from "@/components/layout/Header";
import { TopControls } from "@/components/layout/TopControls";
import { FuelQuickFilters } from "@/components/layout/FuelQuickFilters";
import { Tabs } from "@/components/layout/Tabs";
import { LoginPanel } from "@/components/layout/LoginPanel";
import { FiltersPanel } from "@/components/filters/FiltersPanel";
import { MapView } from "@/components/map/MapView";
import { StationList } from "@/components/station/StationList";
import { StationCard } from "@/components/station/StationCard";
import { FavoritesPanel } from "@/components/favorites/FavoritesPanel";
import { EmptyState } from "@/components/ui/EmptyState";
import { OnboardingTour } from "@/components/onboarding/OnboardingTour";
import type { StationListQuery } from "@/lib/types";

export function HomeScreen() {
  return (
    <FiltersProvider>
      <HomeScreenBody />
    </FiltersProvider>
  );
}

function HomeScreenBody() {
  const { filters, setFilters } = useFilters();
  const { user } = useAuth();
  const { fuelLabel, meta } = useMeta();
  const { t } = useI18n();
  const [loginOpen, setLoginOpen] = useState(false);
  const [alertBusy, setAlertBusy] = useState(false);
  const [alertCreated, setAlertCreated] = useState(false);
  const [alertError, setAlertError] = useState<string | null>(null);

  const { preferredBrandIds } = useNetworkPreferences();
  const preferredBrandsParam = preferredBrandIds.length ? [...preferredBrandIds].sort((a, b) => a - b).join(",") : undefined;

  const query: StationListQuery = useMemo(
    () => ({
      lat: filters.lat ?? undefined,
      lon: filters.lon ?? undefined,
      radius_km: filters.lat !== null ? filters.radiusKm : undefined,
      brand: filters.brand ?? undefined,
      fuel: filters.fuels.length === 1 ? filters.fuels[0] : undefined,
      status: filters.status ?? undefined,
      confidence_min: filters.confidenceMin ?? undefined,
      queue_max: filters.queueMax ?? undefined,
      sort: filters.sort ?? undefined,
      limit: 100,
      preferred_brands: preferredBrandsParam,
    }),
    [filters.lat, filters.lon, filters.radiusKm, filters.brand, filters.fuels, filters.status, filters.confidenceMin, filters.queueMax, filters.sort, preferredBrandsParam],
  );

  const { stations, loading, error, isStale } = useStations(query);
  const { favorites } = useFavorites();
  const { settings: observationSettings } = useObservationMode();
  // Backend уже учёл preferred_brands в score (см. query выше) — этот буст остаётся
  // запасным для сортировок, где score не участвует (напр. sort=distance).
  const preferredBrandNames = useMemo(() => {
    if (preferredBrandIds.length === 0 || !meta) return [];
    const ids = new Set(preferredBrandIds);
    return meta.station_brands.filter((b) => ids.has(b.id)).map((b) => b.name);
  }, [preferredBrandIds, meta]);

  const searched = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    if (!q) return stations;
    return stations.filter(
      (s) => s.name.toLowerCase().includes(q) || s.address.toLowerCase().includes(q) || (s.brand ?? "").toLowerCase().includes(q),
    );
  }, [stations, filters.search]);

  // Режим наблюдения (R25) + предпочтения сетей (R77) — персональные настройки
  // поверх уже отфильтрованного/отсортированного API-ответа (см. lib/personalization.ts).
  const favoriteIds = useMemo(() => new Set(favorites.map((f) => f.id)), [favorites]);
  const personalized = useMemo(() => {
    const observed = applyObservationMode(searched, observationSettings, favoriteIds);
    return applyPreferredBrandsOrder(observed, preferredBrandNames);
  }, [searched, observationSettings, favoriteIds, preferredBrandNames]);

  const confirmedCount = countConfirmed(searched, filters.fuels, filters.includeLikely);
  const isSearchingFuel = filters.fuels.length > 0;
  const isEmpty = isSearchingFuel && !loading && confirmedCount === 0;

  async function handleCreateAlert() {
    if (!user) {
      setLoginOpen(true);
      return;
    }
    setAlertBusy(true);
    setAlertError(null);
    try {
      await apiPost("/alerts", {
        name: "Следить по фильтрам",
        fuel_code: filters.fuels[0] ?? null,
        distance_km: filters.radiusKm,
        confidence_min: filters.confidenceMin,
        queue_max: filters.queueMax,
        scope: filters.lat !== null ? { type: "zone", lat: filters.lat, lon: filters.lon, radius_km: filters.radiusKm } : { type: "favorites" },
      });
      setAlertCreated(true);
    } catch (err) {
      setAlertError(err instanceof ApiError ? err.message : "Не удалось создать уведомление");
    } finally {
      setAlertBusy(false);
    }
  }

  const focus = filters.lat !== null && filters.lon !== null ? { lat: filters.lat, lon: filters.lon } : null;
  const fuelLabelText = filters.fuels.length ? filters.fuels.map(fuelLabel).join(" / ") : "топлива";

  return (
    <div className="flex h-dvh flex-col bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <Header />
      <TopControls />
      <FuelQuickFilters />
      <Tabs />
      <FiltersPanel />

      {error && !isStale && <p className="px-4 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {isStale && <p className="bg-amber-50 px-4 py-1 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">{t("error.stale")}</p>}

      <main className="relative flex-1 overflow-hidden" data-tour="map">
        {isEmpty ? (
          <div className="h-full overflow-y-auto p-4">
            <EmptyState
              radiusKm={filters.radiusKm}
              fuelLabel={fuelLabelText}
              likelyShown={filters.includeLikely}
              alertBusy={alertBusy}
              alertCreated={alertCreated}
              onExpandRadius={(extra) => setFilters({ radiusKm: filters.radiusKm + extra })}
              onShowLikely={() => setFilters({ includeLikely: true })}
              onCreateAlert={handleCreateAlert}
            />
            {alertError && <p className="mt-2 text-center text-sm text-red-600">{alertError}</p>}
          </div>
        ) : (
          <>
            {filters.tab === "map" && (
              <MapView
                stations={personalized}
                selectedFuelCodes={filters.fuels}
                selectedStationId={filters.station}
                onSelectStation={(id) => setFilters({ station: id })}
                focus={focus}
              />
            )}
            {filters.tab === "list" && <StationList stations={personalized} onSelect={(id) => setFilters({ station: id })} />}
            {filters.tab === "favorites" && <FavoritesPanel onSelect={(id) => setFilters({ station: id })} />}
            {loading && (
              <p className="absolute left-1/2 top-2 -translate-x-1/2 rounded-full bg-white/90 px-3 py-1 text-xs text-gray-500 shadow dark:bg-gray-800/90 dark:text-gray-300">
                {t("loading")}
              </p>
            )}
          </>
        )}

        {filters.station && (
          <StationCard stationId={filters.station} lat={filters.lat} lon={filters.lon} onClose={() => setFilters({ station: null })} />
        )}
      </main>

      {loginOpen && <LoginPanel onClose={() => setLoginOpen(false)} />}
      <OnboardingTour />
    </div>
  );
}
