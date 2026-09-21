"""T04 — Confidence Engine: агрегация (unit) и сервис статусов (интеграция).

Числовые примеры — из брифа: единогласие свежих источников → AVAILABLE ~94–97%;
конфликт 2:1 → LIKELY_AVAILABLE 67%; протухшее наблюдение → UNKNOWN, не UNAVAILABLE.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select

from app.confidence import AggregationConfig, ObservationInput, StatusService, aggregate
from app.db.models import (
    FuelObservation,
    FuelType,
    SourceProvider,
    Station,
    StationCurrentStatus,
)
from app.db.session import init_db
from app.fuel_status import (
    AVAILABLE,
    LIKELY_AVAILABLE,
    LOW_STOCK,
    UNAVAILABLE,
    UNCERTAIN,
    UNKNOWN,
)


@pytest.fixture(scope="module", autouse=True)
def _db() -> None:
    init_db()


def _ago(minutes: float) -> datetime:
    return datetime.now(UTC).replace(tzinfo=None) - timedelta(minutes=minutes)


CFG = AggregationConfig(ttl_minutes=120, share_strong=0.8, share_likely=0.6, min_weight=0.3, gps_boost=1.2, gps_penalty=0.6)

# ---------- unit: пример брифа §22 — единогласие свежих источников ----------


def test_unanimous_fresh_sources_high_confidence() -> None:
    """Официальный (15 мин) + второй источник (20 мин) + 2 пользователя с места → ~97."""
    obs = [
        ObservationInput(AVAILABLE, trust=0.7, observed_at=_ago(15), source_id=1),           # официальный
        ObservationInput(AVAILABLE, trust=0.6, observed_at=_ago(20), source_id=2),           # второй
        ObservationInput(AVAILABLE, trust=0.4, observed_at=_ago(5), source_id=3,
                         user_reliability=0.5, gps_confirmed=True),
        ObservationInput(AVAILABLE, trust=0.4, observed_at=_ago(9), source_id=3,
                         user_reliability=0.5, gps_confirmed=True),
    ]
    result = aggregate(obs, CFG)
    assert result.status == AVAILABLE
    assert 90 <= result.confidence <= 97  # «~97%-типа» из брифа
    assert len(result.contributions) == 4
    assert result.age_minutes == 5  # «обновлено N назад» — по лучшему источнику


def test_conflict_two_to_one_is_likely_67() -> None:
    """Бриф §23: A есть / B нет / C есть → LIKELY_AVAILABLE 67%, не крайний статус (R19)."""
    obs = [
        ObservationInput(AVAILABLE, trust=0.7, observed_at=_ago(0), source_id=1),
        ObservationInput(UNAVAILABLE, trust=0.7, observed_at=_ago(0), source_id=2),
        ObservationInput(AVAILABLE, trust=0.7, observed_at=_ago(0), source_id=3),
    ]
    result = aggregate(obs, CFG)
    assert result.status == LIKELY_AVAILABLE
    assert result.confidence == 67
    assert result.share == pytest.approx(2 / 3, abs=0.001)


# ---------- unit: TTL и пустота → UNKNOWN, не UNAVAILABLE (R03/R56) ----------


def test_expired_observation_is_unknown_not_unavailable() -> None:
    obs = [ObservationInput(UNAVAILABLE, trust=0.9, observed_at=_ago(130), source_id=1)]  # старше TTL 120
    result = aggregate(obs, CFG)
    assert result.status == UNKNOWN
    assert result.confidence == 0
    assert result.status != UNAVAILABLE


def test_no_observations_is_unknown() -> None:
    result = aggregate([], CFG)
    assert result.status == UNKNOWN
    assert result.confidence == 0


def test_expired_does_not_vote() -> None:
    """Протухший «нет» не влияет на свежее «есть» (R84/R56)."""
    obs = [
        ObservationInput(AVAILABLE, trust=0.7, observed_at=_ago(10), source_id=1),
        ObservationInput(UNAVAILABLE, trust=0.9, observed_at=_ago(150), source_id=2),
    ]
    result = aggregate(obs, CFG)
    assert result.status == AVAILABLE


# ---------- unit: минимальный вес (R19.1) и GPS-вес (R40) ----------


def test_single_weak_report_is_uncertain() -> None:
    """Один слабый сигнал не меняет статус — «под вопросом» (R19.1)."""
    obs = [ObservationInput(AVAILABLE, trust=0.4, observed_at=_ago(0), source_id=3,
                            user_reliability=0.5, gps_confirmed=False)]
    result = aggregate(obs, CFG)
    assert result.status == UNCERTAIN  # вес 0.4×0.5×0.6 = 0.12 < min_weight


def test_gps_confirmed_reports_outweigh_distant() -> None:
    """R40/R40.1: с места (< 300 м) вес выше, «издалека» — ниже."""
    gps = aggregate(
        [
            ObservationInput(AVAILABLE, trust=0.4, observed_at=_ago(0), source_id=3,
                             user_reliability=0.5, gps_confirmed=True),
            ObservationInput(AVAILABLE, trust=0.4, observed_at=_ago(0), source_id=3,
                             user_reliability=0.5, gps_confirmed=True),
        ],
        CFG,
    )
    far = aggregate(
        [
            ObservationInput(AVAILABLE, trust=0.4, observed_at=_ago(0), source_id=3,
                             user_reliability=0.5, gps_confirmed=False),
            ObservationInput(AVAILABLE, trust=0.4, observed_at=_ago(0), source_id=3,
                             user_reliability=0.5, gps_confirmed=False),
        ],
        CFG,
    )
    assert gps.status == AVAILABLE   # 0.48 ≥ min_weight
    assert far.status == UNCERTAIN   # 0.24 < min_weight
    assert gps.confidence > far.confidence


def test_low_stock_majority() -> None:
    obs = [ObservationInput(LOW_STOCK, trust=0.8, observed_at=_ago(0), source_id=1)]
    result = aggregate(obs, AggregationConfig(ttl_minutes=120, share_strong=0.8, share_likely=0.6, min_weight=0.1))
    assert result.status == LOW_STOCK


# ---------- интеграция: сервис статусов и БД ----------


def _add_provider(db_session, code: str, trust: float) -> SourceProvider:
    provider = db_session.scalar(select(SourceProvider).where(SourceProvider.code == code))
    if provider is None:
        provider = SourceProvider(code=code, name=code, capabilities={"discovery": False}, status="TEST", trust=trust)
        db_session.add(provider)
        db_session.flush()
    return provider


def _add_station(db_session, station_id: str) -> Station:
    station = db_session.get(Station, station_id)
    if station is None:
        station = Station(id=station_id, canonical_name="Тестовая АЗС", latitude=45.0, longitude=39.0)
        db_session.add(station)
        db_session.flush()
    return station


def test_record_observation_updates_status(db_session) -> None:
    """R16/R17: наблюдение — новая строка; station_current_status пересчитывается."""
    station = _add_station(db_session, "fr_station_940001")
    official = _add_provider(db_session, "t04_official", 0.7)
    service = StatusService(db_session)

    service.record_fuel_observation(station.id, "AI_95", AVAILABLE, official.id, observed_at=_ago(10))

    # история: строка наблюдения сохранена (R17)
    obs_count = db_session.scalar(
        select(func.count()).select_from(FuelObservation).where(FuelObservation.station_id == station.id)
    )
    assert obs_count == 1

    fuel_id = db_session.scalar(select(FuelType.id).where(FuelType.code == "AI_95"))
    row = db_session.scalar(
        select(StationCurrentStatus).where(
            StationCurrentStatus.station_id == station.id,
            StationCurrentStatus.fuel_type_id == fuel_id,
        )
    )
    assert row is not None
    assert row.status == AVAILABLE
    assert 50 <= row.confidence <= 97  # один источник, свежий — высокая доля, свежесть ~0.96
    assert row.score > 0
    assert "fuel_available" in row.score_breakdown
    assert row.status_explanation["contributions"]

    # второе наблюдение — новая строка истории, статус-строка та же (upsert)
    status_row_id = row.id
    service.record_fuel_observation(station.id, "AI_95", AVAILABLE, official.id, observed_at=_ago(2))
    obs_count = db_session.scalar(
        select(func.count()).select_from(FuelObservation).where(FuelObservation.station_id == station.id)
    )
    assert obs_count == 2
    row = db_session.get(StationCurrentStatus, status_row_id)
    assert row.status == AVAILABLE
    assert row.confidence > 45  # два независимых подтверждения — выше


def test_queue_observation_preserves_vehicles(db_session) -> None:
    """R20: исходное число машин сохраняется; ожидание считается по конфигу."""
    station = _add_station(db_session, "fr_station_940002")
    provider = _add_provider(db_session, "t04_users", 0.4)
    service = StatusService(db_session)
    service.record_fuel_observation(station.id, "AI_95", AVAILABLE, provider.id, observed_at=_ago(5))
    service.record_queue_observation(station.id, "MEDIUM", provider.id, queue_vehicles=5)

    row = db_session.scalar(select(StationCurrentStatus).where(StationCurrentStatus.station_id == station.id))
    assert row.queue_level == "MEDIUM"
    assert row.queue_vehicles == 5  # оригинал числа (R20.2)
    assert row.estimated_wait_minutes == round(5 * 80 / 60)  # ~80 с/машина (§18)


def test_expire_stale_sets_unknown(db_session) -> None:
    """R56: протухший статус → UNKNOWN (не UNAVAILABLE), confidence падает."""
    station = _add_station(db_session, "fr_station_940003")
    provider = _add_provider(db_session, "t04_official2", 0.9)
    service = StatusService(db_session)
    service.record_fuel_observation(station.id, "AI_95", AVAILABLE, provider.id, observed_at=_ago(1))

    row = db_session.scalar(select(StationCurrentStatus).where(StationCurrentStatus.station_id == station.id))
    assert row.status == AVAILABLE

    # время течёт: expires_at в прошлом
    from datetime import datetime, timedelta

    row.expires_at = datetime.now(UTC).replace(tzinfo=None) - timedelta(minutes=1)
    db_session.commit()

    expired = service.expire_stale()
    assert expired >= 1

    db_session.refresh(row)
    assert row.status == UNKNOWN
    assert row.status != UNAVAILABLE  # инвариант R15/R56
    assert row.confidence == 0
    assert row.queue_level == UNKNOWN
    assert row.estimated_wait_minutes is None
    assert row.status_explanation["expired"] is True

    # повторный прогон ничего не ломает
    assert service.expire_stale() >= 0
