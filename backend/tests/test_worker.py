"""Persistent worker behavior tested through real SQLite transactions and fake adapters."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from app.analytics.models import AnalyticsSnapshot  # noqa: F401
from app.core import metrics
from app.core.config import settings
from app.db.base import Base
from app.db.models import (
    AlertRule,
    CollectionJob,
    CollectionLog,
    Favorite,
    FuelObservation,
    FuelType,
    MonitoringZone,
    SourceHealth,
    SourceProvider,
    SourceStationRecord,
    Station,
    StationExternalId,
)
from app.sources.base import HealthResult, RateLimitedError, SourceAdapter, SourceRecord
from app.worker import Worker, schedule_priority_job
from app.worker.locking import worker_lock


class Adapter(SourceAdapter):
    def __init__(self, *, error=None, records=None, fuel=None):
        self.calls = 0
        self.error = error
        self.records = records or []
        self.fuel = fuel or []

    def discover_stations(self, region):
        self.calls += 1
        if self.error:
            raise self.error
        return self.records

    def get_fuel_availability(self, external_id):
        self.calls += 1
        return self.fuel

    def health_check(self):
        return HealthResult("ONLINE")


@pytest.fixture
def worker_db(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'worker.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine)
    with factory() as db:
        db.add_all([FuelType(code="AI_95", display_name_ru="95"),
                    FuelType(code="UNKNOWN", display_name_ru="Unknown")])
        db.commit()
    yield factory
    engine.dispose()


def provider(db, code="fake", interval=0, capabilities=None):
    p = SourceProvider(code=code, name=code, min_interval_minutes=interval,
                       capabilities=capabilities or {"discovery": True})
    db.add(p)
    db.commit()
    return p


def test_priorities_coalesce_and_validate(worker_db):
    with worker_db() as db:
        p = provider(db)
        first = schedule_priority_job(db, p.id)
        promoted = schedule_priority_job(db, p.id, priority="P1", trigger="manual")
        assert first.id == promoted.id
        assert promoted.priority == "P1"
        assert db.scalar(select(func.count()).select_from(CollectionJob)) == 1
        with pytest.raises(ValueError):
            schedule_priority_job(db, p.id, priority="P0")
        with pytest.raises(ValueError):
            schedule_priority_job(db, p.id, job_type="availability")


def test_execution_priority_order(worker_db):
    adapters = {}
    expected = {}
    with worker_db() as db:
        for priority in ("P4", "P2", "P3", "P1"):
            p = provider(db, priority)
            adapters[p.code] = Adapter()
            expected[priority] = schedule_priority_job(db, p.id, priority=priority).id
        db.commit()
    assert Worker(worker_db, {}, adapters).run_once() == [expected[p] for p in ("P1", "P2", "P3", "P4")]


def test_manual_refresh_respects_hard_source_limit(worker_db):
    at = datetime.now(UTC).replace(tzinfo=None)
    adapter = Adapter()
    with worker_db() as db:
        p = provider(db, interval=60)
        pid = p.id
    worker = Worker(worker_db, {}, {"fake": adapter})
    assert len(worker.run_once(at)) == 1
    with worker_db() as db:
        schedule_priority_job(db, pid, trigger="manual", priority="P1", now=at)
        db.commit()
    assert worker.run_once(at + timedelta(minutes=59)) == []
    assert adapter.calls == 1
    assert len(worker.run_once(at + timedelta(minutes=60))) == 1
    assert adapter.calls == 2


def test_manual_trigger_skips_backoff_but_keeps_source_ceiling(worker_db):
    """Ручной запуск (R53.1) не ждёт backoff сбоя, но потолок частоты (R54) держит.

    Проверены оба слагаемых отсрочки: backoff — расписание автоматических
    повторных попыток после сбоя, оно не задерживает явный запрос оператора
    (кнопка «Обновить» / импорт CSV); min_interval_minutes — свойство источника,
    оно продолжает действовать при любом триггере.
    """
    at = datetime.now(UTC).replace(tzinfo=None)
    adapter = Adapter(error=RateLimitedError("boom"))
    with worker_db() as db:
        p = provider(db, interval=60)
        pid = p.id
    worker = Worker(worker_db, {}, {"fake": adapter})
    assert len(worker.run_once(at)) == 1
    assert len(worker.run_once(at + timedelta(minutes=60))) == 1
    assert adapter.calls == 2  # два сбоя → backoff 120 мин при потолке источника 60
    with worker_db() as db:
        schedule_priority_job(db, pid, trigger="manual", priority="P1", now=at + timedelta(minutes=61))
        db.commit()
    # Плановое задание сейчас ждало бы до at+180 (backoff), ручное — только
    # потолок источника (at+120): оператор не откладывается расписанием ретраев.
    assert len(worker.run_once(at + timedelta(minutes=150))) == 1
    assert adapter.calls == 3
    # Потолок источника никуда не делся: сразу после сбора ручное задание ждёт
    with worker_db() as db:
        schedule_priority_job(db, pid, trigger="manual", priority="P1", now=at + timedelta(minutes=151))
        db.commit()
    assert worker.run_once(at + timedelta(minutes=179)) == []
    assert adapter.calls == 3
    assert len(worker.run_once(at + timedelta(minutes=210))) == 1
    assert adapter.calls == 4


def test_failure_backoff_isolation_and_preserved_data(worker_db):
    at = datetime.now(UTC).replace(tzinfo=None)
    bad = Adapter(error=RateLimitedError("secret must not leak"))
    good = Adapter()
    with worker_db() as db:
        p = provider(db, "bad")
        provider(db, "good")
        db.add(SourceStationRecord(source_provider_id=p.id, external_id="existing", latitude=1, longitude=1))
        db.commit()
    worker = Worker(worker_db, {}, {"bad": bad, "good": good})
    assert len(worker.run_once(at)) == 2
    with worker_db() as db:
        assert db.scalar(select(SourceStationRecord.external_id)) == "existing"
        assert db.scalar(select(SourceHealth.health).join(SourceProvider).where(SourceProvider.code == "bad")) == "RATE_LIMITED"
        assert "secret" not in " ".join(db.scalars(select(CollectionLog.message)))
    worker.run_once(at + timedelta(minutes=59))
    assert bad.calls == 1
    worker.run_once(at + timedelta(minutes=60))
    assert bad.calls == 2
    worker.run_once(at + timedelta(minutes=179))
    assert bad.calls == 2
    worker.run_once(at + timedelta(minutes=180))
    assert bad.calls == 3
    assert good.calls >= 2


def test_restart_catches_up_once_and_lock_prevents_parallel_work(worker_db):
    at = datetime.now(UTC).replace(tzinfo=None)
    adapter = Adapter()
    with worker_db() as db:
        p = provider(db)
        job = schedule_priority_job(db, p.id, now=at - timedelta(hours=5))
        job.status = "RUNNING"
        job.started_at = at - timedelta(hours=5)
        db.commit()
        engine = db.get_bind()
    with worker_lock(engine) as acquired:
        assert acquired
        assert Worker(worker_db, {}, {"fake": adapter}).run_once(at) == []
    assert len(Worker(worker_db, {}, {"fake": adapter}).run_once(at)) == 1
    assert Worker(worker_db, {}, {"fake": adapter}).run_once(at) == []
    assert adapter.calls == 1


def test_observations_are_atomic_and_repeated_source_timestamp_idempotent(worker_db):
    at = datetime.now(UTC).replace(tzinfo=None)
    adapter = Adapter(fuel=[{"fuel_code": "AI_95", "status": "AVAILABLE", "observed_at": at}])
    with worker_db() as db:
        p = provider(db, capabilities={"availability": True})
        db.add(Station(id="s", latitude=1, longitude=1))
        db.flush()
        db.add(StationExternalId(station_id="s", source_provider_id=p.id, external_id="ext"))
        db.commit()
    worker = Worker(worker_db, {}, {"fake": adapter})
    worker.run_once(at)
    worker.run_once(at + timedelta(minutes=settings.collect_stable_minutes))
    with worker_db() as db:
        assert db.scalar(select(func.count()).select_from(FuelObservation)) == 1
    adapter.fuel = [{"fuel": "95", "status": "UNAVAILABLE", "observed_at": at + timedelta(hours=3)},
                    {"fuel": "95", "status": "INVALID"}]
    worker.run_once(at + timedelta(hours=5))
    with worker_db() as db:
        assert db.scalar(select(func.count()).select_from(FuelObservation)) == 1
        assert db.scalar(select(CollectionJob.status).order_by(CollectionJob.id.desc())) == "FAILED"


def test_priority_uses_rule_favorite_and_zone(worker_db):
    worker = Worker(worker_db, {})
    with worker_db() as db:
        station = Station(id="s", latitude=1, longitude=1, city="Town")
        db.add(station)
        db.commit()
        assert worker.station_priority(db, station) == "P4"
        zone = MonitoringZone(zone_type="CITY", params={"city": "Town"})
        db.add(zone)
        db.commit()
        assert worker.station_priority(db, station) == "P3"
        db.add(Favorite(station_id="s"))
        db.commit()
        assert worker.station_priority(db, station) == "P2"
        db.add(AlertRule(scope={"type": "zone", "zone_id": zone.id}))
        db.commit()
        assert worker.station_priority(db, station) == "P1"


def test_metrics_and_catalog_dedup(worker_db):
    adapter = Adapter(records=[SourceRecord("external", 1, 1)])
    with worker_db() as db:
        provider(db, "metrics_source")
    Worker(worker_db, {}, {"metrics_source": adapter}).run_once()
    snapshot = metrics.snapshot()
    assert snapshot["source.metrics_source.requests"] >= 1
    assert snapshot["source.metrics_source.duration_ms"] >= 0
    with worker_db() as db:
        assert db.scalar(select(func.count()).select_from(Station)) == 1


def test_disabled_and_push_sources_never_polled(worker_db):
    adapter = Adapter()
    with worker_db() as db:
        p = provider(db)
        p.status = "RESEARCH_REQUIRED"
        provider(db, "user_reports", capabilities={"availability": True})
        schedule_priority_job(db, p.id)
        db.commit()
    assert Worker(worker_db, {}, {"fake": adapter, "user_reports": adapter}).run_once() == []
    assert adapter.calls == 0
