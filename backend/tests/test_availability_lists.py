"""Наличие топлива из сетевых списков (R94i) — источник без отметок водителей.

Проверяется вся цепочка на настоящих SQLite-транзакциях и настоящем адаптере:
список по HTTP (транспорт инъектируется — сети в тестах нет) → каталог → станции →
`station_current_status` без единого отчёта водителя. Плюс инварианты, которые
нельзя ослабить: «не знаю» не становится «нет» (R15), повторная выгрузка того же
списка не удваивает доказательства (R17), сбой наличия не превращает успешный
сбор каталога в FAILED (R84), а планировщик не дёргает список по каждой АЗС.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from app.alerts.models import AlertStateSnapshot  # noqa: F401
from app.analytics.models import AnalyticsSnapshot  # noqa: F401
from app.core.config import settings
from app.db.base import Base
from app.db.models import (
    CollectionJob,
    CollectionLog,
    FuelObservation,
    FuelType,
    SourceHealth,
    SourceProvider,
    SourceStationRecord,
    Station,
    StationCurrentStatus,
    StationExternalId,
    UserReport,
)
from app.sources.base import AdapterError, HealthResult, SourceAdapter, SourceRecord
from app.sources.network_lists import NetworkListsAdapter
from app.worker import Worker
from app.worker.service import apply_bulk_availability

REGION = {"city": "Краснодар", "lat": 45.0355, "lon": 38.9753, "radius_km": 10.0}
LIST_URL = "https://lists.example.com/krasnodar.json"

# Как в сиде app/db/session.py: список несёт и каталог, и наличие одним запросом.
CAPABILITIES = {"discovery": True, "availability": True, "queue": False, "availability_bulk": True}

# Полчаса назад: свежее TTL (R56). Список недельной давности — это уже UNKNOWN, и
# тест проверял бы истечение статуса, а не приём данных из сети.
OBSERVED_AT = (datetime.now(UTC).replace(tzinfo=None) - timedelta(minutes=30)).isoformat(timespec="seconds")


def _list_text(**fuel_overrides) -> str:
    """Список сети: две АЗС в регионе и одна за его пределами (клиппинг зоны пилота)."""
    inside = {"АИ-95": "есть", "ДТ": "нет", **fuel_overrides}
    return json.dumps(
        [
            {"name": "АЗС 1", "brand": "Лукойл", "lat": 45.03, "lon": 38.97, "ref": "1",
             "observed_at": OBSERVED_AT, "fuel": inside},
            {"name": "АЗС 2", "brand": "Роснефть", "lat": 45.05, "lon": 39.0, "ref": "2",
             "observed_at": OBSERVED_AT, "fuel": {"АИ-95": "AVAILABLE"}},
            {"name": "АЗС за городом", "brand": "Тест", "lat": 46.5, "lon": 39.9, "ref": "3",
             "observed_at": OBSERVED_AT, "fuel": {"АИ-95": "есть"}},
        ],
        ensure_ascii=False,
    )


@pytest.fixture
def worker_db(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'availability.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine)
    with factory() as db:
        db.add_all([
            FuelType(code="AI_95", display_name_ru="АИ-95"),
            FuelType(code="DIESEL", display_name_ru="ДТ"),
            FuelType(code="AI_98", display_name_ru="АИ-98"),
            FuelType(code="UNKNOWN", display_name_ru="Неизвестно"),
        ])
        db.commit()
    yield factory
    engine.dispose()


def lists_provider(db, code="network_lists", interval=0):
    provider = SourceProvider(
        code=code, name=code, status="ACTIVE", min_interval_minutes=interval,
        capabilities=dict(CAPABILITIES), trust=0.7,
    )
    db.add(provider)
    db.commit()
    return provider


def adapter_for(text: str) -> NetworkListsAdapter:
    return NetworkListsAdapter(urls=[LIST_URL], http_get=lambda url: text)


def _statuses(db) -> dict[str, str]:
    rows = db.execute(
        select(FuelType.code, StationCurrentStatus.status).join(
            StationCurrentStatus, StationCurrentStatus.fuel_type_id == FuelType.id
        )
    ).all()
    return dict(rows)


def test_list_statuses_become_station_status_without_any_reports(worker_db) -> None:
    """Сеть сказала «есть/нет» — это сразу статус на карте, без отметок водителей."""
    adapter = adapter_for(_list_text())
    with worker_db() as db:
        provider_id = lists_provider(db).id

    assert Worker(worker_db, REGION, {"network_lists": adapter}).run_once() != []

    with worker_db() as db:
        station = db.scalar(select(Station))
        assert station is not None  # каталог построен из того же списка
        assert _statuses(db)["AI_95"] == "AVAILABLE"
        assert _statuses(db)["DIESEL"] == "UNAVAILABLE"
        observations = list(db.scalars(select(FuelObservation)))
        # АЗС 1: АИ-95 + ДТ, АЗС 2: АИ-95; станция за городом — вне bbox региона
        assert len(observations) == 3
        assert {o.source_provider_id for o in observations} == {provider_id}
        assert db.scalar(select(func.count()).select_from(UserReport)) == 0


def test_unrecognized_value_never_becomes_unavailable(worker_db) -> None:
    """«уточняется» — это не «топлива нет» (R15): статуса по АИ-98 не появляется."""
    adapter = adapter_for(_list_text(**{"АИ-98": "уточняется"}))
    with worker_db() as db:
        lists_provider(db)

    Worker(worker_db, REGION, {"network_lists": adapter}).run_once()

    with worker_db() as db:
        assert "AI_98" not in _statuses(db)  # ни AVAILABLE, ни UNAVAILABLE
        assert adapter.skipped_fuel_values == 1
        # оператор видит причину в журнале сбора, а не гадает по карте
        messages = [entry.message for entry in db.scalars(select(CollectionLog))]
        assert any("не распознано" in message for message in messages)


def test_repeated_identical_list_is_one_evidence(worker_db) -> None:
    """Тот же список с тем же временем наблюдения — одно свидетельство, а не два (R17)."""
    adapter = adapter_for(_list_text())
    with worker_db() as db:
        provider = lists_provider(db)
        db.add(Station(id="s1", latitude=45.03, longitude=38.97))
        db.flush()
        db.add(SourceStationRecord(source_provider_id=provider.id, external_id="Лукойл-1",
                                   station_id="s1", latitude=45.03, longitude=38.97))
        db.commit()

    with worker_db() as db:
        provider = db.scalar(select(SourceProvider))
        adapter.discover_stations(REGION)
        at = datetime(2026, 10, 6, 10, 0)
        assert apply_bulk_availability(db, provider, adapter, at) == 2
        db.commit()
        # вторая выгрузка того же файла: новые строки не появляются
        assert apply_bulk_availability(db, provider, adapter, at + timedelta(hours=1)) == 0
        db.commit()
        assert db.scalar(select(func.count()).select_from(FuelObservation)) == 2


def test_planner_does_not_poll_bulk_source_per_station(worker_db) -> None:
    """Наличие приезжает вместе с каталогом: точечных заданий на каждую АЗС нет."""
    adapter = adapter_for(_list_text())
    with worker_db() as db:
        lists_provider(db)

    worker = Worker(worker_db, REGION, {"network_lists": adapter})
    assert worker.run_once() != []

    with worker_db() as db:
        per_station = db.scalars(
            select(CollectionJob).where(
                CollectionJob.job_type.in_(["availability", "queue"]),
                CollectionJob.station_id.is_not(None),
            )
        ).all()
        assert per_station == []
        assert db.scalar(select(func.count()).select_from(SourceStationRecord)) >= 1


def test_bulk_source_still_gets_queue_jobs(worker_db) -> None:
    """Флаг bulk убирает только точечное НАЛИЧИЕ: очередь у источника-списка
    может быть своим потоком данных, и она остаётся плановой работой."""
    adapter = adapter_for(_list_text())
    with worker_db() as db:
        provider = SourceProvider(
            code="network_lists", name="network_lists", status="ACTIVE",
            min_interval_minutes=0, trust=0.7,
            capabilities={"discovery": True, "availability": True, "queue": True, "availability_bulk": True},
        )
        db.add(provider)
        db.commit()
        db.add(Station(id="s1", latitude=45.03, longitude=38.97))
        db.flush()
        db.add(StationExternalId(station_id="s1", source_provider_id=provider.id, external_id="ext-1"))
        db.commit()

    worker = Worker(worker_db, REGION, {"network_lists": adapter})
    at = datetime.now(UTC).replace(tzinfo=None)
    worker.run_once(at)
    worker.run_once(at + timedelta(minutes=settings.collect_stable_minutes + 1))

    with worker_db() as db:
        kinds = set(db.scalars(select(CollectionJob.job_type).where(CollectionJob.station_id == "s1")))
        assert "queue" in kinds
        assert "availability" not in kinds


def test_availability_failure_does_not_fail_the_catalog_job(worker_db) -> None:
    """Сбой записи наличия — отдельная строка журнала, каталог остаётся успешным (R84)."""

    class BrokenAvailability(NetworkListsAdapter):
        def bulk_fuel_availability(self):
            raise RuntimeError("boom")

    adapter = BrokenAvailability(urls=[LIST_URL], http_get=lambda url: _list_text())
    with worker_db() as db:
        provider_id = lists_provider(db).id

    Worker(worker_db, REGION, {"network_lists": adapter}).run_once()

    with worker_db() as db:
        job = db.scalar(select(CollectionJob).order_by(CollectionJob.id.desc()))
        assert job.status == "DONE"
        health = db.scalar(select(SourceHealth).where(SourceHealth.source_provider_id == provider_id))
        assert health.health == "ONLINE"
        errors = [entry.message for entry in db.scalars(select(CollectionLog).where(CollectionLog.level == "ERROR"))]
        assert any("availability: RuntimeError" == message for message in errors)


def test_record_without_resolved_station_is_skipped(worker_db) -> None:
    """Запись ещё не привязана к станции (дедуп не прошёл) — наличия по ней нет, без падения."""
    adapter = adapter_for(_list_text())
    with worker_db() as db:
        provider = lists_provider(db)
        db.add(SourceStationRecord(source_provider_id=provider.id, external_id="Лукойл-1",
                                   latitude=45.03, longitude=38.97))  # station_id нет
        adapter.discover_stations(REGION)
        assert apply_bulk_availability(db, provider, adapter) == 0


def test_adapter_capabilities_match_the_seed() -> None:
    """Заголовок сида и адаптер не должны разъезжаться: иначе планировщик опять
    пойдёт по каждой АЗС, а наличие из списка никто не применит."""
    from app.db.session import SOURCE_PROVIDERS

    spec = next(item for item in SOURCE_PROVIDERS if item["code"] == "network_lists")
    capabilities = NetworkListsAdapter.capabilities
    assert spec["capabilities"]["availability"] is capabilities["availability"] is True
    assert spec["capabilities"]["availability_bulk"] is capabilities["availability_bulk"] is True
    # интервал ниже TTL статуса (R56), иначе карта честно показывала бы UNKNOWN
    assert spec["min_interval_minutes"] < settings.ttl_fuel_minutes


def test_deduped_record_keeps_raw_fuel_in_payload(worker_db) -> None:
    """Сырьё списка сохраняется в записи источника (R84) — видно, что именно сказала сеть."""
    adapter = adapter_for(_list_text())
    with worker_db() as db:
        lists_provider(db)
    Worker(worker_db, REGION, {"network_lists": adapter}).run_once()
    with worker_db() as db:
        records = list(db.scalars(select(SourceStationRecord)))
        assert records
        payload = json.loads(records[0].payload)
        assert payload["fuel"]["АИ-95"] == "есть"


def test_station_outside_region_keeps_no_status(worker_db) -> None:
    """Клиппинг зоны пилота: АЗС за bbox в наличие не попадает, хотя источник её назвал."""
    adapter = adapter_for(_list_text())
    with worker_db() as db:
        lists_provider(db)
    Worker(worker_db, REGION, {"network_lists": adapter}).run_once()
    with worker_db() as db:
        station_ids = set(db.scalars(select(Station.id)))
        assert len(station_ids) == 2  # две АЗС в регионе, третья отброшена
        assert db.scalar(select(func.count()).select_from(FuelObservation)) == 3


def test_health_check_still_honest_without_urls() -> None:
    """Без URL источник молчит и говорит об этом (R12/R57) — наличия не выдумывает."""
    adapter = NetworkListsAdapter(urls=[])
    assert adapter.bulk_fuel_availability() == {}
    with pytest.raises(AdapterError):
        adapter.discover_stations(REGION)


def test_plain_catalog_source_writes_no_availability(worker_db) -> None:
    """Источник без наличия (чистый каталог) не пишет наблюдений и не шумит в журнале."""

    class CatalogOnly(SourceAdapter):
        capabilities = {"discovery": True, "availability": False, "queue": False}

        def discover_stations(self, region):
            return [SourceRecord("ext-1", 45.03, 38.97, brand_raw="Тест", name_raw="Каталог")]

        def health_check(self):
            return HealthResult("ONLINE")

    with worker_db() as db:
        db.add(SourceProvider(code="catalog_only", name="catalog_only", status="ACTIVE",
                              min_interval_minutes=0, capabilities=dict(CatalogOnly.capabilities)))
        db.commit()

    Worker(worker_db, REGION, {"catalog_only": CatalogOnly()}).run_once()

    with worker_db() as db:
        assert db.scalar(select(func.count()).select_from(FuelObservation)) == 0
        messages = [entry.message for entry in db.scalars(select(CollectionLog))]
        assert not any(message.startswith("availability") for message in messages)
