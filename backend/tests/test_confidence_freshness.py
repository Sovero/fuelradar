"""Regression cases discovered while integrating the scheduler."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.confidence.aggregate import ObservationInput, aggregate
from app.confidence.service import StatusService
from app.db.models import SourceProvider, Station, StationCurrentStatus


def test_zero_trust_does_not_crash_or_confirm_fuel():
    result = aggregate([ObservationInput(status="AVAILABLE", trust=0)])
    assert result.status == "UNKNOWN"
    assert result.confidence == 0


def test_old_observation_does_not_get_new_ttl(db_session, client):
    station = Station(id="fr_freshness", latitude=45, longitude=39)
    provider = SourceProvider(code="freshness-source", name="test", trust=1, status="TEST")
    db_session.add_all([station, provider])
    db_session.commit()
    observed = datetime.now(UTC).replace(tzinfo=None) - timedelta(minutes=119)
    service = StatusService(db_session)
    service.record_fuel_observation(station.id, "AI_95", "AVAILABLE", provider.id, observed_at=observed)
    row = db_session.scalar(select(StationCurrentStatus).where(StationCurrentStatus.station_id == station.id))
    assert row.expires_at <= observed + timedelta(minutes=120)


def test_one_source_updates_its_vote_without_multiplying_it(db_session, client):
    station = Station(id="fr_independent", latitude=45, longitude=39)
    first = SourceProvider(code="independent-first", name="test A", trust=1, status="TEST")
    second = SourceProvider(code="independent-second", name="test B", trust=1, status="TEST")
    db_session.add_all([station, first, second])
    db_session.commit()
    service = StatusService(db_session)
    for _ in range(5):
        service.record_fuel_observation(station.id, "AI_95", "AVAILABLE", first.id)
    service.record_fuel_observation(station.id, "AI_95", "UNAVAILABLE", second.id)
    row = db_session.scalar(select(StationCurrentStatus).where(StationCurrentStatus.station_id == station.id))
    assert row.status == "UNCERTAIN"
    assert len(row.status_explanation["contributions"]) == 2
