"""Persistent priority queue with source-wide rate limiting and crash recovery."""

from __future__ import annotations

import hashlib
import logging
import math
import time
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from ..confidence.service import StatusService
from ..core import metrics
from ..core.config import settings
from ..db.models import (
    AlertRule,
    CollectionJob,
    CollectionLog,
    Favorite,
    FuelObservation,
    FuelType,
    MonitoringZone,
    QueueObservation,
    SourceHealth,
    SourceProvider,
    SourceStationRecord,
    Station,
    StationCurrentStatus,
    StationExternalId,
)
from ..dedup.service import DedupService
from ..fuel_status import UNKNOWN, validate_fuel_status, validate_queue_level
from ..normalization.fuel import normalize_fuel
from ..sources import SourceAdapter, build_adapter
from ..sources.base import HEALTH_DEGRADED, AuthError, RateLimitedError
from ..stations.ingest import CatalogIngest
from .locking import worker_lock

logger = logging.getLogger("fuelradar.worker")


def utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def schedule_priority_job(
    session: Session, source_provider_id: int, *, station_id: str | None = None,
    job_type: str = "catalog", priority: str = "P4", trigger: str = "schedule",
    now: datetime | None = None,
) -> CollectionJob:
    """Enqueue or promote pending work, without network calls or committing caller data."""
    if priority not in {"P1", "P2", "P3", "P4"}:
        raise ValueError("priority must be P1–P4")
    if job_type not in {"catalog", "availability", "queue"}:
        raise ValueError("unknown collection job type")
    if job_type != "catalog" and station_id is None:
        raise ValueError("station_id is required for observation collection")
    at = now or utcnow()
    job = session.scalar(select(CollectionJob).where(
        CollectionJob.source_provider_id == source_provider_id,
        CollectionJob.station_id == station_id, CollectionJob.job_type == job_type,
        CollectionJob.status.in_(["PENDING", "RUNNING"]),
    ).order_by(CollectionJob.id))
    if job is None:
        job = CollectionJob(source_provider_id=source_provider_id, station_id=station_id,
                            job_type=job_type, priority=priority, trigger=trigger,
                            status="PENDING", next_run_at=at)
        session.add(job)
    elif job.status == "PENDING":
        job.priority = min(priority, job.priority)
        if trigger == "manual":
            job.trigger = trigger
            job.next_run_at = min(job.next_run_at, at)
    session.flush()
    return job


def rate_limit_floor(db: Session, provider: SourceProvider, *,
                     apply_backoff: bool = True) -> datetime | None:
    """Момент, раньше которого воркер не возьмёт следующее задание источника.

    Здесь две разные причины отсрочки, и их нельзя смешивать:
    - `min_interval_minutes` — потолок частоты обращения к адаптеру (R54). Он
      действует при любом триггере, включая ручной: «Обновить сейчас» и импорт
      CSV не имеют права опрашивать источник чаще его rate limit.
    - backoff после сбоев — расписание автоматических повторных попыток (R56),
      а не свойство источника. Явный запрос оператора (R53.1) не должен молча
      ждать, пока источник «отдохнёт», поэтому для ручных заданий backoff не
      применяется (`apply_backoff=False`) — потолок частоты остаётся.
    """
    last = db.scalar(select(func.max(CollectionJob.started_at)).where(
        CollectionJob.source_provider_id == provider.id))
    if last is None:
        return None
    delay = max(0, provider.min_interval_minutes)
    if apply_backoff:
        health = db.scalar(select(SourceHealth).where(SourceHealth.source_provider_id == provider.id))
        if health and health.consecutive_failures:
            delay = max(delay, min(settings.worker_backoff_max_minutes,
                                   settings.collect_default_minutes * 2 ** min(health.consecutive_failures - 1, 12)))
    return last + timedelta(minutes=delay)


def apply_bulk_availability(
    db: Session, provider: SourceProvider, adapter: SourceAdapter, at: datetime | None = None,
) -> int:
    """Наличие из источника-списка → наблюдения (R17) — без заданий на каждую АЗС.

    Источник уже принёс статусы в `discover_stations()` одним запросом: здесь они
    привязываются к станциям, которые каталог разрешил (station_id проставляет
    дедупликация), и записываются через `StatusService` — тот же Confidence
    Engine (R16), что и для отчётов водителей, со своей очередью и TTL (R56).
    Точечные источники сюда не попадают: у них пустой `bulk_fuel_availability()`.

    Возвращает число записанных наблюдений. Повторная выгрузка того же списка с
    тем же временем наблюдения не создаёт дублей (idempotency_key): один список,
    разобранный дважды, — одно свидетельство, а не два (R17). «Не знаю» из
    источника наблюдением не становится: UNKNOWN ≠ UNAVAILABLE (R15).
    """
    batch = adapter.bulk_fuel_availability()
    if not batch:
        return 0
    rows = db.execute(
        select(SourceStationRecord.external_id, SourceStationRecord.station_id).where(
            SourceStationRecord.source_provider_id == provider.id,
            SourceStationRecord.external_id.in_(list(batch)),
            SourceStationRecord.station_id.is_not(None),
        )
    ).all()
    service = StatusService(db)
    written = 0
    stamp = at or utcnow()
    for external_id, station_id in rows:
        for item in batch[external_id]:
            fuel_code = item.get("fuel_code") or item.get("fuel") or ""
            status = item.get("status", "")
            if not fuel_code or status == UNKNOWN:
                continue
            observed = item.get("observed_at", stamp)
            if isinstance(observed, str):
                observed = datetime.fromisoformat(observed)
            if observed.tzinfo is not None:
                observed = observed.astimezone(UTC).replace(tzinfo=None)
            key = hashlib.sha256(
                f"{provider.id}:{external_id}:{fuel_code}:{observed.isoformat()}:{status}".encode()
            ).hexdigest()
            if db.scalar(select(FuelObservation.id).where(FuelObservation.idempotency_key == key)):
                continue
            service.record_fuel_observation(
                station_id, fuel_code, status, provider.id,
                observed_at=observed,
                commercial_name=item.get("commercial_name", ""),
                idempotency_key=key,
                commit=False,  # один коммит на всю выгрузку, а не на каждую АЗС
            )
            written += 1
    return written


def in_zone(station: Station, zone: MonitoringZone) -> bool:
    """Evaluate stored city, circle or GeoJSON-style polygon monitoring zones."""
    params = zone.params
    kind = zone.zone_type.upper()
    if kind == "CITY":
        return station.city.casefold() == str(params.get("city", "")).casefold()
    if kind == "CIRCLE":
        lat, lon = params.get("lat"), params.get("lon")
        if lat is None or lon is None:
            return False
        a, b = math.radians(station.latitude), math.radians(float(lat))
        dlon = math.radians(station.longitude - float(lon))
        h = math.sin((a - b) / 2) ** 2 + math.cos(a) * math.cos(b) * math.sin(dlon / 2) ** 2
        distance = 6371 * 2 * math.asin(min(1, math.sqrt(h)))
        return distance <= float(params.get("radius_km", params.get("radius", 0)))
    points = params.get("polygon", params.get("coordinates", []))
    if isinstance(points, dict):
        points = points.get("coordinates", [])
    if points and isinstance(points[0][0], list):
        points = points[0]
    inside = False
    if len(points) < 3:
        return False
    x, y = station.longitude, station.latitude
    for i, (x1, y1) in enumerate(points):
        x2, y2 = points[i - 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


class Worker:
    """One serial collector per database; durable jobs survive process restarts."""

    def __init__(self, session_factory: sessionmaker[Session], region: dict[str, Any],
                 adapter_overrides: dict[str, SourceAdapter] | None = None) -> None:
        self.sessions = session_factory
        self.region = region
        self.adapters = adapter_overrides or {}
        self._analytics_at: datetime | None = None

    def station_priority(self, db: Session, station: Station) -> str:
        favorites = list(db.scalars(select(Favorite).where(Favorite.station_id == station.id)))
        zones = {z.id: z for z in db.scalars(select(MonitoringZone))}
        for rule in db.scalars(select(AlertRule).where(AlertRule.is_active.is_(True))):
            scope = rule.scope
            kind = scope.get("type", "")
            if scope.get("station_id") == station.id:
                return "P1"
            # Пользователей нет: «избранное» и зоны — один общий набор, поэтому
            # правило по ним относится к любой станции из набора (сужает сам scope).
            if (kind == "favorites" or scope.get("favorites")) and favorites:
                return "P1"
            zone_id = scope.get("zone_id")
            zone = zones.get(zone_id)
            if zone and in_zone(station, zone):
                return "P1"
            brand_id = scope.get("brand_id", scope.get("network_id"))
            if brand_id is not None and station.brand_id == brand_id:
                return "P1"
        if favorites:
            return "P2"
        if any(in_zone(station, z) for z in zones.values()):
            return "P3"
        return "P4"

    def interval(self, db: Session, station_id: str | None, priority: str) -> int:
        states = list(db.scalars(select(StationCurrentStatus.status).where(
            StationCurrentStatus.station_id == station_id))) if station_id else []
        if any(s in {"LOW_STOCK", "UNAVAILABLE", "UNCERTAIN"} for s in states):
            return settings.collect_deficit_minutes
        if priority in {"P1", "P2"}:
            return settings.collect_favorite_minutes
        if states and all(s == "AVAILABLE" for s in states):
            return settings.collect_stable_minutes
        return settings.collect_default_minutes

    def waiting_reason(self, code: str) -> str | None:
        """Почему источник пока не может собирать (нет файла/URL) — или None.

        Конкретику знает адаптер («файла нет», «URL не задан»), планировщик её
        только спрашивает — тем же реестром, что и сбор. Подменённые в тестах
        адаптеры отвечают None по базовому контракту: поведение не меняется.
        """
        adapter = self.adapters.get(code)
        if adapter is None:
            try:
                adapter = build_adapter(code)
            except KeyError:
                return None
        return adapter.not_configured_reason()

    @staticmethod
    def _mark_waiting(db: Session, provider_id: int, at: datetime, message: str) -> None:
        """«Ждёт данных» — не сбой: DEGRADED, счётчик неудач с нуля (R84/R58).

        Иначе источник, включённый в сбор раньше, чем настроенный (файл не
        загружен, URL не задан), копил бы FAILED и красную строку «N подряд»
        просто за ожидание. Пишем только при изменении состояния — тик не
        трогает строку впустую.
        """
        health = db.scalar(select(SourceHealth).where(SourceHealth.source_provider_id == provider_id))
        if health is None:
            health = SourceHealth(source_provider_id=provider_id, consecutive_failures=0)
            db.add(health)
        if health.health == HEALTH_DEGRADED and health.last_error == message and not health.consecutive_failures:
            return
        health.health, health.last_check_at, health.last_error = HEALTH_DEGRADED, at, message
        health.consecutive_failures = 0

    def plan(self, db: Session, now: datetime) -> None:
        """Derive due work from durable completion times, coalescing missed cycles."""
        for provider in db.scalars(select(SourceProvider).where(SourceProvider.status == "ACTIVE")):
            # Reports are pushed by users, never polled as an external feed.
            if provider.code == "user_reports":
                continue
            # Источник без настроенных данных (файл не загружен, URL не задан) не
            # опрашивается: это «ждёт данных», а не сбой (R84). Причина уйдёт —
            # планирование вернётся само на ближайшем тике.
            waiting = self.waiting_reason(provider.code)
            if waiting is not None:
                self._mark_waiting(db, provider.id, now, waiting)
                continue
            targets: list[tuple[str | None, str, str]] = []
            if provider.capabilities.get("discovery"):
                targets.append((None, "catalog", "P4"))
            # Источники-списки отдают наличие вместе с каталогом одним запросом
            # (availability_bulk): точечные задания на каждую АЗС им не нужны —
            # иначе один и тот же список выкачивался бы N раз, а потолок частоты
            # источника пропускал бы лишь одно задание за такт. Очередь это не
            # касается: у источника-списка она может быть своим потоком данных.
            bulk_availability = bool(provider.capabilities.get("availability_bulk"))
            needs_station_loop = any(
                provider.capabilities.get(kind) and not (kind == "availability" and bulk_availability)
                for kind in ("availability", "queue")
            )
            if needs_station_loop:
                for external in db.scalars(select(StationExternalId).where(
                    StationExternalId.source_provider_id == provider.id)):
                    station = db.get(Station, external.station_id)
                    if station is None or not station.is_active:
                        continue
                    priority = self.station_priority(db, station)
                    for kind in ("availability", "queue"):
                        if kind == "availability" and bulk_availability:
                            continue
                        if provider.capabilities.get(kind):
                            targets.append((station.id, kind, priority))
            for station_id, kind, priority in targets:
                latest = db.scalar(select(CollectionJob).where(
                    CollectionJob.source_provider_id == provider.id,
                    CollectionJob.station_id == station_id, CollectionJob.job_type == kind,
                ).order_by(CollectionJob.id.desc()))
                if latest and latest.status in {"PENDING", "RUNNING"}:
                    latest.priority = min(priority, latest.priority)
                    continue
                due = latest.next_run_at if latest else now
                if latest and latest.status == "DONE" and latest.finished_at:
                    due = latest.finished_at + timedelta(minutes=self.interval(db, station_id, priority))
                if due <= now:
                    schedule_priority_job(db, provider.id, station_id=station_id,
                                          job_type=kind, priority=priority, now=now)
        db.commit()

    def run_once(self, now: datetime | None = None) -> list[int]:
        """Recover abandoned claims and process eligible jobs in P1–P4 order."""
        at = now or utcnow()
        with self.sessions() as db, worker_lock(db.get_bind()) as acquired:
            if not acquired:
                return []
            # Exclusive OS/advisory lock proves no other collector owns these rows.
            for abandoned in db.scalars(select(CollectionJob).where(CollectionJob.status == "RUNNING")):
                abandoned.status = "PENDING"
                abandoned.lock_token = None
                abandoned.locked_until = None
            db.commit()
            self.plan(db, at)
            completed = []
            jobs = list(db.scalars(select(CollectionJob).where(
                CollectionJob.status == "PENDING", CollectionJob.next_run_at <= at,
            ).order_by(CollectionJob.priority, CollectionJob.next_run_at, CollectionJob.id)))
            for job in jobs:
                provider = db.get(SourceProvider, job.source_provider_id)
                if provider is None or provider.status != "ACTIVE":
                    continue
                # Ручной триггер не ждёт backoff расписания (см. rate_limit_floor)
                floor = rate_limit_floor(db, provider, apply_backoff=job.trigger != "manual")
                if floor is not None and floor > at:
                    job.next_run_at = floor
                    db.commit()
                    continue
                self._execute(db, job, provider, at)
                completed.append(job.id)
            statuses = StatusService(db)
            statuses.expire_stale()
            for station_id in db.scalars(select(StationCurrentStatus.station_id).distinct()):
                statuses.recompute_station_queue(station_id)
            db.commit()
            if completed or self._analytics_at is None or at >= self._analytics_at + timedelta(minutes=settings.collect_default_minutes):
                from ..analytics.service import refresh_analytics
                refresh_analytics(db, now=at)
                db.commit()
                self._analytics_at = at
            # Telegram-дайджест (R64): ту же защиту от дублей, что и сбор, —
            # сводку берёт процесс, владеющий локом. Сбой канала не роняет сбор.
            try:
                from ..digest.service import maybe_send_digest
                digest_status = maybe_send_digest(db, now=at)
                if digest_status not in {"not_configured", "disabled", "not_due"}:
                    logger.info("telegram digest: %s", digest_status)
            except Exception as exc:  # noqa: BLE001 — канал не часть сбора (T07-правило изоляции)
                logger.warning("telegram digest failed: %s", type(exc).__name__)
            return completed

    @staticmethod
    def _apply_catalog_availability(
        db: Session, job_id: int, provider_id: int, code: str, adapter: SourceAdapter, at: datetime,
    ) -> None:
        """Наличие из списка — отдельно от судьбы каталога (R84: ошибки не смешиваются).

        Каталог уже собран и закоммичен; если наличие записать не удалось (например,
        в справочнике нет топлива), это фиксируется в collection_logs и метриках, но
        не превращает успешный сбор каталога в FAILED и не переводит источник в OFFLINE.
        """
        try:
            provider = db.get(SourceProvider, provider_id)
            written = apply_bulk_availability(db, provider, adapter, at)
            skipped = int(getattr(adapter, "skipped_fuel_values", 0) or 0)
            if written or skipped:
                # Источники без наличия (чистый каталог) в журнал не пишут — строка
                # «availability: 0» ничего не сообщала бы оператору.
                db.add(CollectionLog(
                    job_id=job_id, source_provider_id=provider_id, level="INFO",
                    message=f"availability: {written} наблюдений"
                    + (f", {skipped} значений не распознано" if skipped else ""),
                ))
            db.commit()
            metrics.inc(f"source.{code}.availability", written)
        except Exception as exc:  # noqa: BLE001 — наличие — не часть каталога (R84)
            db.rollback()
            db.add(CollectionLog(
                job_id=job_id, source_provider_id=provider_id, level="ERROR",
                message=f"availability: {type(exc).__name__}",
            ))
            db.commit()
            logger.warning("availability from %s failed: %s", code, type(exc).__name__)

    def _execute(self, db: Session, job: CollectionJob, provider: SourceProvider, at: datetime) -> None:
        job.status, job.started_at = "RUNNING", at
        db.commit()  # durable rate-limit reservation before any network request
        started = time.monotonic()
        code, job_id, provider_id = provider.code, job.id, provider.id
        metrics.inc(f"source.{code}.requests")
        try:
            adapter = self.adapters.get(code) or build_adapter(code)
            if adapter.research_required:
                raise ValueError("Source requires research")
            count = self._collect(db, job, provider, adapter, at)
            job.status, job.records_count, job.finished_at = "DONE", count, at
            job.next_run_at = at + timedelta(minutes=self.interval(db, job.station_id, job.priority))
            self._health(db, provider_id, at, "ONLINE", "")
            db.add(CollectionLog(job_id=job_id, source_provider_id=provider_id,
                                 level="INFO", message=f"{job.job_type}: {count} records"))
            db.commit()  # observations + job completion are atomic
            metrics.inc(f"source.{code}.records", count)
            if job.job_type == "catalog":
                DedupService(db).process_pending(region=self.region)
                self._apply_catalog_availability(db, job_id, provider_id, code, adapter, at)
        except Exception as exc:
            db.rollback()
            job = db.get(CollectionJob, job_id)
            job.status, job.finished_at = "FAILED", at
            job.error_count += 1
            # Do not persist arbitrary HTTP exception text (may contain credentials).
            message = type(exc).__name__
            job.error_message = message
            state = "RATE_LIMITED" if isinstance(exc, RateLimitedError) else "AUTH_ERROR" if isinstance(exc, AuthError) else "OFFLINE"
            health = self._health(db, provider_id, at, state, message)
            delay = min(settings.worker_backoff_max_minutes,
                        settings.collect_default_minutes * 2 ** min(health.consecutive_failures - 1, 12))
            job.next_run_at = at + timedelta(minutes=max(delay, provider.min_interval_minutes))
            db.add(CollectionLog(job_id=job_id, source_provider_id=provider_id, level="ERROR", message=message))
            db.commit()
            metrics.inc(f"source.{code}.errors")
        finally:
            metrics.set_gauge(f"source.{code}.duration_ms", int((time.monotonic() - started) * 1000))

    @staticmethod
    def _health(db: Session, provider_id: int, at: datetime, state: str, message: str) -> SourceHealth:
        health = db.scalar(select(SourceHealth).where(SourceHealth.source_provider_id == provider_id))
        if health is None:
            health = SourceHealth(source_provider_id=provider_id, consecutive_failures=0)
            db.add(health)
        health.health, health.last_check_at, health.last_error = state, at, message
        health.consecutive_failures = 0 if state == "ONLINE" else health.consecutive_failures + 1
        if state == "ONLINE":
            health.last_success_at = at
        return health

    def _collect(self, db: Session, job: CollectionJob, provider: SourceProvider,
                 adapter: SourceAdapter, at: datetime) -> int:
        if job.job_type == "catalog":
            records = adapter.discover_stations(self.region)
            for record in records:
                CatalogIngest(db)._upsert_record(provider, record)
            return len(records)
        external = db.scalar(select(StationExternalId).where(
            StationExternalId.station_id == job.station_id,
            StationExternalId.source_provider_id == provider.id))
        if external is None:
            raise ValueError("Station has no identifier for this source")
        service = StatusService(db)
        if job.job_type == "availability":
            records = adapter.get_fuel_availability(external.external_id)
            for record in records:
                fuel = normalize_fuel(record.get("fuel_code", record.get("fuel", "")))
                fuel_type = db.scalar(select(FuelType).where(FuelType.code == fuel.base_code))
                if fuel_type is None:
                    raise ValueError("Unknown fuel dictionary code")
                status = record["status"]
                validate_fuel_status(status)
                observed = record.get("observed_at", at)
                if isinstance(observed, str):
                    observed = datetime.fromisoformat(observed)
                if observed.tzinfo is not None:
                    observed = observed.astimezone(UTC).replace(tzinfo=None)
                key = hashlib.sha256(f"{provider.id}:{external.external_id}:{fuel_type.id}:{observed.isoformat()}:{status}".encode()).hexdigest()
                if db.scalar(select(FuelObservation.id).where(FuelObservation.idempotency_key == key)):
                    continue
                db.add(FuelObservation(station_id=job.station_id, fuel_type_id=fuel_type.id,
                    commercial_name=fuel.commercial_name, status=status, source_provider_id=provider.id,
                    observed_at=observed, expires_at=observed + timedelta(minutes=settings.ttl_fuel_minutes),
                    idempotency_key=key, price=record.get("price")))
                db.flush()
                service.recompute_station_fuel(job.station_id, fuel_type.id)
            return len(records)
        queue = adapter.get_queue_status(external.external_id)
        if queue is None:
            return 0
        level = queue.get("queue_level", queue.get("level", "UNKNOWN"))
        validate_queue_level(level)
        observed = queue.get("observed_at", at)
        if isinstance(observed, str):
            observed = datetime.fromisoformat(observed)
        if observed.tzinfo is not None:
            observed = observed.astimezone(UTC).replace(tzinfo=None)
        exists = db.scalar(select(QueueObservation.id).where(
            QueueObservation.station_id == job.station_id,
            QueueObservation.source_provider_id == provider.id,
            QueueObservation.observed_at == observed, QueueObservation.queue_level == level))
        if not exists:
            db.add(QueueObservation(station_id=job.station_id, source_provider_id=provider.id,
                queue_level=level, queue_vehicles=queue.get("queue_vehicles", queue.get("vehicles")),
                observed_at=observed, expires_at=observed + timedelta(minutes=settings.ttl_queue_minutes)))
            db.flush()
            service.recompute_station_queue(job.station_id)
        return 1

