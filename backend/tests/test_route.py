"""Public Route Mode API contract tests (R22) and road routing (R22.1)."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, select

from app.core.config import settings
from app.db.models import FuelType, Station, StationCurrentStatus
from app.routing import service as routing_service


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


def _osrm_payload(*, code: str = "Ok", coordinates: int = 4, distance: float = 4200.0) -> dict:
    """Минимальный ответ OSRM: геометрия [lon, lat], шаги с маневрами."""
    geometry = [[38.941 + index * 0.001, 45.035 + index * 0.001] for index in range(coordinates)]
    return {
        "code": code,
        "routes": [
            {
                "distance": distance,
                "duration": 540.0,
                "geometry": {"coordinates": geometry},
                "legs": [
                    {
                        "steps": [
                            {
                                "maneuver": {"type": "depart", "modifier": None},
                                "name": "",
                                "distance": 120.0,
                                "duration": 20.0,
                            },
                            {
                                "maneuver": {"type": "turn", "modifier": "right"},
                                "name": "ул. Северная",
                                "distance": 3100.0,
                                "duration": 420.0,
                            },
                            {
                                "maneuver": {"type": "arrive", "modifier": None},
                                "name": "",
                                "distance": 0.0,
                                "duration": 0.0,
                            },
                        ]
                    }
                ],
            }
        ],
    }


def test_route_url_uses_lon_lat_order_and_waypoint_chain():
    url = routing_service.build_route_url([(45.0356, 38.9412), (45.028, 38.979)])

    assert url.startswith("https://router.project-osrm.org/route/v1/driving/")
    # OSRM принимает координаты в порядке lon,lat и точки в порядке движения.
    assert "38.941200,45.035600;38.979000,45.028000" in url
    assert "geometries=geojson" in url and "steps=true" in url and "overview=full" in url


def test_route_url_respects_configured_base_and_profile(monkeypatch):
    monkeypatch.setattr(settings, "routing_profile", "driving")

    url = routing_service.build_route_url([(1.0, 2.0), (3.0, 4.0)], base="http://osrm.local:5000/", profile="driving")

    assert url.startswith("http://osrm.local:5000/route/v1/driving/2.000000,1.000000;4.000000,3.000000")


def test_parse_route_payload_converts_lon_lat_to_lat_lon():
    route = routing_service.parse_route_payload(_osrm_payload())

    assert route is not None
    assert route.distance_km == 4.2
    assert route.duration_min == 9.0
    assert route.geometry[0] == {"lat": 45.035, "lon": 38.941}
    assert route.geometry[-1]["lat"] > 45.035  # порядок движения сохранён
    assert [step.type for step in route.steps] == ["depart", "turn", "arrive"]
    assert route.steps[1].modifier == "right"
    assert route.steps[1].street == "ул. Северная"


def test_parse_route_payload_rejects_unusable_answers():
    assert routing_service.parse_route_payload(_osrm_payload(code="NoRoute")) is None
    assert routing_service.parse_route_payload({"code": "Ok", "routes": []}) is None
    # Одна координата — не линия: рисовать нечего.
    assert routing_service.parse_route_payload(_osrm_payload(coordinates=1)) is None


def test_parse_route_payload_decimates_long_geometry_keeping_ends():
    payload = _osrm_payload(coordinates=routing_service.MAX_GEOMETRY_POINTS + 500)

    route = routing_service.parse_route_payload(payload)

    assert route is not None
    assert len(route.geometry) == routing_service.MAX_GEOMETRY_POINTS
    assert route.geometry[0] == {"lat": 45.035, "lon": 38.941}
    assert route.geometry[-1] == {
        "lat": 45.035 + (routing_service.MAX_GEOMETRY_POINTS + 499) * 0.001,
        "lon": 38.941 + (routing_service.MAX_GEOMETRY_POINTS + 499) * 0.001,
    }


def test_plan_road_route_reports_reasons_instead_of_failing(monkeypatch):
    points = [(45.0356, 38.9412), (45.028, 38.979)]

    monkeypatch.setattr(settings, "routing_base_url", "")
    assert routing_service.plan_road_route(points)[1] == routing_service.REASON_NOT_CONFIGURED

    monkeypatch.setattr(settings, "routing_base_url", "https://router.example")

    def broken(_url: str) -> str:
        raise routing_service.RoutingError("timeout")

    assert routing_service.plan_road_route(points, http_get=broken)[1] == (
        routing_service.REASON_PROVIDER_UNAVAILABLE
    )
    assert routing_service.plan_road_route(points, http_get=lambda _url: "{не json")[1] == (
        routing_service.REASON_PROVIDER_UNAVAILABLE
    )
    assert routing_service.plan_road_route(points, http_get=lambda _url: json.dumps({"code": "NoRoute"}))[
        1
    ] == routing_service.REASON_NO_ROUTE


def test_plan_route_endpoint_returns_road_geometry(client, monkeypatch):
    monkeypatch.setattr(
        routing_service,
        "_default_http_get",
        lambda url: json.dumps(_osrm_payload()),
    )

    response = client.post(
        "/api/v1/route/plan",
        json={"polyline": [[45.0356, 38.9412], [45.028, 38.979]]},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["is_road_route"] is True
    assert body["provider"] == "osrm"
    assert body["distance_km"] == 4.2
    assert body["duration_min"] == 9.0
    assert body["geometry"][0] == {"lat": 45.035, "lon": 38.941}
    assert body["steps"][1]["street"] == "ул. Северная"
    assert body["reason"] is None


def test_plan_route_endpoint_is_honest_when_router_is_down(client, monkeypatch):
    def broken(_url: str) -> str:
        raise routing_service.RoutingError("connect refused")

    monkeypatch.setattr(routing_service, "_default_http_get", broken)

    response = client.post(
        "/api/v1/route/plan",
        json={"polyline": [[45.0356, 38.9412], [45.028, 38.979]]},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["is_road_route"] is False
    assert body["reason"] == "provider_unavailable"
    assert body["geometry"] is None and body["steps"] == []


@pytest.mark.parametrize(
    "payload",
    [
        {"polyline": [{"lat": 45.0, "lon": 39.0}]},
        {"polyline": [{"lat": 200, "lon": 39}, {"lat": 45, "lon": 40}]},
        {"polyline": [{"lat": 45, "lon": 400}, {"lat": 45, "lon": 40}]},
    ],
)
def test_plan_route_rejects_invalid_polyline_in_russian(client, payload):
    response = client.post("/api/v1/route/plan", json=payload)

    assert response.status_code == 422
    assert "Ошибка валидации" in response.text
