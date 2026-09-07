"""Сбор каталога из источников (T02, R01/R84).

Пайплайн: адаптер → нормализованная запись → source_station_records (без сети в API,
R83; дедупликация и привязка к stations — таск 03). Гарантии R84:
  - сбой одного источника не роняет остальные;
  - старые данные не удаляются (только upsert по source+external_id);
  - каждая ошибка — в collection_jobs/collection_logs и source_health;
  - статус источника никогда не превращается в «NO FUEL» из-за ошибки сети.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core import metrics
from ..db.models import (
    CollectionJob,
    CollectionLog,
    SourceHealth,
    SourceProvider,
    SourceStationRecord,
)
from ..sources import (
    AuthError,
    HealthResult,
    RateLimitedError,
    SourceAdapter,
    SourceRecord,
    build_adapter,
)
from ..sources.base import (
    HEALTH_AUTH_ERROR,
    HEALTH_DEGRADED,
    HEALTH_OFFLINE,
    HEALTH_ONLINE,
    HEALTH_RATE_LIMITED,
)

logger = logging.getLogger("fuelradar.ingest")


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class CatalogIngest:
    """Собирает source_station_records из активных адаптеров по региону."""

    def __init__(self, session: Session) -> None:
        self.session = session

    def collect_catalog(
        self,
        region: dict[str, Any],
        source_codes: list[str] | None = None,
        trigger: str = "manual",
        adapter_overrides: dict[str, SourceAdapter] | None = None,
    ) -> dict[str, dict[str, int]]:
        """Запуск сбора. Возвращает сводку {code: {records, errors}}.

        `adapter_overrides` — инъекция конкретных экземпляров (тесты/offline CLI).
        """
        overrides = adapter_overrides or {}
        providers = self._providers(source_codes)
        summary: dict[str, dict[str, int]] = {}

        for provider in providers:
            summary[provider.code] = self._collect_one(provider, region, trigger, overrides.get(provider.code))

        return summary

    def _providers(self, source_codes: list[str] | None) -> list[SourceProvider]:
        query = select(SourceProvider)
        if source_codes:
            query = query.where(SourceProvider.code.in_(source_codes))
        else:
            query = query.where(SourceProvider.status == "ACTIVE")
        return list(self.session.scalars(query.order_by(SourceProvider.code)))

    def _collect_one(
        self,
        provider: SourceProvider,
        region: dict[str, Any],
        trigger: str,
        adapter: SourceAdapter | None,
    ) -> dict[str, int]:
        job = CollectionJob(
            source_provider_id=provider.id,
            job_type="catalog",
            priority="P4",  # R55: базовый сбор каталога — P4
            trigger=trigger,
            status="RUNNING",
            started_at=_now(),
        )
        self.session.add(job)
        self.session.flush()

        try:
            if adapter is None:
                adapter = build_adapter(provider.code)
            records = adapter.discover_stations(region)
            for record in records:
                self._upsert_record(provider, record)
            job.status = "DONE"
            job.records_count = len(records)
            job.finished_at = _now()
            self._apply_health(provider, HealthResult(HEALTH_ONLINE, f"собрано {len(records)} записей"))
            self._log(job, provider, "INFO", f"сбор каталога: {len(records)} записей")
            metrics.inc(f"source.{provider.code}.records", len(records))
            metrics.inc("collect.jobs_done")
        except Exception as exc:  # noqa: BLE001 — изоляция источника (R84): ловим всё
            job.status = "FAILED"
            job.error_count = 1
            job.error_message = str(exc)[:1000]
            job.finished_at = _now()
            self._apply_health(provider, self._health_from_error(exc))
            self._log(job, provider, "ERROR", f"сбор каталога: {exc}")
            metrics.inc(f"source.{provider.code}.errors")
            metrics.inc("collect.jobs_failed")
            logger.warning("source %s failed: %s", provider.code, exc)
        self.session.commit()
        return {"records": job.records_count, "errors": job.error_count}

    def _upsert_record(self, provider: SourceProvider, record: SourceRecord) -> None:
        """История не перезаписывается (инвариант 5): upsert — это обновление той же
        записи источника, а не удаление прошлых наблюдений (их тут нет — T04)."""
        existing = self.session.scalar(
            select(SourceStationRecord).where(
                SourceStationRecord.source_provider_id == provider.id,
                SourceStationRecord.external_id == record.external_id,
            )
        )
        if existing is None:
            self.session.add(
                SourceStationRecord(
                    source_provider_id=provider.id,
                    external_id=record.external_id,
                    latitude=record.latitude,
                    longitude=record.longitude,
                    brand_raw=record.brand_raw,
                    name_raw=record.name_raw,
                    address_raw=record.address_raw,
                    payload=record.payload,
                    observed_at=_now(),
                    dedup_state="PENDING",
                )
            )
        else:
            existing.latitude = record.latitude
            existing.longitude = record.longitude
            existing.brand_raw = record.brand_raw or existing.brand_raw
            existing.name_raw = record.name_raw or existing.name_raw
            existing.address_raw = record.address_raw or existing.address_raw
            existing.payload = record.payload
            existing.observed_at = _now()

    def _apply_health(self, provider: SourceProvider, result: HealthResult) -> None:
        health = self.session.scalar(
            select(SourceHealth).where(SourceHealth.source_provider_id == provider.id)
        )
        if health is None:
            health = SourceHealth(source_provider_id=provider.id, consecutive_failures=0)
            self.session.add(health)
        health.last_check_at = _now()
        health.health = result.health
        if result.health == HEALTH_ONLINE:
            health.consecutive_failures = 0
            health.last_success_at = _now()
            health.last_error = ""
        else:
            health.consecutive_failures = (health.consecutive_failures or 0) + 1
            health.last_error = result.message
            if health.health == HEALTH_DEGRADED and health.consecutive_failures >= 3:
                health.health = HEALTH_OFFLINE

    @staticmethod
    def _health_from_error(exc: Exception) -> HealthResult:
        if isinstance(exc, RateLimitedError):
            return HealthResult(HEALTH_RATE_LIMITED, str(exc))
        if isinstance(exc, AuthError):
            return HealthResult(HEALTH_AUTH_ERROR, str(exc))
        return HealthResult(HEALTH_OFFLINE, str(exc))

    def _log(self, job: CollectionJob, provider: SourceProvider, level: str, message: str) -> None:
        self.session.add(
            CollectionLog(job_id=job.id, source_provider_id=provider.id, level=level, message=message)
        )