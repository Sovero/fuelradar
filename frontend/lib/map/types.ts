import type { FuelStatusCode } from "@/lib/types";

/** Один "значок" на маркере станции — конкретный вид топлива и его статус. */
export interface MarkerBadge {
  fuelCode: string;
  status: FuelStatusCode;
  /** true — топливо считается доступным (использовать ✅), false — нет (❌) */
  ok: boolean;
}

export interface StationMarker {
  id: string;
  lat: number;
  lon: number;
  /** Основной цвет маркера (по агрегату/выбранному топливу). */
  color: string;
  badges: MarkerBadge[];
  /** Кольцо вокруг маркера цветом сети (R103) — null у независимых станций (нет brand). */
  ringColor: string | null;
}

export interface MapViewport {
  center: [number, number]; // [lon, lat]
  zoom: number;
}

export interface MapProviderProps {
  markers: StationMarker[];
  initialViewport: MapViewport;
  /** Управляемый вьюпорт — если задан, карта перелетает к нему по изменению. */
  flyTo?: MapViewport | null;
  selectedStationId?: string | null;
  onMarkerClick: (stationId: string) => void;
  /** Вызывается когда пользователь подвинул карту (для «показать в этой области» и т.п.) */
  onViewportChange?: (viewport: MapViewport & { bounds: [number, number, number, number] }) => void;
  className?: string;
}

/** Единый интерфейс слоя карты (R61) — реализация подставляется конфигурацией. */
export type MapProviderComponent = React.ComponentType<MapProviderProps>;
