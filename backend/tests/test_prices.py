"""T13 — цена топлива end-to-end (R78, §24): агрегат, отчёты, price_max, совместимость."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.confidence.service import StatusService
from app.db.models import FuelObservation, SourceProvider, Station, StationCurrentStatus

pytestmark = pytest.mark.usefixtures("client")

STATION_A = "fr_station_130001"  # дешёвая
STATION_B = "fr_station_130002"  # дорогая
STATION_C = "fr_station_130003"  # доступна, цены нет
STATION_SVC = "fr_station_130010"  # агрегация цены сервисом
STATION_IDEM = "fr_station_130011"  # идемпотентность отчёта с ценой
STATION_RPT = "fr_station_130012"  # отчёт с ценой → API отдаёт цену


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _seed_station(db_session, station_id: str, lat: float = 45.0, lon: float = 39.0) -> None:
    if db_session.get(Station, station_id) is None:
        db_session.add(Station(id=station_id, canonical_name=f"АЗС {station_id}", latitude=lat, longitude=lon))
        db_session.commit()


def _provider(db_session, code: str = "network_import") -> SourceProvider:
    return db_session.scalar(select(SourceProvider).where(SourceProvider.code == code))


def _set_price_status(db_session, station_id: str, fuel_code: str, price: float | None) -> None:
    """Свежее AVAILABLE-наблюдение (с ценой или без) → пересчёт агрегата."""
    service = StatusService(db_session)
    service.record_fuel_observation(
        station_id=station_id,
        fuel_code=fuel_code,
        status="AVAILABLE",
        source_provider_id=_provider(db_session).id,
        observed_at=_now(),
        price=price,
    )


def _key() -> str:
    return f"t13-{uuid.uuid4().hex[:24]}"


# ---------- агрегация цены (§24: «последняя допустимая цена с источником и временем») ----------


def test_aggregate_keeps_latest_fresh_price_with_source_and_time(db_session):
    _seed_station(db_session, STATION_SVC)
    provider = _provider(db_session)
    service = StatusService(db_session)

    old = _now() - timedelta(minutes=100)
    fresh = _now() - timedelta(minutes=10)
    service.record_fuel_observation(
        station_id=STATION_SVC, fuel_code="AI_95", status="AVAILABLE",
        source_provider_id=provider.id, observed_at=old, price=63.0,
    )
    service.record_fuel_observation(
        station_id=STATION_SVC, fuel_code="AI_95", status="AVAILABLE",
        source_provider_id=provider.id, observed_at=fresh, price=62.0,
    )

    row = db_session.scalar(
        select(StationCurrentStatus).where(StationCurrentStatus.station_id == STATION_SVC)
    )
    assert row.price == 62.0  # свежее наблюдение перевешивает (та же модель trust×свежесть)
    assert row.price_source_provider_id == provider.id
    assert row.price_updated_at == fresh
    assert row.price_currency == "RUB"


def test_new_status_observation_without_price_keeps_fresh_known_price(db_session):
    """Отсутствующая цена в новом опросе не стирает ещё актуальную цену (R78.3)."""
    station_id = "fr_station_130013"
    _seed_station(db_session, station_id)
    provider = _provider(db_session)
    service = StatusService(db_session)
    priced_at = _now() - timedelta(minutes=5)
    service.record_fuel_observation(
        station_id=station_id, fuel_code="AI_95", status="AVAILABLE",
        source_provider_id=provider.id, observed_at=priced_at, price=62.7,
    )
    service.record_fuel_observation(
        station_id=station_id, fuel_code="AI_95", status="AVAILABLE",
        source_provider_id=provider.id, observed_at=_now(), price=None,
    )
    row = db_session.scalar(
        select(StationCurrentStatus).where(StationCurrentStatus.station_id == station_id)
    )
    assert row.price == 62.7
    assert row.price_updated_at == priced_at


def test_expired_observation_does_not_supply_price(db_session):
    _seed_station(db_session, STATION_SVC)
    provider = _provider(db_session)
    service = StatusService(db_session)

    stale = _now() - timedelta(minutes=200)  # за TTL (120 мин) — не голосует (R56/R78.3)
    service.record_fuel_observation(
        station_id=STATION_SVC, fuel_code="DIESEL", status="AVAILABLE",
        source_provider_id=provider.id, observed_at=stale, price=59.9,
    )

    from app.db.models import FuelType

    diesel_id = db_session.scalar(select(FuelType.id).where(FuelType.code == "DIESEL"))
    row = db_session.scalar(
        select(StationCurrentStatus).where(
            StationCurrentStatus.station_id == STATION_SVC,
            StationCurrentStatus.fuel_type_id == diesel_id,
        )
    )
    assert row.price is None and row.price_updated_at is None


# ---------- отчёты с ценой (R78.2/R78.4) ----------


def test_report_with_price_stores_observation_and_exposes_price(client, db_session):
    _seed_station(db_session, STATION_RPT)
    r = client.post(
        "/api/v1/reports",
        json={
            "station_id": STATION_RPT,
            "fuel": {"AI_95": "AVAILABLE"},
            "prices": {"AI_95": 62.4},
            "idempotency_key": _key(),
        },
    )
    assert r.status_code == 201
    assert r.json()["created"] is True

    obs = db_session.scalar(
        select(FuelObservation).where(FuelObservation.station_id == STATION_RPT).order_by(FuelObservation.id.desc())
    )
    assert obs is not None and obs.price == 62.4

    detail = client.get(f"/api/v1/stations/{STATION_RPT}").json()
    status_row = next(s for s in detail["statuses"] if s["fuel_code"] == "AI_95")
    assert status_row["price"] == 62.4
    assert status_row["price_currency"] == "RUB"
    assert status_row["price_updated_at"] is not None


@pytest.mark.parametrize(
    "prices",
    [
        {"AI_95": 0},           # ≤0 (R78.4)
        {"AI_95": -5},          # отрицательная
        {"AI_95": 500},         # «чрезмерное значение» (> price_max_reasonable)
        {"AI_98": 62},          # цена без статуса этого же топлива
    ],
)
def test_report_rejects_invalid_prices_with_422(client, db_session, prices):
    _seed_station(db_session, STATION_RPT)
    r = client.post(
        "/api/v1/reports",
        json={"station_id": STATION_RPT, "fuel": {"AI_95": "AVAILABLE"}, "prices": prices, "idempotency_key": _key()},
    )
    assert r.status_code == 422


def test_report_price_is_idempotent(client, db_session):
    _seed_station(db_session, STATION_IDEM)
    key = _key()
    body = {
        "station_id": STATION_IDEM,
        "fuel": {"AI_95": "AVAILABLE"},
        "prices": {"AI_95": 61.0},
        "idempotency_key": key,
    }
    first = client.post("/api/v1/reports", json=body)
    assert first.status_code == 201 and first.json()["created"] is True
    second = client.post("/api/v1/reports", json=body)
    assert second.status_code == 201 and second.json()["created"] is False

    count = len(db_session.scalars(select(FuelObservation).where(FuelObservation.station_id == STATION_IDEM)).all())
    assert count == 1  # повтор не дублирует наблюдение (R39.1/R78.4)


# ---------- price_max-фильтр (R78.1: «где АИ-95 есть дешевле 75, не далее 10 км») ----------


def _seed_priced_stations(db_session) -> None:
    _seed_station(db_session, STATION_A)
    _seed_station(db_session, STATION_B)
    _seed_station(db_session, STATION_C)
    _set_price_status(db_session, STATION_A, "AI_95", 62.0)
    _set_price_status(db_session, STATION_B, "AI_95", 64.0)
    _set_price_status(db_session, STATION_C, "AI_95", None)


def test_price_max_filter_returns_only_cheap_stations(client, db_session):
    _seed_priced_stations(db_session)
    r = client.get(
        "/api/v1/stations",
        params={"lat": 45.0, "lon": 39.0, "radius_km": 50, "fuel": "AI_95", "price_max": 63},
    )
    assert r.status_code == 200
    ids = [s["id"] for s in r.json()]
    assert STATION_A in ids
    assert STATION_B not in ids  # дорогая
    assert STATION_C not in ids  # без цены — не считается дешёвой (R78.1)


def test_price_max_without_fuel_is_rejected(client, db_session):
    _seed_priced_stations(db_session)
    r = client.get("/api/v1/stations", params={"lat": 45.0, "lon": 39.0, "radius_km": 50, "price_max": 63})
    assert r.status_code == 422
    assert "price_max" in r.json()["detail"]


def test_price_max_validation(client, db_session):
    _seed_priced_stations(db_session)
    for bad in (0, -1):
        r = client.get(
            "/api/v1/stations",
            params={"lat": 45.0, "lon": 39.0, "radius_km": 50, "fuel": "AI_95", "price_max": bad},
        )
        assert r.status_code == 422


def test_station_without_price_shows_no_data_not_zero(client, db_session):
    _seed_priced_stations(db_session)
    detail = client.get(f"/api/v1/stations/{STATION_C}").json()
    status_row = next(s for s in detail["statuses"] if s["fuel_code"] == "AI_95")
    assert status_row["price"] is None
    assert status_row["price_updated_at"] is None  # R78.3: «нет данных», не ноль


def test_expired_status_hides_price(client, db_session):
    _seed_priced_stations(db_session)
    row = db_session.scalar(select(StationCurrentStatus).where(StationCurrentStatus.station_id == STATION_A))
    original = row.expires_at
    row.expires_at = _now() - timedelta(minutes=1)
    db_session.commit()
    try:
        detail = client.get(f"/api/v1/stations/{STATION_A}").json()
        status_row = next(s for s in detail["statuses"] if s["fuel_code"] == "AI_95")
        assert status_row["status"] == "UNKNOWN"
        assert status_row["price"] is None  # протухло всё наблюдение — цена тоже не «свежая»
    finally:
        row.expires_at = original  # общая session-БД: не оставлять протухший статус другим тестам
        db_session.commit()


# ---------- обратная совместимость ----------


def test_expire_stale_clears_price(client, db_session):
    """R78.3: expire_stale перезаряжает expires_at в будущее — цена не должна
    «реанимироваться» после прохода воркера (регрессия T13-ревью)."""
    _seed_priced_stations(db_session)
    row = db_session.scalar(select(StationCurrentStatus).where(StationCurrentStatus.station_id == STATION_A))
    assert row.price == 62.0
    row.expires_at = _now() - timedelta(minutes=1)
    db_session.commit()
    try:
        StatusService(db_session).expire_stale()
        db_session.refresh(row)
        assert row.status == "UNKNOWN"
        assert row.expires_at > _now()  # перезаряжено вперёд
        assert row.price is None  # но цена не реанимирована
        assert row.price_updated_at is None
        assert row.price_source_provider_id is None
        detail = client.get(f"/api/v1/stations/{STATION_A}").json()
        status_row = next(s for s in detail["statuses"] if s["fuel_code"] == "AI_95")
        assert status_row["price"] is None
    finally:
        # общая session-БД: возвращаем свежий AVAILABLE, чтобы не задеть другие тесты
        StatusService(db_session).record_fuel_observation(
            station_id=STATION_A, fuel_code="AI_95", status="AVAILABLE",
            source_provider_id=_provider(db_session).id, observed_at=_now(), price=62.0,
        )


def test_price_source_is_returned_by_public_api(client, db_session):
    _seed_station(db_session, STATION_A)
    _set_price_status(db_session, STATION_A, "AI_95", 62.0)
    detail = client.get(f"/api/v1/stations/{STATION_A}").json()
    status_row = next(s for s in detail["statuses"] if s["fuel_code"] == "AI_95")
    assert status_row["price_source_provider_id"] is not None
    assert status_row["price_source"] == "Импорт списков сетей (CSV/JSON)"


def test_price_fields_are_additive_and_nullable(client, db_session):
    """Старые клиенты: новые поля nullable, список без цен отвечает как прежде."""
    _seed_station(db_session, STATION_C)
    r = client.get("/api/v1/stations", params={"lat": 45.0, "lon": 39.0, "radius_km": 50, "fuel": "DIESEL"})
    assert r.status_code == 200
    for station in r.json():
        for s in station["statuses"]:
            assert s["price"] is None
    nearby = client.get(
        "/api/v1/stations/nearby", params={"lat": 45.0, "lon": 39.0, "fuel": "AI_95", "price_max": 100}
    )
    assert nearby.status_code == 200
