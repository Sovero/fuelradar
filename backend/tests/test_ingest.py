"""T02 — ингест каталога: изоляция ошибок источника (R84), upsert, health (R57)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from sqlalchemy import func, select

from app.db.models import (
    CollectionJob,
    CollectionLog,
    SourceHealth,
    SourceProvider,
    SourceStationRecord,
)
from app.db.session import init_db
from app.sources.base import (
    HEALTH_OFFLINE,
    HEALTH_ONLINE,
    HEALTH_RATE_LIMITED,
    AdapterError,
    HealthResult,
    RateLimitedError,
    SourceAdapter,
    SourceRecord,
)
from app.sources.overpass import OverpassAdapter
from app.stations.ingest import CatalogIngest

FIXTURES = Path(__file__).parent / "fixtures"
REGION = {"city": "Краснодар", "lat": 45.0355, "lon": 38.9753, "radius_km": 10.0}


@pytest.fixture(scope="module", autouse=True)
def _db() -> None:
    init_db()


def _overpass_offline() -> OverpassAdapter:
    data = json.loads((FIXTURES / "overpass_krasnodar.json").read_text("utf-8"))
    return OverpassAdapter(http_get=lambda url, params: data)


class BrokenAdapter(SourceAdapter):
    """Адаптер, который всегда падает — для проверки изоляции (R84)."""

    provider_code = "broken_test"
    provider_name = "Broken (test)"
    capabilities = {"discovery": True, "availability": False, "queue": False}
    error_cls: type[Exception] = AdapterError

    def discover_stations(self, region) -> list[SourceRecord]:
        raise self.error_cls("boom: источник недоступен")

    def health_check(self) -> HealthResult:
        return HealthResult(HEALTH_OFFLINE, "boom")


def _add_provider(session, code: str, **kw) -> SourceProvider:
    """Провайдер для тестов. Статус TEST, а не ACTIVE: иначе он попадает в
    дефолтный выбор seed/воркера и ломает другие тесты на общей БД."""
    provider = session.scalar(select(SourceProvider).where(SourceProvider.code == code))
    if provider is None:
        provider = SourceProvider(
            code=code,
            name=kw.pop("name", code),
            capabilities=kw.pop("capabilities", {"discovery": True, "availability": False, "queue": False}),
            status=kw.pop("status", "TEST"),
            **kw,
        )
        session.add(provider)
        session.flush()
    return provider


# ---------- R84: сбой одного источника не роняет остальные ----------

def test_failure_isolation(db_session) -> None:
    broken = _add_provider(db_session, "broken_test")
    # «старые данные» от другого источника — должны пережить сбой
    network = _add_provider(db_session, "network_import")
    survivor = SourceStationRecord(
        source_provider_id=network.id,
        external_id="Лукойл-3",
        latitude=45.0,
        longitude=39.0,
        brand_raw="Лукойл",
        name_raw="АЗС № 3",
        dedup_state="MERGED",
    )
    db_session.add(survivor)
    db_session.commit()

    ingest = CatalogIngest(db_session)
    summary = ingest.collect_catalog(
        REGION,
        source_codes=["osm_overpass", "broken_test"],
        trigger="test",
        adapter_overrides={"osm_overpass": _overpass_offline(), "broken_test": BrokenAdapter()},
    )

    assert summary["osm_overpass"]["records"] == 4
    assert summary["osm_overpass"]["errors"] == 0
    assert summary["broken_test"]["records"] == 0
    assert summary["broken_test"]["errors"] == 1

    # запись выжившего источника не тронута (R84: данные не удаляются/не портятся)
    untouched = db_session.get(SourceStationRecord, survivor.id)
    assert untouched is not None
    assert untouched.dedup_state == "MERGED"
    assert untouched.brand_raw == "Лукойл"

    # job-журнал: сбой зафиксирован
    job = db_session.scalar(
        select(CollectionJob).where(CollectionJob.source_provider_id == broken.id).order_by(CollectionJob.id.desc())
    )
    assert job.status == "FAILED"
    assert "boom" in job.error_message
    assert db_session.scalar(
        select(func.count()).select_from(CollectionLog).where(CollectionLog.job_id == job.id)
    ) == 1

    # health: failed → OFFLINE, успешный → ONLINE
    broken_health = db_session.scalar(select(SourceHealth).where(SourceHealth.source_provider_id == broken.id))
    assert broken_health.health == HEALTH_OFFLINE
    assert broken_health.consecutive_failures == 1
    osm_health = db_session.scalar(
        select(SourceHealth).where(SourceHealth.source_provider_id == _add_provider(db_session, "osm_overpass").id)
    )
    assert osm_health.health == HEALTH_ONLINE


def test_rate_limited_maps_to_health(db_session) -> None:
    class LimitedAdapter(BrokenAdapter):
        error_cls = RateLimitedError

    provider = _add_provider(db_session, "limited_test")
    CatalogIngest(db_session).collect_catalog(
        REGION, source_codes=["limited_test"], trigger="test", adapter_overrides={"limited_test": LimitedAdapter()}
    )
    health = db_session.scalar(select(SourceHealth).where(SourceHealth.source_provider_id == provider.id))
    assert health.health == HEALTH_RATE_LIMITED


# ---------- upsert: повторный сбор не плодит дубли ----------

def test_ingest_upsert_idempotent(db_session) -> None:
    ingest = CatalogIngest(db_session)
    ingest.collect_catalog(REGION, source_codes=["osm_overpass"], trigger="test", adapter_overrides={"osm_overpass": _overpass_offline()})
    ingest.collect_catalog(REGION, source_codes=["osm_overpass"], trigger="test", adapter_overrides={"osm_overpass": _overpass_offline()})

    provider = _add_provider(db_session, "osm_overpass")
    total = db_session.scalar(
        select(func.count()).select_from(SourceStationRecord).where(SourceStationRecord.source_provider_id == provider.id)
    )
    assert total == 4
    # запись обновилась, а не продублировалась
    one = db_session.scalar(
        select(SourceStationRecord).where(
            SourceStationRecord.source_provider_id == provider.id,
            SourceStationRecord.external_id == "node/1000001",
        )
    )
    assert one.dedup_state == "PENDING"
    assert json.loads(one.payload)["id"] == 1000001


def test_user_reports_does_not_discover(db_session) -> None:
    ingest = CatalogIngest(db_session)
    summary = ingest.collect_catalog(REGION, source_codes=["user_reports"], trigger="test")
    assert summary["user_reports"]["records"] == 0
    assert summary["user_reports"]["errors"] == 0