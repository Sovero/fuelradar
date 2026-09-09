"""Public Route Mode API contract tests (R22)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, select

from app.db.models import FuelType, Station, StationCurrentStatus


@pytest.fixture()
def route_stations(db_session):
    """Stations that distinguish segment distance from endpoint distance."""
    station_ids = ("fr_route_mid", "fr_route_far", "fr_route_wrong_fuel")
    fuel = db_session.scalar(select(FuelType).where(FuelType.code == "AI_95"))
    assert fuel is not None

    stations = (
        Station(
            id=station_ids[0],
            canonical_name="У середины сегмента",
            latitude=45.03,
            longitude=39.5,
            city="RouteSpecOnly",
        ),
        Station(
            id=station_ids[1],
            canonical_name="За коридором",
            latitude=45.1,
            longitude=39.5,
            city="RouteSpecOnly",
        ),
        Station(
            id=station_ids[2],
            canonical_name="Без подходящего статуса",
            latitude=45.02,
            longitude=39.4,
            city="RouteSpecOnly",
        ),
    )
    db_session.add_all(stations)
    now = datetime.now(UTC).replace(tzinfo=None)
    db_session.add(
        StationCurrentStatus(
            station_id=station_ids[0],
            fuel_type_id=fuel.id,
            status="AVAILABLE",
            confidence=91,
            updated_at=now,
            expires_at=now + timedelta(hours=1),
        )
    )
    db_session.commit()
    try:
        yield station_ids
    finally:
        db_session.execute(
            delete(StationCurrentStatus).where(StationCurrentStatus.station_id.in_(station_ids))
        )
        db_session.execute(delete(Station).where(Station.id.in_(station_ids)))
        db_session.commit()


def test_route_returns_station_near_middle_of_segment(client, route_stations):
    response = client.post(
        "/api/v1/route/stations",
        json={
            "polyline": [
                {"lat": 45.0, "lon": 39.0},
                {"lat": 45.0, "lon": 40.0},
            ],
            "corridor_km": 5,
            "city": "RouteSpecOnly",
            "fuel": "AI_95",
            "status": "AVAILABLE",
        },
    )

    assert response.status_code == 200
    items = response.json()
    assert [item["id"] for item in items] == [route_stations[0]]
    assert 3.2 < items[0]["distance_from_route_km"] < 3.5


@pytest.mark.parametrize(
    "payload",
    [
        {"polyline": [{"lat": 45.0, "lon": 39.0}], "corridor_km": 5},
        {
            "polyline": [{"lat": 91, "lon": 39}, {"lat": 45, "lon": 40}],
            "corridor_km": 5,
        },
        {
            "polyline": [{"lat": 45, "lon": 39}, {"lat": 45, "lon": 40}],
            "corridor_km": 0.4,
        },
        {
            "polyline": [{"lat": 45, "lon": 39}, {"lat": 45, "lon": 40}],
            "corridor_km": 51,
        },
    ],
)
def test_route_rejects_invalid_polyline_or_corridor_in_russian(client, payload):
    response = client.post("/api/v1/route/stations", json=payload)

    assert response.status_code == 422
    assert "Ошибка валидации" in response.text


def test_route_accepts_coordinate_pairs_and_empty_result(client):
    response = client.post(
        "/api/v1/route/stations",
        json={"polyline": [[-45.0, -39.0], [-45.1, -39.1]], "corridor_km": 0.5},
    )

    assert response.status_code == 200
    assert response.json() == []
