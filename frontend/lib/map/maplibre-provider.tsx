"use client";

/**
 * Реализация MapProvider на MapLibre GL (R61). Это ЕДИНСТВЕННОЕ место, где
 * используется `maplibre-gl` напрямую — остальной код карты работает через
 * `MapProviderProps`, так что провайдера можно заменить, не трогая экраны.
 *
 * Кластеризация — нативный GeoJSON-источник MapLibre (cluster: true), клик по
 * кластеру приближает карту (R29.1). Маркеры отрисовываются canvas-иконками
 * (круг/сектора по числу видов топлива + галочка/крестик) и регистрируются как
 * sprite-изображения — так составной маркер («95 ✅ / ДТ ❌», R28) остаётся
 * частью карты, а не DOM-элементом, и не «прыгает» при обновлении данных (R27.2).
 */

import { useEffect, useRef } from "react";
import maplibregl, { type GeoJSONSource, type MapGeoJSONFeature } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { buildOsmStyle } from "@/lib/map/osmStyle";
import { drawMarkerIcon, markerIconKey, shortFuelLabel } from "@/lib/map/markerIcon";
import type { MapProviderProps, StationMarker } from "@/lib/map/types";

const SOURCE_ID = "fr-stations";
const ROUTE_SOURCE_ID = "fr-route";
const HEAT_SOURCE_ID = "fr-heat";

function toFeatureCollection(markers: StationMarker[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: markers.map((m) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [m.lon, m.lat] },
      properties: {
        id: m.id,
        iconKey: markerIconKey(m.badges, m.ringColor),
        colors: JSON.stringify(m.badges.length ? m.badges.map((b) => colorFor(b.status)) : [m.color]),
        oks: JSON.stringify(m.badges.map((b) => b.ok)),
        label: m.badges.length > 1 ? m.badges.map((b) => `${shortFuelLabel(b.fuelCode)}${b.ok ? "✓" : "✗"}`).join(" ") : "",
      },
    })),
  };
}

function colorFor(status: string): string {
  // локальный доступ без импорта цикла — держим синхронно с statusColor.ts
  const map: Record<string, string> = {
    AVAILABLE: "#16a34a",
    LIKELY_AVAILABLE: "#eab308",
    LOW_STOCK: "#f97316",
    UNCERTAIN: "#f97316",
    UNAVAILABLE: "#dc2626",
    UNKNOWN: "#9ca3af",
  };
  return map[status] ?? map.UNKNOWN;
}

export function MapLibreProvider({
  markers,
  initialViewport,
  flyTo,
  selectedStationId,
  onMarkerClick,
  onViewportChange,
  userLocation,
  routePolyline = [],
  onMapClick,
  heatCircles = [],
  className,
}: MapProviderProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const iconKeysRef = useRef<Set<string>>(new Set());
  const onMarkerClickRef = useRef(onMarkerClick);
  const onViewportChangeRef = useRef(onViewportChange);
  const onMapClickRef = useRef(onMapClick);
  onMarkerClickRef.current = onMarkerClick;
  onViewportChangeRef.current = onViewportChange;
  onMapClickRef.current = onMapClick;

  // Инициализация карты — один раз.
  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildOsmStyle(),
      center: initialViewport.center,
      zoom: initialViewport.zoom,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), "top-right");

    map.on("load", () => {
      map.addSource(ROUTE_SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "route-line",
        type: "line",
        source: ROUTE_SOURCE_ID,
        paint: {
          "line-color": "#2563eb",
          "line-width": 4,
          "line-opacity": 0.9,
        },
      });
      map.addSource(HEAT_SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "heat-circles",
        type: "circle",
        source: HEAT_SOURCE_ID,
        paint: {
          "circle-radius": 24,
          "circle-color": ["get", "color"],
          "circle-opacity": 0.3,
          "circle-blur": 0.6,
        },
      });
      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        cluster: true,
        clusterRadius: 50,
        clusterMaxZoom: 15,
      });

      map.addLayer({
        id: "clusters",
        type: "circle",
        source: SOURCE_ID,
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#0f766e",
          "circle-opacity": 0.85,
          "circle-radius": ["step", ["get", "point_count"], 16, 10, 20, 50, 26],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      });

      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: SOURCE_ID,
        filter: ["has", "point_count"],
        layout: {
          // формат подписи держим в одном месте — см. lib/map/cluster.ts::clusterLabel
          "text-field": ["concat", ["get", "point_count_abbreviated"], " АЗС"],
          "text-font": ["Noto Sans Bold"],
          "text-size": 12,
        },
        paint: { "text-color": "#ffffff" },
      });

      map.addLayer({
        id: "selected-halo",
        type: "circle",
        source: SOURCE_ID,
        filter: ["==", ["get", "id"], "__none__"],
        paint: {
          "circle-radius": 22,
          "circle-color": "#2563eb",
          "circle-opacity": 0.25,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#2563eb",
        },
      });

      map.addLayer({
        id: "unclustered-point",
        type: "symbol",
        source: SOURCE_ID,
        filter: ["!", ["has", "point_count"]],
        layout: {
          "icon-image": ["get", "iconKey"],
          "icon-size": 1,
          "icon-allow-overlap": true,
          "text-field": ["get", "label"],
          "text-size": 10,
          "text-offset": [0, 1.3],
          "text-anchor": "top",
          "text-optional": true,
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": "#111827",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.2,
        },
      });

      map.on("click", "clusters", (e) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ["clusters"] }) as MapGeoJSONFeature[];
        const clusterId = features[0]?.properties?.cluster_id;
        const source = map.getSource(SOURCE_ID) as GeoJSONSource;
        if (clusterId === undefined) return;
        source.getClusterExpansionZoom(clusterId).then((zoom) => {
          const geometry = features[0].geometry;
          if (geometry.type !== "Point") return;
          map.easeTo({ center: geometry.coordinates as [number, number], zoom });
        });
      });

      map.on("click", "unclustered-point", (e) => {
        const feature = e.features?.[0];
        const id = feature?.properties?.id as string | undefined;
        if (id) onMarkerClickRef.current(id);
      });

      map.on("mouseenter", "clusters", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "clusters", () => (map.getCanvas().style.cursor = ""));
      map.on("mouseenter", "unclustered-point", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "unclustered-point", () => (map.getCanvas().style.cursor = ""));
    });

    map.on("click", (event) => {
      const interactiveLayers = ["clusters", "unclustered-point"].filter((layer) => map.getLayer(layer));
      const hits = interactiveLayers.length
        ? map.queryRenderedFeatures(event.point, { layers: interactiveLayers })
        : [];
      if (hits.length === 0) {
        onMapClickRef.current?.({ lat: event.lngLat.lat, lon: event.lngLat.lng });
      }
    });

    const emitViewport = () => {
      const bounds = map.getBounds();
      onViewportChangeRef.current?.({
        center: [map.getCenter().lng, map.getCenter().lat],
        zoom: map.getZoom(),
        bounds: [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()],
      });
    };
    map.on("moveend", emitViewport);

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Обновление данных маркеров — без сброса вида карты (R27.2).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      for (const m of markers) {
        const key = markerIconKey(m.badges, m.ringColor);
        if (iconKeysRef.current.has(key)) continue;
        const colors: string[] = m.badges.length ? m.badges.map((b) => colorFor(b.status)) : [m.color];
        const oks: boolean[] = m.badges.map((b) => b.ok);
        const canvas = drawMarkerIcon(colors, oks, m.ringColor);
        const imgData = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
        if (!map.hasImage(key)) {
          map.addImage(key, imgData, { pixelRatio: 2 });
        }
        iconKeysRef.current.add(key);
      }
      const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
      source?.setData(toFeatureCollection(markers));
    };
    if (map.isStyleLoaded() && map.getSource(SOURCE_ID)) {
      apply();
    } else {
      map.once("load", apply);
    }
  }, [markers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const source = map.getSource(ROUTE_SOURCE_ID) as GeoJSONSource | undefined;
      source?.setData(
        routePolyline.length >= 2
          ? {
              type: "Feature",
              properties: {},
              geometry: {
                type: "LineString",
                coordinates: routePolyline.map((point) => [point.lon, point.lat]),
              },
            }
          : { type: "FeatureCollection", features: [] },
      );
    };
    if (map.isStyleLoaded() && map.getSource(ROUTE_SOURCE_ID)) apply();
    else map.once("load", apply);
  }, [routePolyline]);

  // Обновление кругов heatmap (R50) — слой под маркерами, обновляется по фильтрам.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const source = map.getSource(HEAT_SOURCE_ID) as GeoJSONSource | undefined;
      source?.setData({
        type: "FeatureCollection",
        features: heatCircles.map((circle) => ({
          type: "Feature",
          properties: { color: circle.color, stationId: circle.stationId },
          geometry: { type: "Point", coordinates: [circle.lon, circle.lat] },
        })),
      });
    };
    if (map.isStyleLoaded() && map.getSource(HEAT_SOURCE_ID)) apply();
    else map.once("load", apply);
  }, [heatCircles]);

  // Программный перелёт (например, геолокация «Найти рядом»), НЕ на каждое обновление маркеров.
  useEffect(() => {
    if (!flyTo || !mapRef.current) return;
    mapRef.current.flyTo({ center: flyTo.center, zoom: flyTo.zoom, essential: true });
  }, [flyTo]);

  // Подсветка выбранной станции — отдельный слой-ореол под иконкой.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer("selected-halo")) return;
    map.setFilter("selected-halo", ["==", ["get", "id"], selectedStationId ?? "__none__"]);
  }, [selectedStationId]);

  // Позиция пользователя — отдельный DOM-маркер (не станция, не кластеризуется).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!userLocation) {
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
      return;
    }
    if (!userMarkerRef.current) {
      const el = document.createElement("div");
      el.setAttribute("aria-label", "Ваше местоположение");
      el.style.width = "18px";
      el.style.height = "18px";
      el.style.borderRadius = "50%";
      el.style.background = "#2563eb";
      el.style.border = "3px solid #ffffff";
      el.style.boxShadow = "0 0 0 2px #2563eb, 0 1px 4px rgba(0,0,0,0.4)";
      userMarkerRef.current = new maplibregl.Marker({ element: el });
    }
    userMarkerRef.current.setLngLat([userLocation.lon, userLocation.lat]).addTo(map);
  }, [userLocation]);

  return <div ref={containerRef} className={className ?? "h-full w-full"} data-testid="maplibre-container" />;
}
