"""Все базовые таблицы брифа §83 (R62) + журнал админ-действий и решения дедупликации.

SQLite (dev) / PostgreSQL+PostGIS (prod): координаты хранятся числами (dev) и
geography-типом (prod); различие обрабатывается в geo-модуле (T03+), здесь — нейтральная схема.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base


def _now() -> datetime:
    # наивное UTC для хранения (SQLite/Postgres без timezone) — без deprecation
    return datetime.now(UTC).replace(tzinfo=None)


# ---------- справочники ----------

class FuelType(Base):  # §83 fuel_types; §15 брифа
    __tablename__ = "fuel_types"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True)  # AI_92 … CNG, UNKNOWN, OTHER
    display_name_ru: Mapped[str] = mapped_column(String(64))


class FuelBrand(Base):  # §83 fuel_brands — коммерческие названия (ЭКТО, G-Drive…)
    __tablename__ = "fuel_brands"

    id: Mapped[int] = mapped_column(primary_key=True)
    fuel_type_id: Mapped[int] = mapped_column(ForeignKey("fuel_types.id"))
    name: Mapped[str] = mapped_column(String(64))  # «ЭКТО» (R13.4)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


class StationBrand(Base):  # §83 station_brands — сети АЗС
    __tablename__ = "station_brands"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True)
    canonical_name: Mapped[str] = mapped_column(String(128))
    priority: Mapped[int] = mapped_column(Integer, default=5)  # R77: 1=высокий … 5=низкий


# ---------- источники ----------

class SourceProvider(Base):  # §83 source_providers
    __tablename__ = "source_providers"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(64), unique=True)  # osm_overpass, network_import, user_reports, yandex, twogis, lukoil…
    name: Mapped[str] = mapped_column(String(128))
    capabilities: Mapped[dict] = mapped_column(JSON, default=dict)  # {discovery, availability, queue}
    status: Mapped[str] = mapped_column(String(32), default="ACTIVE")  # ACTIVE | RESEARCH_REQUIRED | NOT_USED (R12)
    min_interval_minutes: Mapped[int] = mapped_column(Integer, default=60)  # R54 — потолок
    attribution: Mapped[str] = mapped_column(String(256), default="")  # «© OpenStreetMap contributors» (R81.1)
    trust: Mapped[float] = mapped_column(Float, default=0.5)  # R18/R95i — вес источника


# ---------- станции ----------

class Station(Base):  # §83 stations; §7 брифа
    __tablename__ = "stations"
    __table_args__ = (Index("ix_stations_lat_lon", "latitude", "longitude"),)  # R82 — spatial-поиск

    id: Mapped[str] = mapped_column(String(32), primary_key=True)  # fr_station_000184 (R07)
    brand_id: Mapped[int | None] = mapped_column(ForeignKey("station_brands.id"), nullable=True)
    canonical_name: Mapped[str] = mapped_column(String(256), default="")
    latitude: Mapped[float] = mapped_column(Float)
    longitude: Mapped[float] = mapped_column(Float)
    address: Mapped[str] = mapped_column(String(512), default="")
    city: Mapped[str] = mapped_column(String(128), default="")
    region: Mapped[str] = mapped_column(String(128), default="")
    country: Mapped[str] = mapped_column(String(64), default="RU")
    phone: Mapped[str] = mapped_column(String(64), default="")
    opening_hours: Mapped[str] = mapped_column(String(256), default="")
    services: Mapped[dict] = mapped_column(JSON, default=dict)
    brand_station_number: Mapped[str] = mapped_column(String(64), default="")
    official_url: Mapped[str] = mapped_column(String(512), default="")
    entrance_latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    entrance_longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    road_side: Mapped[str] = mapped_column(String(64), default="")
    status: Mapped[str] = mapped_column(String(32), default="ACTIVE")  # ACTIVE | INACTIVE | UNVERIFIED
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)


class StationExternalId(Base):  # §83 station_external_ids; §8 брифа
    __tablename__ = "station_external_ids"
    __table_args__ = (UniqueConstraint("source_provider_id", "external_id", name="uq_ext_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    station_id: Mapped[str] = mapped_column(ForeignKey("stations.id"), index=True)
    source_provider_id: Mapped[int] = mapped_column(ForeignKey("source_providers.id"))
    external_id: Mapped[str] = mapped_column(String(256))  # node/789456, 12345678…


class SourceStationRecord(Base):  # §83 source_station_records
    __tablename__ = "source_station_records"

    id: Mapped[int] = mapped_column(primary_key=True)
    source_provider_id: Mapped[int] = mapped_column(ForeignKey("source_providers.id"), index=True)
    external_id: Mapped[str] = mapped_column(String(256), default="")
    station_id: Mapped[str | None] = mapped_column(ForeignKey("stations.id"), nullable=True, index=True)
    latitude: Mapped[float] = mapped_column(Float)
    longitude: Mapped[float] = mapped_column(Float)
    brand_raw: Mapped[str] = mapped_column(String(256), default="")
    name_raw: Mapped[str] = mapped_column(String(256), default="")
    address_raw: Mapped[str] = mapped_column(String(512), default="")
    payload: Mapped[str] = mapped_column(Text, default="")  # raw-ответ источника (диагностика, TTL §18)
    observed_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    dedup_state: Mapped[str] = mapped_column(String(32), default="PENDING")  # PENDING|MERGED|REVIEW|SPLIT


# ---------- наблюдения и текущее состояние ----------

class FuelObservation(Base):  # §83/§84 fuel_observations
    __tablename__ = "fuel_observations"

    id: Mapped[int] = mapped_column(primary_key=True)
    station_id: Mapped[str] = mapped_column(ForeignKey("stations.id"), index=True)
    fuel_type_id: Mapped[int] = mapped_column(ForeignKey("fuel_types.id"))
    commercial_name: Mapped[str] = mapped_column(String(64), default="")  # R13.4
    status: Mapped[str] = mapped_column(String(32))  # AVAILABLE…UNKNOWN (R14)
    source_provider_id: Mapped[int] = mapped_column(ForeignKey("source_providers.id"))
    observed_at: Mapped[datetime] = mapped_column(DateTime, index=True)  # R16
    received_at: Mapped[datetime] = mapped_column(DateTime, default=_now)  # R16
    expires_at: Mapped[datetime] = mapped_column(DateTime, default=_now)  # R16 — пересчитывается по TTL
    confidence_raw: Mapped[float] = mapped_column(Float, default=0.0)
    price: Mapped[float | None] = mapped_column(Float, nullable=True)  # R78 — поле заложено
    currency: Mapped[str] = mapped_column(String(8), default="RUB")
    report_id: Mapped[int | None] = mapped_column(ForeignKey("user_reports.id"), nullable=True)
    idempotency_key: Mapped[str | None] = mapped_column(String(128), nullable=True, unique=True)
    raw_payload_ref: Mapped[str] = mapped_column(String(256), default="")


class QueueObservation(Base):  # §83 queue_observations
    __tablename__ = "queue_observations"

    id: Mapped[int] = mapped_column(primary_key=True)
    station_id: Mapped[str] = mapped_column(ForeignKey("stations.id"), index=True)
    queue_level: Mapped[str] = mapped_column(String(16), default="UNKNOWN")  # NONE…VERY_HIGH|UNKNOWN
    queue_vehicles: Mapped[int | None] = mapped_column(Integer, nullable=True)  # R20 — оригинал числа
    source_provider_id: Mapped[int] = mapped_column(ForeignKey("source_providers.id"))
    observed_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    received_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    expires_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    report_id: Mapped[int | None] = mapped_column(ForeignKey("user_reports.id"), nullable=True)


class StationCurrentStatus(Base):  # §83/§85 station_current_status — результат агрегации
    __tablename__ = "station_current_status"
    __table_args__ = (UniqueConstraint("station_id", "fuel_type_id", name="uq_station_fuel_status"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    station_id: Mapped[str] = mapped_column(ForeignKey("stations.id"), index=True)
    fuel_type_id: Mapped[int] = mapped_column(ForeignKey("fuel_types.id"))
    status: Mapped[str] = mapped_column(String(32), default="UNKNOWN")  # R14/R15
    confidence: Mapped[int] = mapped_column(Integer, default=0)  # 0–100 (R18)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    expires_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    score: Mapped[float] = mapped_column(Float, default=0.0)  # R43
    score_breakdown: Mapped[dict] = mapped_column(JSON, default=dict)  # R43.1
    queue_level: Mapped[str] = mapped_column(String(16), default="UNKNOWN")
    queue_vehicles: Mapped[int | None] = mapped_column(Integer, nullable=True)
    estimated_wait_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)  # R20/R45
    eta_minutes: Mapped[float | None] = mapped_column(Float, nullable=True)  # R45
    # R78 (T13): последняя допустимая цена выбранного топлива — с источником и временем,
    # никогда не 0 при отсутствии данных (nullable, «нет данных» = None).
    price: Mapped[float | None] = mapped_column(Float, nullable=True)  # R78
    price_currency: Mapped[str] = mapped_column(String(8), default="RUB")  # R78
    price_source_provider_id: Mapped[int | None] = mapped_column(ForeignKey("source_providers.id"), nullable=True)  # R78
    price_updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)  # R78.3 — «не путать старую цену»
    status_explanation: Mapped[dict] = mapped_column(JSON, default=dict)  # R71 — источники и вклады


# ---------- пользователи и персонализация ----------

class User(Base):  # §83 users
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    telegram_id: Mapped[str | None] = mapped_column(String(64), nullable=True, unique=True)
    email: Mapped[str | None] = mapped_column(String(256), nullable=True)
    reliability_score: Mapped[float] = mapped_column(Float, default=0.5)  # R41
    is_blocked: Mapped[bool] = mapped_column(Boolean, default=False)  # R41.1
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class MonitoringZone(Base):  # §83 monitoring_zones
    __tablename__ = "monitoring_zones"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(128), default="")
    zone_type: Mapped[str] = mapped_column(String(32))  # CITY | CIRCLE | POLYGON (R21)
    params: Mapped[dict] = mapped_column(JSON, default=dict)  # lat/lon/radius | polygon | city
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class Favorite(Base):  # §83 favorites
    __tablename__ = "favorites"
    __table_args__ = (UniqueConstraint("user_id", "station_id", name="uq_user_station"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    station_id: Mapped[str] = mapped_column(ForeignKey("stations.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class PushSubscription(Base):  # T14 (R64/R97i): браузерные push-подписки Web Push
    """Endpoint + ключи шифрования браузера. Секреты пользователя (не сервера):
    p256dh/auth нужны для шифрования payload, хранятся обязательно (спека Web Push),
    но никогда не возвращаются API и не логируются (R68).

    Уникальность endpoint — идемпотентный POST: повторная подписка того же браузера
    обновляет p256dh/auth (браузер их ротирует), а не создаёт дубликаты.
    """

    __tablename__ = "push_subscriptions"
    __table_args__ = (
        UniqueConstraint("endpoint", name="uq_push_endpoint"),
        Index("ix_push_subscriptions_user", "user_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    endpoint: Mapped[str] = mapped_column(Text)
    p256dh: Mapped[str] = mapped_column(String(128))
    auth: Mapped[str] = mapped_column(String(64))
    user_agent: Mapped[str] = mapped_column(String(256), default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_error: Mapped[str] = mapped_column(String(256), default="")


# ---------- уведомления ----------

class AlertRule(Base):  # §83 alert_rules
    __tablename__ = "alert_rules"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(128), default="")
    fuel_type_id: Mapped[int | None] = mapped_column(ForeignKey("fuel_types.id"), nullable=True)
    distance_km: Mapped[float | None] = mapped_column(Float, nullable=True)
    status_filter: Mapped[str | None] = mapped_column(String(32), nullable=True)
    confidence_min: Mapped[int | None] = mapped_column(Integer, nullable=True)
    queue_max: Mapped[str | None] = mapped_column(String(16), nullable=True)
    scope: Mapped[dict] = mapped_column(JSON, default=dict)  # zone | favorites | network (R77/R25)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    trigger_count: Mapped[int] = mapped_column(Integer, default=0)
    last_event_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class AlertEvent(Base):  # §83 alert_events
    __tablename__ = "alert_events"
    __table_args__ = (UniqueConstraint("dedup_key", name="uq_alert_dedup"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    rule_id: Mapped[int | None] = mapped_column(ForeignKey("alert_rules.id"), nullable=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    station_id: Mapped[str] = mapped_column(ForeignKey("stations.id"))
    event_type: Mapped[str] = mapped_column(String(32))  # R35: FUEL_APPEARED …
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    dedup_key: Mapped[str] = mapped_column(String(256), default="")  # R38
    delivered: Mapped[bool] = mapped_column(Boolean, default=False)  # in-app лента (R36/A03)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now, index=True)


# ---------- отчёты пользователей ----------

class UserReport(Base):  # §83 user_reports
    __tablename__ = "user_reports"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    station_id: Mapped[str | None] = mapped_column(ForeignKey("stations.id"), nullable=True)
    latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    distance_to_station_m: Mapped[float | None] = mapped_column(Float, nullable=True)  # R40
    gps_confirmed: Mapped[bool] = mapped_column(Boolean, default=False)  # R40: < 300 м
    idempotency_key: Mapped[str] = mapped_column(String(128), unique=True)  # R39.1
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


# ---------- сбор и здоровье источников ----------

class CollectionJob(Base):  # §83 collection_jobs
    __tablename__ = "collection_jobs"
    __table_args__ = (
        Index("uq_collection_active", "source_provider_id", "job_type", text("coalesce(station_id, '')"),
              unique=True, sqlite_where=text("status IN ('PENDING','RUNNING')"),
              postgresql_where=text("status IN ('PENDING','RUNNING')")),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    station_id: Mapped[str | None] = mapped_column(ForeignKey("stations.id"), nullable=True)
    next_run_at: Mapped[datetime] = mapped_column(DateTime, default=_now, index=True)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    lock_token: Mapped[str | None] = mapped_column(String(64), nullable=True)
    source_provider_id: Mapped[int] = mapped_column(ForeignKey("source_providers.id"))
    job_type: Mapped[str] = mapped_column(String(32), default="catalog")  # catalog | availability | queue
    priority: Mapped[str] = mapped_column(String(4), default="P4")  # R55: P1…P4
    trigger: Mapped[str] = mapped_column(String(16), default="schedule")  # schedule | manual | seed
    status: Mapped[str] = mapped_column(String(16), default="PENDING")  # PENDING|RUNNING|DONE|FAILED
    records_count: Mapped[int] = mapped_column(Integer, default=0)
    error_count: Mapped[int] = mapped_column(Integer, default=0)
    error_message: Mapped[str] = mapped_column(Text, default="")
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class CollectionLog(Base):  # §83 collection_logs
    __tablename__ = "collection_logs"

    id: Mapped[int] = mapped_column(primary_key=True)
    job_id: Mapped[int | None] = mapped_column(ForeignKey("collection_jobs.id"), nullable=True)
    source_provider_id: Mapped[int] = mapped_column(ForeignKey("source_providers.id"))
    level: Mapped[str] = mapped_column(String(16), default="INFO")
    message: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now, index=True)


class SourceHealth(Base):  # §83 source_health
    __tablename__ = "source_health"

    id: Mapped[int] = mapped_column(primary_key=True)
    source_provider_id: Mapped[int] = mapped_column(ForeignKey("source_providers.id"), unique=True)
    health: Mapped[str] = mapped_column(String(16), default="UNKNOWN")  # R57: ONLINE|DEGRADED|OFFLINE|RATE_LIMITED|AUTH_ERROR
    last_check_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    consecutive_failures: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str] = mapped_column(Text, default="")


# ---------- интеграции, настраиваемые из админки (T17) ----------

class TelegramIntegration(Base):
    """Единственная строка (id=1): токен бота, введённый администратором через
    /admin (а не только .env) — R36/R97i. Значение из БД имеет приоритет над
    TELEGRAM_BOT_TOKEN из окружения, см. app/integrations/telegram.py."""

    __tablename__ = "telegram_integration"

    id: Mapped[int] = mapped_column(primary_key=True)
    bot_token: Mapped[str] = mapped_column(Text)
    bot_username: Mapped[str] = mapped_column(String(64), default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_error: Mapped[str] = mapped_column(Text, default="")


# ---------- служебные журналы ----------

class AdminActionLog(Base):  # R67 — журналирование действий администратора
    __tablename__ = "admin_action_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    actor: Mapped[str] = mapped_column(String(64), default="admin")
    action: Mapped[str] = mapped_column(String(64))  # merge|split|block_user|set_trust|refresh_source|admin_auth_failed…
    target_type: Mapped[str] = mapped_column(String(32), default="")
    target_id: Mapped[str] = mapped_column(String(64), default="")
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class DedupDecision(Base):  # R10 — решения дедупликации (объяснимость и откат)
    __tablename__ = "dedup_decisions"

    id: Mapped[int] = mapped_column(primary_key=True)
    decision: Mapped[str] = mapped_column(String(16))  # MERGE|SPLIT|REVIEW|AUTO_MERGE
    left_record_id: Mapped[int] = mapped_column(ForeignKey("source_station_records.id"))
    right_record_id: Mapped[int] = mapped_column(ForeignKey("source_station_records.id"))
    score: Mapped[float] = mapped_column(Float, default=0.0)
    weights: Mapped[dict] = mapped_column(JSON, default=dict)  # R10.1 — разбор по весам
    actor: Mapped[str] = mapped_column(String(32), default="system")  # system | admin
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
