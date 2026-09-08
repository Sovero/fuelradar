/**
 * Типы соответствуют ответам backend `/api/v1/*` (см. backend/app/api/schemas.py,
 * backend/app/api/stations.py, backend/app/api/meta.py). Никаких захардкоженных
 * русских текстов статусов/топлива здесь нет — они приходят из `/meta` (R98i).
 */

export type FuelStatusCode =
  | "AVAILABLE"
  | "LIKELY_AVAILABLE"
  | "LOW_STOCK"
  | "UNCERTAIN"
  | "UNAVAILABLE"
  | "UNKNOWN";

export type QueueLevelCode = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH" | "UNKNOWN";

export type SortKey = "distance" | "confidence" | "availability" | "queue" | "travel_time" | "score";

export interface FuelStatusBrief {
  fuel_code: string;
  status: FuelStatusCode;
  confidence: number;
  updated_at: string | null;
  expires_at: string | null;
}

export interface QueueBrief {
  level: QueueLevelCode;
  vehicles: number | null;
  estimated_wait_minutes: number | null;
}

export interface StationBrief {
  id: string;
  name: string;
  brand: string | null;
  latitude: number;
  longitude: number;
  address: string;
  city: string;
  distance_km: number | null;
  eta_minutes: number | null;
  statuses: FuelStatusBrief[];
  queue: QueueBrief | null;
  score: number | null;
}

export interface ScoreComponent {
  value: number;
  weight: number;
  contribution: number;
}

export interface StatusExplanationContribution {
  source?: string;
  label?: string;
  age_minutes?: number;
  source_provider_id?: number;
  [key: string]: unknown;
}

export interface StatusExplanation {
  status?: string;
  reason?: string;
  note?: string;
  contributions?: StatusExplanationContribution[];
  [key: string]: unknown;
}

export interface StationDetail extends StationBrief {
  phone: string;
  opening_hours: string;
  external_ids: Record<string, string>;
  score_breakdown: Record<string, ScoreComponent>;
  status_explanation: StatusExplanation;
}

export interface HistoryItem {
  confidence_raw: number;
  fuel_code: string;
  status: FuelStatusCode;
  source: string;
  observed_at: string;
  received_at: string | null;
}

export interface QueueHistoryItem {
  level: QueueLevelCode;
  vehicles: number | null;
  source: string;
  observed_at: string;
}

export interface MetaFuelType {
  code: string;
  name_ru: string;
  name_en?: string;
  commercial: string[];
}

export interface MetaBrand {
  name: string;
  priority: number;
}

export interface MetaSource {
  code: string;
  name: string;
  status: string;
  attribution: string;
}

export interface MetaStatus {
  code: string;
  name_ru: string;
  name_en?: string;
}

export interface Meta {
  fuel_types: MetaFuelType[];
  station_brands: MetaBrand[];
  sources: MetaSource[];
  fuel_statuses: MetaStatus[];
  queue_levels: MetaStatus[];
}

export interface AuthUser {
  id: number;
  telegram_id: string | null;
  email: string | null;
  reliability_score: number;
}

export interface ZoneOut {
  id: number;
  name: string;
  zone_type: "CITY" | "CIRCLE" | "POLYGON";
  params: Record<string, unknown>;
}

export interface AlertRuleOut {
  id: number;
  name: string;
  fuel_code: string | null;
  distance_km: number | null;
  status_filter: string | null;
  confidence_min: number | null;
  queue_max: string | null;
  scope: Record<string, unknown>;
  is_active: boolean;
}

export interface ApiErrorDetailItem {
  loc: (string | number)[];
  msg: string;
  type: string;
}

export interface StationListQuery {
  lat?: number;
  lon?: number;
  radius_km?: number;
  bbox?: string;
  city?: string;
  brand?: string;
  fuel?: string;
  status?: string;
  confidence_min?: number;
  queue_max?: string;
  sort?: SortKey;
  limit?: number;
  offset?: number;
}
