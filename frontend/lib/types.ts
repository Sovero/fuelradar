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
  /** R78 (T13): последняя свежая цена — null/undefined = «нет данных», никогда не 0.
   * Опциональны не только по null: офлайн-кэш прошлой версии приложения (localStorage)
   * десериализуется без этих полей. */
  price?: number | null;
  price_currency?: string | null;
  price_updated_at?: string | null;
  price_source_provider_id?: number | null;
  price_source?: string | null;
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

export interface RouteStation extends StationBrief {
  distance_from_route_km: number;
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
  price?: number | null;
  price_currency?: string | null;
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
  id: number;
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
  /** T14 (R64): Web Push — публичный VAPID-ключ (не секрет); без ключей на сервере — enabled: false. */
  push?: { enabled: boolean; vapid_public_key: string | null };
  /**
   * Вход через Telegram (R97i): backend отдаёт имя бота только при настроенном
   * токене; поле отсутствует в старых сборках backend — тогда фронт откатывается
   * на build-time NEXT_PUBLIC_TELEGRAM_BOT_USERNAME.
   */
  telegram_login?: { enabled: boolean; bot_username: string | null };
  /** Средняя городская скорость (км/ч) для ETA на линии маршрута — из конфига backend; в старых сборках поле отсутствует. */
  avg_speed_kmh?: number;
}

export interface AuthUser {
  id: number;
  telegram_id: string | null;
  email: string | null;
  display_name: string;
  role: "USER" | "OPERATOR" | "ADMIN";
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
  /** R37.1 — видна дата последнего события и число срабатываний. */
  trigger_count?: number;
  last_event_at?: string | null;
}

export interface AlertRuleBody {
  name?: string;
  fuel_code?: string | null;
  distance_km?: number | null;
  status_filter?: string | null;
  confidence_min?: number | null;
  queue_max?: string | null;
  scope?: Record<string, unknown>;
  is_active?: boolean;
}

/** Отчёт «Сообщить» (R39) — POST /reports. Соглашение scope см. backend/app/reports/schemas.py. */
export interface ReportBody {
  station_id: string;
  fuel: Record<string, string>;
  /** R78: цена вместе со статусом того же топлива; валидируется backend'ом (R78.4). */
  prices?: Record<string, number>;
  queue?: string | null;
  idempotency_key: string;
  lat?: number | null;
  lon?: number | null;
}

export interface ReportOut {
  id: number;
  station_id: string;
  gps_confirmed: boolean;
  distance_to_station_m: number | null;
  created: boolean;
  created_at: string;
}

export interface NotificationItem {
  id: number;
  event_type: string;
  station_id: string;
  station_name: string;
  fuel_code: string | null;
  payload: Record<string, unknown>;
  delivered: boolean;
  delivered_at: string | null;
  created_at: string;
}

export interface NotificationsPage {
  items: NotificationItem[];
  unread_count: number;
}

/** Админ (M16 RBAC) — backend/app/api/admin.py, backend/app/analytics/router.py. */
export interface AdminSourceHealth {
  state: string;
  last_check_at: string | null;
  last_success_at: string | null;
  consecutive_failures: number;
  last_error: string;
}

/**
 * Файл-вход файлового источника (R58): что именно читает адаптер и когда файл
 * правился. Только для источников, читающих локальный файл (network_import).
 */
export interface AdminSourceFile {
  path: string;
  name: string;
  directory: string;
  exists: boolean;
  size_bytes: number | null;
  modified_at: string | null;
  /** Путь задан явно (NETWORK_IMPORT_PATH / --file), а не каталогом загрузки админки. */
  explicit: boolean;
  /** Каталог, в который пишет админский импорт CSV — совпадает не всегда. */
  upload_dir?: string;
  /** Время последнего успешного сбора источника (source_health), только в /catalog-gaps. */
  last_read_at?: string | null;
}

export interface AdminSourceOut {
  id: number;
  code: string;
  name: string;
  status: string;
  trust: number;
  capabilities: string[] | Record<string, unknown>;
  attribution: string;
  min_interval_minutes: number;
  health: AdminSourceHealth;
  /** Файл-вход источника (R58); null/undefined — источник читает файл не с диска. */
  file?: AdminSourceFile | null;
}

export interface CollectionLogItem {
  id: number;
  provider_code: string | null;
  provider_name: string | null;
  station_id: string | null;
  job_type: string;
  trigger: string;
  priority: string;
  status: string;
  records_count: number | null;
  error_count: number | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface CollectionLogPage {
  total: number;
  items: CollectionLogItem[];
}

export interface CollectionLogDetail {
  level: string;
  message: string;
  created_at: string;
}

export interface AdminReportItem {
  id: number;
  user_id: number;
  user_reliability_score: number | null;
  user_is_blocked: boolean | null;
  station_id: string | null;
  gps_confirmed: boolean;
  distance_to_station_m: number | null;
  created_at: string;
}

export interface AdminReportsPage {
  total: number;
  items: AdminReportItem[];
}

/** Пользователь из админ-списка (M16): роль видна, смена — только ADMIN. */
export interface AdminUserRow {
  id: number;
  display_name: string;
  email: string | null;
  telegram_id: string | null;
  role: "USER" | "OPERATOR" | "ADMIN";
  is_blocked: boolean;
  reliability_score: number | null;
}

export interface AdminUsersPage {
  total: number;
  items: AdminUserRow[];
}

/** Запись журнала действий (R67): append-only, наружу без секретов (R68). */
export interface AdminActionLogEntry {
  id: number;
  actor: string;
  action: string;
  target_type: string;
  target_id: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface AdminActionLogPage {
  total: number;
  items: AdminActionLogEntry[];
}

export interface CoverageOut {
  computed_at: string;
  stale: boolean;
  stations_discovered: number;
  with_fuel_data: number;
  partial_data: number;
  no_data: number;
  coverage_percent: number | null;
  definition: string;
}

export interface CoverageBySourceRow {
  code: string;
  name: string;
  status: string;
  attribution: string;
  records_before_dedup: number;
  unique_stations: number;
  unlinked_records: number;
}

export interface CoverageBySourceOut {
  computed_at: string;
  stale: boolean;
  sources: CoverageBySourceRow[];
  unique_stations_after_dedup: number;
  city_region_scope: string;
}

export interface FuelIndexItem {
  fuel: string;
  index: number | null;
  available: number;
  denominator: number;
  stations_total: number;
  excluded_unknown: number;
  excluded_ambiguous: number;
  coverage_percent: number | null;
}

export interface FuelIndexOut {
  computed_at: string;
  stale: boolean;
  items: FuelIndexItem[];
  definition: string;
}

export interface DeficitStatsItem {
  brand: string;
  fuel: string;
  observed_source_streams: number;
  unavailable_transitions: number;
  completed_outages: number;
  censored_outages: number;
  mean_absence_minutes: number | null;
  mean_recovery_minutes: number | null;
}

export interface DeficitStatsOut {
  computed_at: string;
  stale: boolean;
  items: DeficitStatsItem[];
  basis: string;
}

export interface DedupCandidate {
  record_id: number;
  source: number;
  source_name: string | null;
  external_id: string;
  brand_raw: string | null;
  name_raw: string | null;
  address_raw: string | null;
  suggested_record_id: number | null;
  suggested_station_id: string | null;
  score: number | null;
  weights: Record<string, unknown> | null;
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
  /** R77: ID сетей из /meta через запятую — персональный буст user_preferences в Score. */
  preferred_brands?: string;
  /** R78.1: «дешевле X» — только вместе с fuel; станции без цены исключаются. */
  price_max?: number;
}

/** R50: одна ячейка heatmap из /heat/cells (только снэпшот аналитики). */
export interface HeatCell {
  station_id: string;
  lat: number;
  lon: number;
  known: number;
  availability: number | null;
}

export interface HeatLevel {
  level: "high" | "medium" | "low";
  min_availability: number;
}

export interface HeatResponse {
  computed_at: string;
  stale: boolean;
  levels: HeatLevel[];
  cells: HeatCell[];
}

/** R49: прогноз появления/исчезновения топлива (прозрачная эвристика, не ML). */
export interface StationForecast {
  is_forecast: true;
  method: string;
  horizon_minutes: number;
  direction: "appearing" | "disappearing" | null;
  probability: number | null;
  eta_minutes: number | null;
  completed_episodes: number;
  current_outage_minutes: number | null;
  sufficiency: "ok" | "insufficient" | "no_data";
  reason: string | null;
  sample: {
    streams: number;
    episodes: number;
    completed: number;
    censored: number;
    window_minutes: number | null;
    mean_absence_minutes: number | null;
  };
}

/** R79: районы дефицита — группировка TTL-censored агрегатов по городу/региону. */
export interface DeficitByRegionOut {
  computed_at: string;
  stale: boolean;
  dimension: "city" | "region";
  basis: string;
  note: string;
  items: Array<{
    city?: string;
    region?: string;
    fuel: string;
    stations_observed: number;
    observed_source_streams: number;
    unavailable_transitions: number;
    completed_outages: number;
    censored_outages: number;
    mean_absence_minutes: number | null;
  }>;
}
