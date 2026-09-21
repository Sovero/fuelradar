"""Отчёт → наблюдение → пересчёт confidence (R39/R40).

Записью наблюдений заведует `confidence.service.StatusService` (T04) — этот
модуль только: находит/создаёт `UserReport` (идемпотентно, R39.1), считает
GPS-подтверждение (R40) и передаёт данные в `StatusService`. Событие уведомления
о смене статуса возникает автоматически — `StatusService.recompute_station_*`
вызывает `alerts.evaluate_rules` (см. хук в `confidence/service.py`).
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..confidence.service import StatusService
from ..core.config import settings
from ..db.models import FuelType, SourceProvider, Station, UserReport
from ..dedup.compare import distance_km
from ..fuel_status import validate_queue_level
from .schemas import ReportBody


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class ReportError(ValueError):
    """Ошибка отчёта, отображаемая в HTTP-код на уровне роутера."""


def submit_report(session: Session, body: ReportBody) -> tuple[UserReport, bool]:
    """Возвращает (report, created). created=False — идемпотентный повтор (R39.1)."""
    existing = session.scalar(select(UserReport).where(UserReport.idempotency_key == body.idempotency_key))
    if existing is not None:
        return existing, False

    if not body.fuel and body.queue is None:
        raise ReportError("Отчёт должен содержать хотя бы один вид топлива или очередь")

    station = session.get(Station, body.station_id)
    if station is None:
        raise ReportError("station_not_found")

    distance_m: float | None = None
    gps_confirmed = False
    if body.lat is not None and body.lon is not None:
        distance_m = distance_km(body.lat, body.lon, station.latitude, station.longitude) * 1000.0
        gps_confirmed = distance_m < settings.gps_proximity_m  # R40: строго < 300 м

    report = UserReport(
        station_id=body.station_id,
        latitude=body.lat,
        longitude=body.lon,
        distance_to_station_m=distance_m,
        gps_confirmed=gps_confirmed,
        idempotency_key=body.idempotency_key,
    )
    session.add(report)
    session.flush()  # нужен report.id до вызова record_fuel_observation (report_id=)

    provider_id = _user_reports_provider_id(session)
    statuses = StatusService(session)
    # Отчёты анонимны: отправитель один — тот, кто запустил приложение. Доверие к
    # отчёту даёт не история конкретного человека, а подтверждение GPS (R40:
    # GPS_BOOST/GPS_PENALTY в aggregate), поэтому берём базовый счёт из конфига.
    user_reliability = settings.reliability_base
    observed_at = _now()

    for fuel_code, status in body.fuel.items():
        fuel_type = session.scalar(select(FuelType).where(FuelType.code == fuel_code))
        if fuel_type is None:
            continue  # неизвестный код мягко игнорируется — нормализация не наша зона (T03)
        price = body.prices.get(fuel_code)  # R78: цена идёт в ту же append-only observation
        statuses.record_fuel_observation(
            station_id=body.station_id,
            fuel_code=fuel_code,
            status=status,
            source_provider_id=provider_id,
            observed_at=observed_at,
            user_reliability=user_reliability,
            price=price,
            idempotency_key=f"{body.idempotency_key}:{fuel_code}",
            report_id=report.id,
        )

    if body.queue is not None:
        validate_queue_level(body.queue)
        statuses.record_queue_observation(
            station_id=body.station_id,
            queue_level=body.queue,
            source_provider_id=provider_id,
            observed_at=observed_at,
        )

    session.commit()
    return report, True


def _user_reports_provider_id(session: Session) -> int:
    provider = session.scalar(select(SourceProvider).where(SourceProvider.code == "user_reports"))
    if provider is None:
        raise RuntimeError("source_provider 'user_reports' отсутствует — должен быть засеян init_db (T01)")
    return provider.id
