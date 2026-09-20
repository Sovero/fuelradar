"use client";

/**
 * Реализация MapProvider на Яндекс.Картах (R102) — ВТОРАЯ, ОПЦИОНАЛЬНАЯ
 * реализация того же интерфейса `MapProviderProps`, что и MapLibreProvider
 * (lib/map/maplibre-provider.tsx, который остаётся провайдером по умолчанию —
 * бесплатный OSM-рендер работает «из коробки» без ключей). Яндекс.Карты —
 * платный сервис, поэтому включается сам, только если задан непустой
 * `NEXT_PUBLIC_YANDEX_MAPS_API_KEY` (см. lib/map/index.ts::getMapProviderKind);
 * без ключа приложение к Яндекс.Картам вообще не обращается.
 *
 * Меняется ТОЛЬКО визуальная подложка карты — каталог станций и вся остальная
 * логика приложения (фильтры, клик по маркеру → карточка станции) не знают,
 * какой провайдер сейчас активен.
 *
 * Маркеры используют ту же canvas-иконку (цвет/сектора/галочка-крестик), что и
 * MapLibre-провайдер — см. lib/map/markerIcon.ts, только как data URL (Yandex
 * Placemark принимает iconImageHref, а не sprite-изображение GL-стиля).
 *
 * Копирайт/логотип Яндекс.Карт рисует сам JS API поверх карты — специально
 * не подавляется никакими CSS/z-index трюками (условие лицензии).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { drawMarkerIconDataUrl, MARKER_ICON_SIZE, markerIconKey, shortFuelLabel } from "@/lib/map/markerIcon";
import { loadYmaps, type YMapsNamespace } from "@/lib/map/yandexLoader";
import type { MapProviderProps } from "@/lib/map/types";

function colorFor(status: string): string {
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

type LoadState = "no-key" | "loading" | "error" | "ready";

export function YandexMapProvider({
  markers,
  initialViewport,
  flyTo,
  onMarkerClick,
  onViewportChange,
  userLocation,
  routePolyline = [],
  routeLabel = null,
  highlightedStationIds = [],
  onMapClick,
  heatCircles = [],
  className,
}: MapProviderProps) {
  const apiKey = process.env.NEXT_PUBLIC_YANDEX_MAPS_API_KEY;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<InstanceType<YMapsNamespace["Map"]> | null>(null);
  const clustererRef = useRef<InstanceType<YMapsNamespace["Clusterer"]> | null>(null);
  const userPlacemarkRef = useRef<InstanceType<YMapsNamespace["Placemark"]> | null>(null);
  const routePolylineRef = useRef<InstanceType<YMapsNamespace["Polyline"]> | null>(null);
  const routeHaloRef = useRef<InstanceType<YMapsNamespace["Polyline"]> | null>(null);
  const routeLabelPlacemarkRef = useRef<InstanceType<YMapsNamespace["Placemark"]> | null>(null);
  const corridorCollectionRef = useRef<InstanceType<YMapsNamespace["GeoObjectCollection"]> | null>(null);
  const heatCollectionRef = useRef<InstanceType<YMapsNamespace["GeoObjectCollection"]> | null>(null);
  const ymapsRef = useRef<YMapsNamespace | null>(null);
  const onMarkerClickRef = useRef(onMarkerClick);
  const onViewportChangeRef = useRef(onViewportChange);
  const onMapClickRef = useRef(onMapClick);
  onMarkerClickRef.current = onMarkerClick;
  onViewportChangeRef.current = onViewportChange;
  onMapClickRef.current = onMapClick;

  const [state, setState] = useState<LoadState>(apiKey ? "loading" : "no-key");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const iconCache = useMemo(() => new Map<string, string>(), []);

  // Инициализация карты — один раз, после загрузки ymaps.
  useEffect(() => {
    if (!apiKey || !containerRef.current) return;
    let cancelled = false;

    loadYmaps(apiKey)
      .then((ymaps) => {
        if (cancelled || !containerRef.current) return;
        ymapsRef.current = ymaps;
        const map = new ymaps.Map(containerRef.current, {
          center: [initialViewport.center[1], initialViewport.center[0]], // ymaps: [lat, lon]
          zoom: initialViewport.zoom,
          controls: ["zoomControl", "geolocationControl"],
        });
        mapRef.current = map;

        const clusterer = new ymaps.Clusterer({
          preset: "islands#invertedDarkGreenClusterIcons",
          groupByCoordinates: false,
          clusterIconLayout: "default#pieChart",
          clusterIconPieChartRadius: 20,
          clusterIconPieChartCoreRadius: 12,
          clusterIconPieChartStrokeWidth: 0,
        });
        map.geoObjects.add(clusterer);
        clustererRef.current = clusterer;

        map.events.add("boundschange", () => {
          const bounds = map.getBounds(); // [[lat_min, lon_min], [lat_max, lon_max]]
          const center = map.getCenter();
          onViewportChangeRef.current?.({
            center: [center[1], center[0]],
            zoom: map.getZoom(),
            bounds: [bounds[0][0], bounds[0][1], bounds[1][0], bounds[1][1]],
          });
        });
        map.events.add("click", (event: { get: (key: string) => [number, number] }) => {
          const [lat, lon] = event.get("coords");
          onMapClickRef.current?.({ lat, lon });
        });

        setState("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setErrorMessage(err instanceof Error ? err.message : "Не удалось загрузить Яндекс.Карты");
        setState("error");
      });

    return () => {
      cancelled = true;
      clustererRef.current?.removeAll();
      mapRef.current?.destroy();
      mapRef.current = null;
      clustererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  // Обновление маркеров — без сброса вида карты (R27.2).
  useEffect(() => {
    const ymaps = ymapsRef.current;
    const clusterer = clustererRef.current;
    if (!ymaps || !clusterer) return;

    const placemarks = markers.map((m) => {
      const key = markerIconKey(m.badges, m.ringColor);
      let iconUrl = iconCache.get(key);
      if (!iconUrl) {
        const colors = m.badges.length ? m.badges.map((b) => colorFor(b.status)) : [m.color];
        const oks = m.badges.map((b) => b.ok);
        iconUrl = drawMarkerIconDataUrl(colors, oks, m.ringColor);
        iconCache.set(key, iconUrl);
      }
      const label = m.badges.length > 1 ? m.badges.map((b) => `${shortFuelLabel(b.fuelCode)}${b.ok ? "✓" : "✗"}`).join(" ") : "";

      const placemark = new ymaps.Placemark(
        [m.lat, m.lon],
        { hintContent: label || undefined, fr_id: m.id },
        {
          iconLayout: "default#image",
          iconImageHref: iconUrl,
          iconImageSize: [MARKER_ICON_SIZE, MARKER_ICON_SIZE],
          iconImageOffset: [-MARKER_ICON_SIZE / 2, -MARKER_ICON_SIZE / 2],
        },
      );
      placemark.events.add("click", (event: { stopPropagation: () => void }) => {
        event.stopPropagation();
        onMarkerClickRef.current(m.id);
      });
      return placemark;
    });

    clusterer.removeAll();
    clusterer.add(placemarks);
  }, [markers, iconCache]);

  // Круги heatmap (R50) — отдельная коллекция geoObjects, обновляется по фильтрам.
  useEffect(() => {
    const ymaps = ymapsRef.current;
    const map = mapRef.current;
    if (!ymaps || !map) return;
    if (heatCollectionRef.current) {
      map.geoObjects.remove(heatCollectionRef.current);
      heatCollectionRef.current = null;
    }
    if (!heatCircles.length) return;
    const collection = new ymaps.GeoObjectCollection();
    for (const circle of heatCircles) {
      collection.add(new ymaps.Circle(
        [[circle.lat, circle.lon], 500],
        { hintContent: circle.stationId },
        {
          fillColor: circle.color,
          fillOpacity: 0.3,
          strokeColor: circle.color,
          strokeOpacity: 0.6,
          strokeWidth: 1,
        },
      ));
    }
    map.geoObjects.add(collection);
    heatCollectionRef.current = collection;
  }, [heatCircles, state]);

  useEffect(() => {
    const ymaps = ymapsRef.current;
    const map = mapRef.current;
    if (!ymaps || !map) return;
    if (routePolylineRef.current) {
      map.geoObjects.remove(routePolylineRef.current);
      routePolylineRef.current = null;
    }
    if (routeHaloRef.current) {
      map.geoObjects.remove(routeHaloRef.current);
      routeHaloRef.current = null;
    }
    if (routePolyline.length < 2) return;
    // Ореол коридора под основной линией — как route-line-halo у MapLibre-провайдера.
    const halo = new ymaps.Polyline(
      routePolyline.map((point) => [point.lat, point.lon]),
      {},
      { strokeColor: "#2563eb", strokeWidth: 14, strokeOpacity: 0.15 },
    );
    map.geoObjects.add(halo);
    routeHaloRef.current = halo;
    const polyline = new ymaps.Polyline(
      routePolyline.map((point) => [point.lat, point.lon]),
      {},
      { strokeColor: "#2563eb", strokeWidth: 4, strokeOpacity: 0.9 },
    );
    map.geoObjects.add(polyline);
    routePolylineRef.current = polyline;
  }, [routePolyline, state]);

  // Станции коридора маршрута — янтарные круги (аналог corridor-halo у MapLibre).
  useEffect(() => {
    const ymaps = ymapsRef.current;
    const map = mapRef.current;
    if (!ymaps || !map) return;
    if (corridorCollectionRef.current) {
      map.geoObjects.remove(corridorCollectionRef.current);
      corridorCollectionRef.current = null;
    }
    if (!highlightedStationIds.length) return;
    const collection = new ymaps.GeoObjectCollection();
    for (const id of highlightedStationIds) {
      const marker = markers.find((mk) => mk.id === id);
      if (!marker) continue;
      collection.add(new ymaps.Circle(
        [[marker.lat, marker.lon], 150],
        {},
        { fillColor: "#f59e0b", fillOpacity: 0.22, strokeColor: "#f59e0b", strokeOpacity: 0.8, strokeWidth: 2 },
      ));
    }
    map.geoObjects.add(collection);
    corridorCollectionRef.current = collection;
  }, [highlightedStationIds, markers, state]);

  // Подпись расстояния/ETA на середине линии маршрута — stretchy-плейсмарк.
  useEffect(() => {
    const ymaps = ymapsRef.current;
    const map = mapRef.current;
    if (!ymaps || !map) return;
    if (routeLabelPlacemarkRef.current) {
      map.geoObjects.remove(routeLabelPlacemarkRef.current);
      routeLabelPlacemarkRef.current = null;
    }
    if (!routeLabel) return;
    const placemark = new ymaps.Placemark(
      [routeLabel.lat, routeLabel.lon],
      { iconContent: routeLabel.text },
      { preset: "islands#blueStretchyIcon", zIndex: 1200 },
    );
    map.geoObjects.add(placemark);
    routeLabelPlacemarkRef.current = placemark;
  }, [routeLabel, state]);

  // Программный перелёт — только по явному действию (геолокация, выбор станции из списка).
  useEffect(() => {
    if (!flyTo || !mapRef.current) return;
    mapRef.current.setCenter([flyTo.center[1], flyTo.center[0]], flyTo.zoom, { duration: 300 });
  }, [flyTo]);

  // Позиция пользователя — отдельный Placemark вне кластеризатора станций.
  useEffect(() => {
    const ymaps = ymapsRef.current;
    const map = mapRef.current;
    if (!ymaps || !map) return;
    if (userPlacemarkRef.current) {
      map.geoObjects.remove(userPlacemarkRef.current);
      userPlacemarkRef.current = null;
    }
    if (!userLocation) return;
    const placemark = new ymaps.Placemark(
      [userLocation.lat, userLocation.lon],
      { hintContent: "Ваше местоположение" },
      { preset: "islands#blueCircleIcon", zIndex: 1000 },
    );
    map.geoObjects.add(placemark);
    userPlacemarkRef.current = placemark;
  }, [userLocation]);

  if (state === "no-key") {
    // На практике getMapProvider() уже не выбирает Yandex без ключа (см. lib/map/index.ts) —
    // это защитное сообщение на случай прямого использования компонента или смены логики выбора.
    return (
      <div className={`flex h-full w-full items-center justify-center bg-gray-100 p-6 text-center dark:bg-gray-900 ${className ?? ""}`}>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Карта Яндекса недоступна — не задан ключ NEXT_PUBLIC_YANDEX_MAPS_API_KEY. Задайте его в
          frontend/.env.local, либо используйте бесплатный MapLibre/OSM (провайдер по умолчанию).
        </p>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className={`flex h-full w-full items-center justify-center bg-gray-100 p-6 text-center dark:bg-gray-900 ${className ?? ""}`}>
        <p className="text-sm text-red-600 dark:text-red-400">{errorMessage ?? "Карта недоступна"}</p>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      {state === "loading" && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-100/70 text-sm text-gray-500 dark:bg-gray-900/70 dark:text-gray-400">
          Загрузка карты…
        </div>
      )}
      <div ref={containerRef} className={className ?? "h-full w-full"} data-testid="yandex-map-container" />
    </div>
  );
}
