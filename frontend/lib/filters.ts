/**
 * Состояние фильтров экрана (R32.1: общее для карты/списка/избранного,
 * не сбрасывается при переключении вкладок). Хранится в query-параметрах
 * URL — так оно переживает переключение вкладок и перезагрузку (R39.1).
 */

export type TabKey = "map" | "list" | "favorites";
export type SortKey = "distance" | "confidence" | "availability" | "queue" | "travel_time" | "score";

export interface Filters {
  /** Выбранные виды топлива (пусто = агрегат по всем, без фильтрации). */
  fuels: string[];
  radiusKm: number;
  brand: string | null;
  status: string | null;
  confidenceMin: number | null;
  queueMax: string | null;
  /** R78.1: «дешевле X» для выбранного топлива; null = фильтр выключен. */
  priceMax: number | null;
  search: string;
  /** «Показывать вероятное наличие» — из пустого состояния (R75). */
  includeLikely: boolean;
  tab: TabKey;
  station: string | null;
  lat: number | null;
  lon: number | null;
  sort: SortKey | null;
}

export const DEFAULT_RADIUS_KM = 10;

export const DEFAULT_FILTERS: Filters = {
  fuels: [],
  radiusKm: DEFAULT_RADIUS_KM,
  brand: null,
  status: null,
  confidenceMin: null,
  queueMax: null,
  priceMax: null,
  search: "",
  includeLikely: false,
  tab: "map",
  station: null,
  lat: null,
  lon: null,
  sort: null,
};

const SORT_KEYS: SortKey[] = ["distance", "confidence", "availability", "queue", "travel_time", "score"];

function parseNumber(value: string | null): number | null {
  if (value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function filtersFromSearchParams(params: URLSearchParams): Filters {
  const tabRaw = params.get("tab");
  const tab: TabKey = tabRaw === "list" || tabRaw === "favorites" ? tabRaw : "map";
  return {
    fuels: (params.get("fuels") || "").split(",").filter(Boolean),
    radiusKm: parseNumber(params.get("radius")) ?? DEFAULT_RADIUS_KM,
    brand: params.get("brand") || null,
    status: params.get("status") || null,
    confidenceMin: parseNumber(params.get("confidence_min")),
    queueMax: params.get("queue_max") || null,
    priceMax: parseNumber(params.get("price_max")),
    search: params.get("q") || "",
    includeLikely: params.get("likely") === "1",
    tab,
    station: params.get("station") || null,
    lat: parseNumber(params.get("lat")),
    lon: parseNumber(params.get("lon")),
    sort: (SORT_KEYS as string[]).includes(params.get("sort") || "") ? (params.get("sort") as SortKey) : null,
  };
}

export function filtersToSearchParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.fuels.length) params.set("fuels", filters.fuels.join(","));
  if (filters.radiusKm !== DEFAULT_RADIUS_KM) params.set("radius", String(filters.radiusKm));
  if (filters.brand) params.set("brand", filters.brand);
  if (filters.status) params.set("status", filters.status);
  if (filters.confidenceMin !== null) params.set("confidence_min", String(filters.confidenceMin));
  if (filters.queueMax) params.set("queue_max", filters.queueMax);
  if (filters.priceMax !== null) params.set("price_max", String(filters.priceMax));
  if (filters.search) params.set("q", filters.search);
  if (filters.includeLikely) params.set("likely", "1");
  if (filters.tab !== "map") params.set("tab", filters.tab);
  if (filters.station) params.set("station", filters.station);
  if (filters.lat !== null) params.set("lat", String(filters.lat));
  if (filters.lon !== null) params.set("lon", String(filters.lon));
  if (filters.sort) params.set("sort", filters.sort);
  return params;
}
