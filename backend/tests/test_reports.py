"""T07 — POST /reports (R39/R40/R41.1): наблюдение, идемпотентность, GPS-вес, блокировка."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from app.db.models import FuelObservation, QueueObservation, Station, UserReport

pytestmark = pytest.mark.usefixtures("client")

STATION = "fr_station_971001"
STATION_FAR_GPS = "fr_station_971002"
STATION_BLOCKED = "fr_station_971003"


def _seed_station(db_session, station_id: str, lat: float = 45.0, lon: float = 39.0) -> None:
    if db_session.get(Station, station_id) is None:
        db_session.add(Station(id=station_id, canonical_name=f"АЗС {station_id}", latitude=lat, longitude=lon))
        db_session.commit()


def _key() -> str:
    return f"t07-{uuid.uuid4().hex[:24]}"


def test_report_creates_observation_and_recomputes_status(client, db_session):
    _seed_station(db_session, STATION)
    key = _key()

    r = client.post(
        "/api/v1/reports",
        json={"station_id": STATION, "fuel": {"AI_95": "AVAILABLE"}, "queue": "LOW", "idempotency_key": key},
    )
    assert r.status_code == 201
    body = r.json()
    assert body["created"] is True
    assert body["station_id"] == STATION

    obs = db_session.scalar(
        select(FuelObservation).where(
            FuelObservation.station_id == STATION, FuelObservation.idempotency_key == f"{key}:AI_95"
        )
    )
    assert obs is not None and obs.status == "AVAILABLE"
    queue = db_session.scalar(select(QueueObservation).where(QueueObservation.station_id == STATION))
    assert queue is not None and queue.queue_level == "LOW"

    # Одиночный анонимный отчёт (без GPS, стартовая репутация) даёт вес ниже
    # порога min_weight → UNCERTAIN, не AVAILABLE (R19.1) — это верно и ожидаемо
    # для Confidence Engine (T04); здесь важно, что статус вообще пересчитался
    # (перестал быть UNKNOWN), а не конкретная классификация.
    fuel_status = client.get(f"/api/v1/stations/{STATION}/fuel").json()
    entry = next(s for s in fuel_status if s["fuel_code"] == "AI_95")
    assert entry["status"] != "UNKNOWN"


def test_repeated_idempotency_key_does_not_duplicate_observation(client, db_session):
    _seed_station(db_session, STATION)
    key = _key()
    body = {"station_id": STATION, "fuel": {"AI_95": "UNAVAILABLE"}, "queue": None, "idempotency_key": key}

    first = client.post("/api/v1/reports", json=body)
    assert first.status_code == 201 and first.json()["created"] is True
    report_id = first.json()["id"]

    second = client.post("/api/v1/reports", json=body)
    assert second.status_code == 201
    assert second.json()["created"] is False
    assert second.json()["id"] == report_id

    count = db_session.scalar(
        select(UserReport).where(UserReport.idempotency_key == key)
    )
    assert count is not None
    obs_count = len(
        list(
            db_session.scalars(
                select(FuelObservation).where(FuelObservation.idempotency_key == f"{key}:AI_95")
            )
        )
    )
    assert obs_count == 1, "повтор с тем же idempotency_key не должен дублировать наблюдение (R39.1)"


def test_gps_confirmed_report_below_300m(client, db_session):
    _seed_station(db_session, STATION_FAR_GPS, lat=45.0, lon=39.0)
    key = _key()

    # ~11 м к северу от станции — заведомо < 300 м (R40)
    r = client.post(
        "/api/v1/reports",
        json={
            "station_id": STATION_FAR_GPS, "fuel": {"AI_95": "AVAILABLE"},
            "idempotency_key": key, "lat": 45.0001, "lon": 39.0,
        },
    )
    assert r.status_code == 201
    body = r.json()
    assert body["gps_confirmed"] is True
    assert body["distance_to_station_m"] is not None and body["distance_to_station_m"] < 300


def test_gps_not_confirmed_when_far_from_station(client, db_session):
    _seed_station(db_session, STATION_FAR_GPS, lat=45.0, lon=39.0)
    key = _key()

    r = client.post(
        "/api/v1/reports",
        json={
            "station_id": STATION_FAR_GPS, "fuel": {"AI_95": "AVAILABLE"},
            "idempotency_key": key, "lat": 46.0, "lon": 39.0,  # ~111 км
        },
    )
    assert r.status_code == 201
    body = r.json()
    assert body["gps_confirmed"] is False
    assert body["distance_to_station_m"] > 300


def test_report_requires_fuel_or_queue(client, db_session):
    _seed_station(db_session, STATION)
    r = client.post("/api/v1/reports", json={"station_id": STATION, "idempotency_key": _key()})
    assert r.status_code == 422


def test_report_unknown_station_is_404(client):
    r = client.post(
        "/api/v1/reports",
        json={"station_id": "fr_station_does_not_exist", "fuel": {"AI_95": "AVAILABLE"}, "idempotency_key": _key()},
    )
    assert r.status_code == 404


def test_report_invalid_fuel_status_is_422(client, db_session):
    _seed_station(db_session, STATION)
    r = client.post(
        "/api/v1/reports",
        json={"station_id": STATION, "fuel": {"AI_95": "LIKELY_AVAILABLE"}, "idempotency_key": _key()},
    )
    assert r.status_code == 422  # LIKELY_AVAILABLE — вычисляемый статус, не то, что сообщает человек (R39)
