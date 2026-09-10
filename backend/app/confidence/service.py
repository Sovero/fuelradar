"""Сервис статусов (T04): наблюдения → station_current_status.

  - запись наблюдения = новая строка FuelObservation/QueueObservation (R17 —
    история не перезаписывается), затем пересчёт агрегата для (station, fuel);
  - пересчёт: свежие наблюдения + trust источника → aggregate → upsert
    station_current_status (R16) со score, разбором вкладов и очередью;
  - устаревание (R56): фоновая задача expire_stale() — протухшие статусы →
    UNKNOWN (не UNAVAILABLE), confidence падает;
  - reliability (R41): базовый счёт пользователя из истории отчётов.
"""

from __future__ import annotations

import logging
import math
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..core.config import settings
from ..db.models import (
    FuelObservation,
    FuelType,
    QueueObservation,
    SourceProvider,
    Station,
    StationBrand,
    StationCurrentStatus,
    UserReport,
)
from ..fuel_status import (
    UNKNOWN,
    validate_fuel_status,
    validate_queue_level,
)
from ..ranking import ScoreInput, estimated_wait_minutes
from ..ranking import score as compute_score
from .aggregate import AggregationConfig, ObservationInput, aggregate

logger = logging.getLogger("fuelradar.confidence")


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _cfg() -> AggregationConfig:
    return AggregationConfig(
        ttl_minutes=settings.ttl_fuel_minutes,
        share_strong=settings.confidence_share_strong,
        share_likely=settings.confidence_share_likely,
        min_weight=settings.confidence_min_weight,
        gps_boost=settings.gps_boost,
        gps_penalty=settings.gps_penalty,
    )


class StatusService:
    def __init__(self, session: Session) -> None:
        self.session = session

    # ---------- запись наблюдений (новые строки, R17) ----------

    def record_fuel_observation(
        self,
        station_id: str,
        fuel_code: str,
        status: str,
        source_provider_id: int,
        observed_at: datetime | None = None,
        commercial_name: str = "",
        user_reliability: float | None = None,
        gps_confirmed: bool | None = None,
        price: float | None = None,
        idempotency_key: str | None = None,
        report_id: int | None = None,
    ) -> FuelObservation:
        """Новое наблюдение → новая строка (R17) → пересчёт агрегата (R16)."""
        validate_fuel_status(status)
        if price is not None:
            if isinstance(price, bool) or not isinstance(price, (int, float)) or not math.isfinite(price):
                raise ValueError(f"цена для {fuel_code} должна быть конечным числом")
            if price <= 0:
                raise ValueError(f"цена для {fuel_code} должна быть больше нуля")
            if price > settings.price_max_reasonable:
                raise ValueError(f"цена для {fuel_code} не может превышать {settings.price_max_reasonable}")
        fuel_type = self._fuel_type(fuel_code)
        at = observed_at or _now()
        observation = FuelObservation(
            station_id=station_id,
            fuel_type_id=fuel_type.id,
            commercial_name=commercial_name,
            status=status,
            source_provider_id=source_provider_id,
            observed_at=at,
            received_at=_now(),
            expires_at=at + timedelta(minutes=settings.ttl_fuel_minutes),
            confidence_raw=user_reliability or 0.0,
            price=float(price) if price is not None else None,
            idempotency_key=idempotency_key,
            report_id=report_id,
        )
        self.session.add(observation)
        self.session.flush()
        self.recompute_station_fuel(station_id, fuel_type.id)
        self.session.commit()
        return observation

    def record_queue_observation(
        self,
        station_id: str,
        queue_level: str,
        source_provider_id: int,
        queue_vehicles: int | None = None,
        observed_at: datetime | None = None,
        idempotency_key: str | None = None,
    ) -> QueueObservation:
        """Новое наблюдение очереди → пересчёт очереди станции."""
        validate_queue_level(queue_level)
        at = observed_at or _now()
        observation = QueueObservation(
            station_id=station_id,
            queue_level=queue_level,
            queue_vehicles=queue_vehicles,
            source_provider_id=source_provider_id,
            observed_at=at,
            received_at=_now(),
            expires_at=at + timedelta(minutes=settings.ttl_queue_minutes),
        )
        self.session.add(observation)
        self.session.flush()
        self.recompute_station_queue(station_id)
        self.session.commit()
        return observation

    # ---------- пересчёт агрегатов ----------

    def recompute_station_fuel(self, station_id: str, fuel_type_id: int) -> StationCurrentStatus:
        all_rows = self.session.execute(
            select(FuelObservation, SourceProvider.trust)
            .join(SourceProvider, FuelObservation.source_provider_id == SourceProvider.id)
            .where(FuelObservation.station_id == station_id, FuelObservation.fuel_type_id == fuel_type_id)
            .order_by(FuelObservation.observed_at.desc(), FuelObservation.id.desc())
        ).all()
        # One vote per independent provider or reporter; repeated polls are history,
        # not additional independent evidence.
        latest: dict[tuple[int, int | None], Any] = {}
        for observation, trust in all_rows:
            report = self.session.get(UserReport, observation.report_id) if observation.report_id else None
            key = (observation.source_provider_id, report.user_id if report else None)
            latest.setdefault(key, (observation, trust))
        rows = list(latest.values())
        inputs = [
            ObservationInput(
                status=row.status,
                trust=trust,
                observed_at=row.observed_at,
                received_at=row.received_at,
                source_id=row.source_provider_id,
                user_reliability=row.confidence_raw if row.report_id is not None else None,
                gps_confirmed=self._gps_confirmed(row.report_id),
            )
            for row, trust in rows
        ]
        result = aggregate(inputs, _cfg())
        # Цена — не голос: сохраняем последнее свежее допустимое ценовое
        # наблюдение даже если более новый опрос этого источника цену не передал.
        price_meta = self._latest_price(all_rows)
        row = self._upsert_status(station_id, fuel_type_id, result, price_meta)
        usable = [observation for observation, trust in rows if trust > 0 and observation.status != UNKNOWN]
        if usable:
            row.expires_at = max(observation.expires_at for observation in usable)
            row.updated_at = max(observation.observed_at for observation in usable)
        from ..alerts.service import evaluate_rules  # T07: события из diff состояния (R35/R37)

        evaluate_rules(self.session, station_id, fuel_type_id)
        return row

    def recompute_station_queue(self, station_id: str) -> None:
        rows = self.session.execute(
            select(QueueObservation, SourceProvider.trust)
            .join(SourceProvider, QueueObservation.source_provider_id == SourceProvider.id)
            .where(QueueObservation.station_id == station_id)
        ).all()
        ttl = settings.ttl_queue_minutes
        now = _now()
        votes: dict[str, float] = {}
        best: QueueObservation | None = None
        best_weight = 0.0
        for row, trust in rows:
            age = max(0.0, (now - row.observed_at).total_seconds() / 60.0)
            f = 1.0 - 0.5 * age / ttl if age < ttl else 0.0
            if f <= 0.0:
                continue
            weight = trust * f
            votes[row.queue_level] = votes.get(row.queue_level, 0.0) + weight
            if weight > best_weight:
                best_weight = weight
                best = row
        if not votes:
            self._expire_queue(station_id)
            return
        level = max(votes, key=votes.get)
        vehicles = best.queue_vehicles if best is not None else None
        wait = estimated_wait_minutes(vehicles, level)
        from ..alerts.service import evaluate_rules  # T07: события из diff состояния (R35/R37)

        for status_row in self.session.scalars(
            select(StationCurrentStatus).where(StationCurrentStatus.station_id == station_id)
        ):
            status_row.queue_level = level
            status_row.queue_vehicles = vehicles
            status_row.estimated_wait_minutes = wait
            evaluate_rules(self.session, station_id, status_row.fuel_type_id)

    def recompute_station(self, station_id: str) -> None:
        fuel_ids = set(
            self.session.scalars(
                select(FuelObservation.fuel_type_id).where(FuelObservation.station_id == station_id)
            )
        )
        for fuel_type_id in fuel_ids:
            self.recompute_station_fuel(station_id, fuel_type_id)
        self.recompute_station_queue(station_id)
        self.session.commit()

    def _upsert_status(
        self, station_id: str, fuel_type_id: int, result: Any, price_meta: dict | None = None
    ) -> StationCurrentStatus:
        row = self.session.scalar(
            select(StationCurrentStatus).where(
                StationCurrentStatus.station_id == station_id,
                StationCurrentStatus.fuel_type_id == fuel_type_id,
            )
        )
        now = _now()
        station = self.session.get(Station, station_id)
        priority = None
        if station is not None and station.brand_id is not None:
            brand = self.session.get(StationBrand, station.brand_id)
            priority = brand.priority if brand is not None else None

        score_result = compute_score(
            ScoreInput(
                fuel_status=result.status,
                confidence=result.confidence,
                observed_age_minutes=result.age_minutes,
                distance_km=None,  # нейтрально: позиция пользователя добавится в API (T05)
                queue_level=UNKNOWN,
                network_priority=priority,
                ttl_minutes=settings.ttl_fuel_minutes,
            )
        )

        explanation = {
            "status": result.status,
            "share": result.share,
            "total_weight": result.total_weight,
            "contributions": [
                {
                    "source_provider_id": c.source_id,
                    "status": c.status,
                    "age_minutes": c.age_minutes,
                    "freshness": c.freshness,
                    "weight": c.weight,
                }
                for c in result.contributions
            ],
        }

        if row is None:
            row = StationCurrentStatus(
                station_id=station_id,
                fuel_type_id=fuel_type_id,
                status=result.status,
                confidence=result.confidence,
                updated_at=now,
                expires_at=now + timedelta(minutes=settings.ttl_fuel_minutes),
                score=score_result.score,
                score_breakdown=score_result.breakdown,
                status_explanation=explanation,
                price=price_meta["price"] if price_meta else None,
                price_currency=price_meta["currency"] if price_meta else "RUB",
                price_source_provider_id=price_meta["source_provider_id"] if price_meta else None,
                price_updated_at=price_meta["updated_at"] if price_meta else None,
            )
            self.session.add(row)
        else:
            row.status = result.status
            row.confidence = result.confidence
            row.updated_at = now
            row.expires_at = now + timedelta(minutes=settings.ttl_fuel_minutes)
            row.score = score_result.score
            row.score_breakdown = score_result.breakdown
            row.status_explanation = explanation
            row.price = price_meta["price"] if price_meta else None
            row.price_currency = price_meta["currency"] if price_meta else "RUB"
            row.price_source_provider_id = price_meta["source_provider_id"] if price_meta else None
            row.price_updated_at = price_meta["updated_at"] if price_meta else None
        self.session.flush()
        return row

    # ---------- устаревание (R56) ----------

    def expire_stale(self) -> int:
        """Протухшие статусы → UNKNOWN, confidence падает (не UNAVAILABLE!)."""
        now = _now()
        rows = list(
            self.session.scalars(
                select(StationCurrentStatus).where(
                    StationCurrentStatus.expires_at < now,
                    StationCurrentStatus.status != UNKNOWN,
                )
            )
        )
        for row in rows:
            row.status = UNKNOWN
            row.confidence = 0
            row.updated_at = now
            row.expires_at = now + timedelta(minutes=settings.ttl_fuel_minutes)
            row.score = 0.0
            row.score_breakdown = {}
            row.status_explanation = {
                "expired": True,
                "note": "нет свежих наблюдений — статус UNKNOWN, а не UNAVAILABLE (R56)",
            }
            self._expire_queue_for(row)
        self.session.commit()
        if rows:
            logger.info("expire_stale: %d статусов переведены в UNKNOWN", len(rows))
        return len(rows)

    def _expire_queue(self, station_id: str) -> None:
        for row in self.session.scalars(
            select(StationCurrentStatus).where(StationCurrentStatus.station_id == station_id)
        ):
            self._expire_queue_for(row)

    @staticmethod
    def _expire_queue_for(row: StationCurrentStatus) -> None:
        row.queue_level = UNKNOWN
        row.queue_vehicles = None
        row.estimated_wait_minutes = None

    # ---------- репутация пользователя (R41, базовый счёт) ----------

    def reliability_score(self, user_id: int) -> float:
        """Базовый счёт: старт 0.5, каждый GPS-подтверждённый отчёт +0.1 (кап 0.95)."""
        confirmed = self.session.scalar(
            select(func.count()).select_from(UserReport).where(
                UserReport.user_id == user_id,
                UserReport.gps_confirmed.is_(True),
            )
        )
        return min(settings.reliability_base + 0.1 * (confirmed or 0), 0.95)

    # ---------- хелперы ----------

    def _fuel_type(self, fuel_code: str) -> FuelType:
        fuel = self.session.scalar(select(FuelType).where(FuelType.code == fuel_code))
        if fuel is None:
            raise ValueError(f"неизвестный код топлива: {fuel_code}")
        return fuel

    def _gps_confirmed(self, report_id: int | None) -> bool | None:
        if report_id is None:
            return None
        report = self.session.get(UserReport, report_id)
        return report.gps_confirmed if report is not None else None

    @staticmethod
    def _latest_price(rows: list[tuple[FuelObservation, float]]) -> dict | None:
        """R78/§24: последняя допустимая цена из свежих наблюдений.

        Цена не является голосом confidence: выбирается именно самое новое
        допустимое ценовое наблюдение (при равном времени — большая id), а не
        источник с максимальным trust×freshness. История остаётся доступной,
        поэтому новый опрос без цены не затирает последнюю известную цену, пока
        она не вышла за TTL (R78.3).
        """
        now = _now()
        ttl = settings.ttl_fuel_minutes
        candidates: list[FuelObservation] = []
        for observation, trust in rows:
            price = observation.price
            if trust <= 0 or price is None:
                continue
            if isinstance(price, bool) or not isinstance(price, (int, float)) or not math.isfinite(price):
                continue
            if price <= 0 or price > settings.price_max_reasonable:
                continue
            age = max(0.0, (now - observation.observed_at).total_seconds() / 60.0)
            if age < ttl:
                candidates.append(observation)
        if not candidates:
            return None
        observation = max(candidates, key=lambda item: (item.observed_at, item.id))
        return {
            "price": observation.price,
            "currency": observation.currency or "RUB",
            "source_provider_id": observation.source_provider_id,
            "updated_at": observation.observed_at,
        }
