"""Analytics counters, absence semantics, durable cache, and admin contract."""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.analytics.router import router
from app.analytics.service import deficit_statistics, refresh_analytics, summarize
from app.db.base import Base
from app.db.models import (
    FuelObservation,
    FuelType,
    SourceProvider,
    SourceStationRecord,
    Station,
    StationCurrentStatus,
)
from app.db.session import get_db

NOW = datetime.now(UTC).replace(tzinfo=None)


@pytest.fixture
def analytics_db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        db.add_all([FuelType(id=1, code="AI_95", display_name_ru="95"),
                    FuelType(id=2, code="DIESEL", display_name_ru="ДТ"),
                    SourceProvider(id=1, code="osm", name="OSM"),
                    SourceProvider(id=2, code="network", name="Network")])
        for number in range(1, 6):
            db.add(Station(id=str(number), latitude=45, longitude=38 + number / 10,
                           city="Pilot" if number < 5 else "Other", region="Region"))
        db.flush()
        for station, fuel, status, fresh in [
            ("1", 1, "AVAILABLE", True), ("2", 1, "UNAVAILABLE", True),
            ("2", 2, "UNKNOWN", True), ("3", 1, "UNAVAILABLE", False),
            ("4", 1, "UNCERTAIN", True), ("5", 1, "AVAILABLE", True),
        ]:
            db.add(StationCurrentStatus(station_id=station, fuel_type_id=fuel, status=status,
                                       expires_at=NOW + timedelta(hours=1 if fresh else -1)))
        for provider, external, station in [(1, "a", "1"), (1, "a", "1"),
                                             (1, "b", "2"), (2, "x", "1")]:
            db.add(SourceStationRecord(source_provider_id=provider, external_id=external,
                                       station_id=station, latitude=45, longitude=38.1))
        db.commit()
        yield db
    engine.dispose()


def test_coverage_index_and_city_bbox_are_honest(analytics_db):
    from app.analytics.models import AnalyticsSnapshot

    refresh_analytics(analytics_db, now=NOW)
    cached = analytics_db.get(AnalyticsSnapshot, 1).payload
    result = summarize(cached, city="Pilot")
    assert result["coverage"] == {
        "stations_discovered": 4, "with_fuel_data": 2, "partial_data": 1,
        "no_data": 1, "coverage_percent": 75.0,
        "definition": "known readings among each station's tracked fuel types",
    }
    index = result["fuel_index"]["items"][0]
    assert index["index"] == 50
    assert index["denominator"] == 2
    assert index["excluded_unknown"] == 1
    assert index["excluded_ambiguous"] == 1
    assert index["coverage_percent"] == 50
    assert result["fuel_index"]["items"][1]["index"] is None
    assert summarize(cached, bbox=(38, 44, 38.15, 46))["coverage"]["stations_discovered"] == 1
    assert summarize(cached, city="Empty")["coverage"]["coverage_percent"] is None


def test_source_counts_do_not_inflate_repeated_ingestion(analytics_db):
    result = refresh_analytics(analytics_db, now=NOW)["coverage_by_source"]
    assert result["unique_stations_after_dedup"] == 5
    assert result["sources"][0]["records_before_dedup"] == 2
    assert result["sources"][0]["unique_stations"] == 2
    assert result["sources"][1]["unique_stations"] == 1


def readings(*values):
    return [{"status": status, "observed_at": NOW + timedelta(minutes=minute),
             "expires_at": NOW + timedelta(minutes=minute + 120)}
            for minute, status in values]


def test_deficits_count_transitions_not_duplicate_reports():
    result = deficit_statistics(readings((0, "AVAILABLE"), (10, "UNAVAILABLE"),
                                        (10, "UNAVAILABLE"), (20, "UNAVAILABLE"),
                                        (40, "AVAILABLE")))
    assert result["unavailable_transitions"] == 1
    assert result["completed_outages"] == 1
    assert result["duration_minutes"] == [30]


@pytest.mark.parametrize("middle", ["UNKNOWN", "UNCERTAIN", "LIKELY_AVAILABLE"])
def test_unknown_and_ambiguous_censor_absence_not_recovery(middle):
    result = deficit_statistics(readings((0, "AVAILABLE"), (10, "UNAVAILABLE"),
                                        (20, middle), (40, "AVAILABLE")))
    assert result["unavailable_transitions"] == 1
    assert result["censored_outages"] == 1
    assert result["completed_outages"] == 0
    assert result["duration_minutes"] == []


def test_initial_absence_and_ttl_gap_do_not_invent_recovery_duration():
    assert deficit_statistics(readings((0, "UNAVAILABLE"), (10, "AVAILABLE")))["duration_minutes"] == []
    result = deficit_statistics(readings((0, "AVAILABLE"), (10, "UNAVAILABLE"),
                                        (200, "AVAILABLE")))
    assert result["duration_minutes"] == []
    assert result["censored_outages"] == 1


def test_network_aggregates_do_not_interleave_sources_or_keep_history_in_cache(analytics_db):
    # One source observes a 30-minute outage; a second source reports availability
    # during it. Interleaving them would invent an early recovery and second outage.
    for source, minute, status in [(1, -60, "AVAILABLE"), (1, -50, "UNAVAILABLE"),
                                    (2, -40, "AVAILABLE"), (1, -30, "UNAVAILABLE"),
                                    (1, -20, "AVAILABLE")]:
        analytics_db.add(FuelObservation(
            station_id="1", fuel_type_id=1, source_provider_id=source, status=status,
            observed_at=NOW + timedelta(minutes=minute), expires_at=NOW + timedelta(hours=1),
        ))
    analytics_db.commit()
    result = refresh_analytics(analytics_db, now=NOW)["deficit_stats"]["items"][0]
    assert result["observed_source_streams"] == 2
    assert result["unavailable_transitions"] == 1
    assert result["completed_outages"] == 1
    assert result["mean_absence_minutes"] == 30
    assert result["mean_recovery_minutes"] == 30


def test_admin_routes_use_durable_cache_without_history_queries(analytics_db):
    app = FastAPI()
    app.include_router(router, prefix="/api/v1")
    app.dependency_overrides[get_db] = lambda: analytics_db
    with TestClient(app) as client:
        # Входа нет: админ-аналитика открыта, но до прогрева отвечает честной 503.
        assert client.get("/api/v1/admin/coverage").status_code == 503
        refresh_analytics(analytics_db, now=NOW)
        analytics_db.commit()
        statements = []

        def capture(conn, cursor, statement, parameters, context, executemany):
            statements.append(statement)

        event.listen(analytics_db.bind, "before_cursor_execute", capture)
        try:
            for endpoint in ["coverage", "coverage-by-source", "fuel-index", "deficit-stats"]:
                response = client.get(f"/api/v1/admin/{endpoint}?city=Pilot")
                assert response.status_code == 200
                assert response.json()["computed_at"]
            assert statements
            assert all("fuel_observations" not in statement for statement in statements)
            assert all("station_current_status" not in statement for statement in statements)
        finally:
            event.remove(analytics_db.bind, "before_cursor_execute", capture)
        assert client.get("/api/v1/admin/fuel-index?bbox=nan,0,1,1").status_code == 422
        assert client.get("/api/v1/admin/fuel-index?bbox=1,2,3").status_code == 422
