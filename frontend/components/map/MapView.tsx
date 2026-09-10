"use client";

/**
 * Обёртка над абстракцией карты (R61) — сама не знает про MapLibre, только про
 * `MapProviderProps`. Пересчитывает маркеры при изменении станций/фильтров,
 * но не сбрасывает вид карты на каждое обновление (R27.2) — flyTo только по
 * явному действию (геолокация/клик по станции в списке).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useMapProviderPreference } from "@/lib/hooks/useMapProviderPreference";
import type { MapHeatCircle, MapPoint, MapViewport } from "@/lib/map/types";
import { buildStationMarkers } from "@/lib/map/markerData";
import { DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM, NEARBY_ZOOM } from "@/lib/map/config";
import { Legend } from "@/components/map/Legend";
import type { StationBrief } from "@/lib/types";

export function MapView({
  stations,
  selectedFuelCodes,
  selectedStationId,
  onSelectStation,
  focus,
  routePolyline,
  onMapClick,
  heatCircles,
}: {
  stations: StationBrief[];
  selectedFuelCodes: string[];
  selectedStationId: string | null;
  onSelectStation: (id: string) => void;
  /** Точка, к которой нужно перелететь (геолокация/центр по умолчанию) — меняется редко. */
  focus: { lat: number; lon: number } | null;
  routePolyline?: MapPoint[];
  onMapClick?: (point: MapPoint) => void;
  /** R50: круги heatmap — включаются отдельно, обновляются по фильтрам. */
  heatCircles?: MapHeatCircle[];
}) {
  const { ProviderComponent: Provider } = useMapProviderPreference();
  const markers = useMemo(() => buildStationMarkers(stations, selectedFuelCodes), [stations, selectedFuelCodes]);

  const [flyTo, setFlyTo] = useState<MapViewport | null>(null);
  const lastFocusRef = useRef<string | null>(null);

  useEffect(() => {
    if (!focus) return;
    const key = `${focus.lat.toFixed(5)},${focus.lon.toFixed(5)}`;
    if (lastFocusRef.current === key) return;
    lastFocusRef.current = key;
    setFlyTo({ center: [focus.lon, focus.lat], zoom: NEARBY_ZOOM });
  }, [focus]);

  const initialViewport: MapViewport = focus
    ? { center: [focus.lon, focus.lat], zoom: NEARBY_ZOOM }
    : { center: DEFAULT_MAP_CENTER, zoom: DEFAULT_MAP_ZOOM };

  return (
    <div className="relative h-full w-full">
      <Provider
        markers={markers}
        initialViewport={initialViewport}
        flyTo={flyTo}
        selectedStationId={selectedStationId}
        onMarkerClick={onSelectStation}
        userLocation={focus}
        routePolyline={routePolyline}
        onMapClick={onMapClick}
        heatCircles={heatCircles}
      />
      <Legend showHeat={Boolean(heatCircles?.length)} />
    </div>
  );
}
