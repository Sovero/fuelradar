"use client";

import { useMemo, useState } from "react";
import { FiltersProvider, useFilters } from "@/lib/hooks/useFilters";
import { useMeta } from "@/lib/hooks/useMeta";
import { useAuth } from "@/lib/hooks/useAuth";
import { useI18n } from "@/lib/hooks/useI18n";
import { useStations } from "@/lib/hooks/useStations";
import { useRouteStations } from "@/lib/hooks/useRouteStations";
import { useHeat } from "@/lib/hooks/useHeat";
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
import { RouteModePanel } from "@/components/route/RouteModePanel";
import { HEAT_COLORS, heatLevelFor } from "@/lib/heatmap";
import type { MapHeatCircle, MapPoint } from "@/lib/map/types";
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
  const [routeActive, setRouteActive] = useState(false);
  const [routePoints, setRoutePoints] = useState<MapPoint[]>([]);
  const [routeCorridorKm, setRouteCorridorKm] = useState(5);
  const [isHeatmapOn, setIsHeatmapOn] = useState(false);

  // R50: heatmap включается отдельно и читает только снэпшот аналитики;
  // сбой/пустой кэш не ломает карту — основной список продолжает жить.
  const heatFuels = filters.fuels.length ? filters.fuels : undefined;
  const { data: heatData, error: heatError } = useHeat(isHeatmapOn, heatFuels);
  const heatCircles: MapHeatCircle[] = useMemo(() => {
    if (!isHeatmapOn || !heatData) return [];
    const levels = heatData.levels;
    return heatData.cells
      .map((cell) => {
        const level = heatLevelFor(cell.availability, levels);
        return level ? { lat: cell.lat, lon: cell.lon, color: HEAT_COLORS[level], stationId: cell.station_id } : null;
      })
      .filter((circle): circle is MapHeatCircle => circle !== null);
  }, [isHeatmapOn, heatData]);

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
  const routeReady = routeActive && routePoints.length >= 2;
  const routeQuery = useMemo(
    () => ({
      polyline: routePoints,
      corridor_km: routeCorridorKm,
      brand: filters.brand ?? undefined,
      fuel: filters.fuels.length === 1 ? filters.fuels[0] : undefined,
      status: filters.status ?? undefined,
      confidence_min: filters.confidenceMin ?? undefined,
      queue_max: filters.queueMax ?? undefined,
      limit: 100,
      preferred_brands: preferredBrandsParam,
    }),
    [routePoints, routeCorridorKm, filters.brand, filters.fuels, filters.status, filters.confidenceMin, filters.queueMax, preferredBrandsParam],
  );
  const { stations: routeStations, loading: routeLoading, error: routeError } = useRouteStations(routeReady, routeQuery);
  const visibleStations = routeReady ? routeStations : stations;
  const visibleLoading = routeReady ? routeLoading : loading;
  const visibleError = routeReady ? routeError : error;
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
    if (!q) return visibleStations;
    return visibleStations.filter(
      (s) => s.name.toLowerCase().includes(q) || s.address.toLowerCase().includes(q) || (s.brand ?? "").toLowerCase().includes(q),
    );
  }, [visibleStations, filters.search]);

  // Режим наблюдения (R25) + предпочтения сетей (R77) — персональные настройки
  // поверх уже отфильтрованного/отсортированного API-ответа (см. lib/personalization.ts).
  const favoriteIds = useMemo(() => new Set(favorites.map((f) => f.id)), [favorites]);
  const personalized = useMemo(() => {
    const observed = applyObservationMode(searched, observationSettings, favoriteIds);
    return applyPreferredBrandsOrder(observed, preferredBrandNames);
  }, [searched, observationSettings, favoriteIds, preferredBrandNames]);

  const confirmedCount = countConfirmed(searched, filters.fuels, filters.includeLikely);
  const isSearchingFuel = filters.fuels.length > 0;
  const isEmpty = !routeReady && isSearchingFuel && !visibleLoading && confirmedCount === 0;
  const routeIsEmpty = routeReady && !visibleLoading && !visibleError && personalized.length === 0;

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
      <RouteModePanel
        active={routeActive}
        points={routePoints}
        corridorKm={routeCorridorKm}
        onActiveChange={(active) => {
          setRouteActive(active);
          if (active) setFilters({ tab: "map" });
        }}
        onCorridorChange={setRouteCorridorKm}
        onRemovePoint={(index) => setRoutePoints((current) => current.filter((_, itemIndex) => itemIndex !== index))}
        onClear={() => setRoutePoints([])}
      />

      {visibleError && (!isStale || routeReady) && <p className="px-4 py-2 text-sm text-red-600 dark:text-red-400">{visibleError}</p>}
      {isStale && !routeReady && <p className="bg-amber-50 px-4 py-1 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">{t("error.stale")}</p>}

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
              <>
                <MapView
                  stations={personalized}
                  selectedFuelCodes={filters.fuels}
                  selectedStationId={filters.station}
                  onSelectStation={(id) => setFilters({ station: id })}
                  focus={focus}
                  routePolyline={routeActive ? routePoints : undefined}
                  onMapClick={routeActive ? (point) => setRoutePoints((current) => [...current, point].slice(0, 100)) : undefined}
                  heatCircles={heatCircles.length ? heatCircles : undefined}
                />
                <div className="absolute right-2 top-2 z-20 flex flex-col items-end gap-2">
                  <label
                    className="flex cursor-pointer items-center gap-2 rounded-lg bg-white/95 px-3 py-1.5 text-xs font-medium text-gray-700 shadow dark:bg-gray-900/95 dark:text-gray-200"
                    title={isHeatmapOn ? t("heat.on") : t("heat.off")}
                  >
                    <input
                      type="checkbox"
                      checked={isHeatmapOn}
                      onChange={(event) => setIsHeatmapOn(event.target.checked)}
                      aria-label={t("heat.toggle")}
                      className="h-4 w-4 accent-emerald-600"
                    />
                    {t("heat.toggle")}
                  </label>
                  {isHeatmapOn && heatError && (
                    <p className="max-w-[260px] rounded-lg bg-amber-50/95 px-3 py-1.5 text-xs text-amber-800 shadow dark:bg-amber-950/95 dark:text-amber-200">
                      {t(heatError === "unavailable" ? "heat.unavailable" : "heat.error")}
                    </p>
                  )}
                </div>
              </>
            )}
            {filters.tab === "list" && <StationList stations={personalized} onSelect={(id) => setFilters({ station: id })} />}
            {filters.tab === "favorites" && <FavoritesPanel onSelect={(id) => setFilters({ station: id })} />}
            {routeIsEmpty && (
              <div className="absolute left-1/2 top-2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-lg bg-white/95 px-3 py-2 text-xs text-gray-700 shadow dark:bg-gray-900/95 dark:text-gray-200">
                <span>{t("route.empty")}</span>
                <button
                  type="button"
                  onClick={() => setRouteCorridorKm((value) => Math.min(50, value + 5))}
                  className="rounded bg-blue-600 px-2 py-1 font-semibold text-white"
                >
                  {t("route.expand")}
                </button>
              </div>
            )}
            {visibleLoading && (
              <p className="absolute left-1/2 top-2 -translate-x-1/2 rounded-full bg-white/90 px-3 py-1 text-xs text-gray-500 shadow dark:bg-gray-800/90 dark:text-gray-300">
                {routeReady ? t("route.loading") : t("loading")}
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
