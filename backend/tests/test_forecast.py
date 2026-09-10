"""T12 (§23): прогноз R49 (эвристика, честные null), heatmap R50, BI R79."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.analytics.heat import router as heat_router
from app.analytics.router import router as admin_router
from app.analytics.service import refresh_analytics
from app.db.base import Base
from app.db.models import (
    FuelObservation,
    FuelType,
    SourceProvider,
    Station,
    StationCurrentStatus,
)
from app.db.session import get_db

NOW = datetime.now(UTC).replace(tzinfo=None)
ADMIN = {"X-Admin-Token": "test-admin-token"}


@pytest.fixture()
def t12_db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        db.add_all([
            FuelType(id=1, code="AI_95", display_name_ru="95"),
            SourceProvider(id=1, code="osm", name="OSM"),
        ])
        for number in range(1, 6):
            db.add(Station(id=str(number), latitude=45.0 + number / 100, longitude=39.0 + number / 100,
                           city="Alpha" if number < 4 else "Beta", region="PilotRegion"))
        db.commit()
        yield db
    engine.dispose()


def _seed_cycle(db: Session, station: str, outages: list[tuple[int, int]]) -> None:
    """Эпизоды (начало, восстановление) в минутах относительно NOW.

    Перед первым эпизодом добавляется AVAILABLE — иначе первый UNAVAILABLE
    считается начальным (censored, R47) и эпизодом не является.
    """
    first = outages[0][0]
    db.add(FuelObservation(station_id=station, fuel_type_id=1, source_provider_id=1,
                           status="AVAILABLE", observed_at=NOW + timedelta(minutes=first - 60),
                           expires_at=NOW + timedelta(minutes=first + 60)))
    for start, recovery in outages:
        db.add(FuelObservation(station_id=station, fuel_type_id=1, source_provider_id=1,
                               status="UNAVAILABLE", observed_at=NOW + timedelta(minutes=start),
                               expires_at=NOW + timedelta(minutes=start + 120)))
        db.add(FuelObservation(station_id=station, fuel_type_id=1, source_provider_id=1,
                               status="AVAILABLE", observed_at=NOW + timedelta(minutes=recovery),
                               expires_at=NOW + timedelta(minutes=recovery + 120)))


def _snapshot(db: Session):
    refresh_analytics(db, now=NOW)
    db.commit()
    from app.analytics.models import AnalyticsSnapshot
    return db.get(AnalyticsSnapshot, 1).payload


def test_forecast_appearing_probability_and_eta(t12_db):
    # Два завершённых эпизода по 60 минут + живой эпизод, начатый 50 минут назад.
    _seed_cycle(t12_db, "1", [(-300, -240), (-200, -140)])
    t12_db.add(FuelObservation(station_id="1", fuel_type_id=1, source_provider_id=1,
                               status="UNAVAILABLE", observed_at=NOW - timedelta(minutes=50),
                               expires_at=NOW + timedelta(minutes=70)))
    t12_db.commit()
    from app.analytics.forecast import forecast_for_station

    result = forecast_for_station(_snapshot(t12_db), "1")

    assert result["is_forecast"] is True
    assert result["direction"] == "appearing"
    assert result["probability"] == 67  # 2 завершённых из 3 начатых (живой эпизод — censored)
    assert result["eta_minutes"] == 10   # средняя длительность 60 − текущая 50
    assert result["sufficiency"] == "ok"
    assert "не ML" in result["method"]
    assert result["current_outage_minutes"] == 50.0
    assert result["sample"]["completed"] == 2


def test_forecast_disappearing_poisson_formula(t12_db):
    # Три завершённых эпизода, последнее наблюдение — свежее AVAILABLE.
    _seed_cycle(t12_db, "1", [(-300, -240), (-200, -140), (-100, -40)])
    t12_db.add(FuelObservation(station_id="1", fuel_type_id=1, source_provider_id=1,
                               status="AVAILABLE", observed_at=NOW - timedelta(minutes=5),
                               expires_at=NOW + timedelta(minutes=115)))
    t12_db.commit()
    from app.analytics.forecast import forecast_for_station

    result = forecast_for_station(_snapshot(t12_db), "1")

    assert result["direction"] == "disappearing"
    # rate = 3 эпизода / (355/60 ч) ≈ 0.507/ч; P(за 3 ч) = 1 − exp(−1.521) ≈ 0.7815 → 78
    assert result["probability"] == 78
    assert result["eta_minutes"] is None
    assert result["sufficiency"] == "ok"
    assert "не оценивается" in (result["reason"] or "")  # R49.1: время до исчезновения честно не даём
    assert result["sample"]["window_minutes"] == 355


def test_forecast_insufficient_history_and_episodes(t12_db):
    from app.analytics.forecast import forecast_for_station

    # Окно 45 мин < горизонта 180 мин → причина про короткую историю.
    _seed_cycle(t12_db, "2", [(-50, -40), (-30, -20)])
    t12_db.add(FuelObservation(station_id="2", fuel_type_id=1, source_provider_id=1,
                               status="AVAILABLE", observed_at=NOW - timedelta(minutes=5),
                               expires_at=NOW + timedelta(minutes=115)))
    t12_db.commit()
    short = forecast_for_station(_snapshot(t12_db), "2")
    assert short["sufficiency"] == "insufficient"
    assert short["probability"] is None and short["eta_minutes"] is None
    assert "История наблюдений короче горизонта прогноза" in short["reason"]

    # Окно 455 мин ≥ горизонта, но всего 1 эпизод → причина про число эпизодов.
    _seed_cycle(t12_db, "3", [(-400, -300)])
    t12_db.add(FuelObservation(station_id="3", fuel_type_id=1, source_provider_id=1,
                               status="AVAILABLE", observed_at=NOW - timedelta(minutes=5),
                               expires_at=NOW + timedelta(minutes=115)))
    t12_db.commit()
    few = forecast_for_station(_snapshot(t12_db), "3")
    assert few["sufficiency"] == "insufficient"
    assert "Мало эпизодов дефицита за историю: 1" in few["reason"]


def test_forecast_no_data_is_honest(t12_db):
    from app.analytics.forecast import forecast_for_station

    empty = forecast_for_station(_snapshot(t12_db), "5")  # станция без наблюдений
    assert empty["sufficiency"] == "no_data"
    assert empty["probability"] is None and empty["direction"] is None
    assert "Наблюдений по станции нет" in empty["reason"]

    missing = forecast_for_station(_snapshot(t12_db), "nope")  # нет и в снэпшоте
    assert missing["sufficiency"] == "no_data"
    assert missing["is_forecast"] is True


# ---------- HTTP: heat (R50), BI (R79), forecast endpoint (R49) ----------

@pytest.fixture()
def t12_client(t12_db):
    app = FastAPI()
    app.include_router(heat_router, prefix="/api/v1")
    app.include_router(admin_router, prefix="/api/v1")
    from app.api.stations import router as stations_router
    app.include_router(stations_router, prefix="/api/v1")
    app.dependency_overrides[get_db] = lambda: t12_db
    return TestClient(app)


def test_heat_cells_read_snapshot_only(t12_client, t12_db):
    # Без снэпшота — структурированная 503, карта не падает.
    assert t12_client.get("/api/v1/heat/cells").status_code == 503
    assert "не посчитана" in t12_client.get("/api/v1/heat/cells").json()["detail"]

    _seed_cycle(t12_db, "1", [(-300, -240)])
    t12_db.add_all([
        StationCurrentStatus(station_id="1", fuel_type_id=1, status="AVAILABLE",
                             expires_at=NOW + timedelta(hours=1)),
        StationCurrentStatus(station_id="2", fuel_type_id=1, status="UNAVAILABLE",
                             expires_at=NOW + timedelta(hours=1)),
        StationCurrentStatus(station_id="3", fuel_type_id=1, status="UNCERTAIN",
                             expires_at=NOW + timedelta(hours=1)),
    ])
    t12_db.commit()
    refresh_analytics(t12_db, now=NOW)
    t12_db.commit()

    response = t12_client.get("/api/v1/heat/cells")
    assert response.status_code == 200
    body = response.json()
    by_id = {cell["station_id"]: cell for cell in body["cells"]}
    assert by_id["1"]["availability"] == 1.0   # AVAILABLE → высокий уровень
    assert by_id["2"]["availability"] == 0.0   # UNAVAILABLE → дефицит
    assert by_id["3"]["availability"] is None  # неоднозначный не голосует → ячейка без уровня
    assert body["levels"] == [
        {"level": "high", "min_availability": 0.67},
        {"level": "medium", "min_availability": 0.34},
        {"level": "low", "min_availability": 0.0},
    ]
    # Русская 422 на плохом bbox
    assert t12_client.get("/api/v1/heat/cells?bbox=1,2,3").status_code == 422
    assert t12_client.get("/api/v1/heat/cells?bbox=180,0,-180,10").status_code == 422


def test_deficit_by_region_endpoint_groups_with_sample_size(t12_client, t12_db):
    assert t12_client.get("/api/v1/admin/deficit-by-region", headers=ADMIN).status_code == 503
    assert t12_client.get("/api/v1/admin/deficit-by-region").status_code == 401

    _seed_cycle(t12_db, "1", [(-300, -240), (-200, -100)])
    _seed_cycle(t12_db, "4", [(-90, -30)])
    t12_db.commit()
    refresh_analytics(t12_db, now=NOW)
    t12_db.commit()

    response = t12_client.get("/api/v1/admin/deficit-by-region?dimension=city", headers=ADMIN)
    assert response.status_code == 200
    items = response.json()["items"]
    alpha = next(row for row in items if row["city"] == "Alpha")
    beta = next(row for row in items if row["city"] == "Beta")
    assert alpha["completed_outages"] == 2 and alpha["mean_absence_minutes"] == 80
    assert alpha["stations_observed"] == 1
    assert beta["completed_outages"] == 1
    assert "pilot" in response.json()["note"]
    assert t12_client.get(
        "/api/v1/admin/deficit-by-region?dimension=galaxy", headers=ADMIN
    ).status_code == 422


def test_forecast_endpoint_contract(t12_client, t12_db):
    # 404 неизвестной станции; 503 без снэпшота.
    assert t12_client.get("/api/v1/stations/nope/forecast").status_code == 404
    assert "не найдена" in t12_client.get("/api/v1/stations/nope/forecast").json()["detail"]
    assert t12_client.get("/api/v1/stations/1/forecast").status_code == 503

    # Два завершённых эпизода по 60 минут + живой эпизод (50-я минута).
    _seed_cycle(t12_db, "1", [(-300, -240), (-200, -140)])
    t12_db.add(FuelObservation(station_id="1", fuel_type_id=1, source_provider_id=1,
                               status="UNAVAILABLE", observed_at=NOW - timedelta(minutes=50),
                               expires_at=NOW + timedelta(minutes=70)))
    t12_db.commit()
    refresh_analytics(t12_db, now=NOW)
    t12_db.commit()

    response = t12_client.get("/api/v1/stations/1/forecast")
    assert response.status_code == 200
    body = response.json()
    assert body["is_forecast"] is True
    assert body["direction"] == "appearing"
    assert body["sufficiency"] == "ok"
    assert body["probability"] == 67 and body["eta_minutes"] == 10

    # Станция без снэпшотных потоков — честный no_data, а не выдуманное число.
    empty = t12_client.get("/api/v1/stations/5/forecast")
    assert empty.status_code == 200
    assert empty.json()["sufficiency"] == "no_data"
