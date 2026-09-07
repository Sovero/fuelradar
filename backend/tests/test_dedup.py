"""T03 — дедупликация мастер-каталога (R02/R09/R10).

Unit: взвешенное сравнение по §11. Интеграция: auto-merge → одна станция с общими
внешними ID, REVIEW-очередь и подтверждение админом, split восстанавливает обе
станции, повторный проход ничего не задваивает.
"""

from __future__ import annotations

import json

import pytest
from sqlalchemy import func, select

from app.core.config import settings
from app.db.models import (
    DedupDecision,
    SourceProvider,
    SourceStationRecord,
    Station,
    StationBrand,
    StationExternalId,
)
from app.db.session import init_db
from app.dedup import DedupService, compare_records
from app.dedup.compare import CompareInput


@pytest.fixture(scope="module", autouse=True)
def _db() -> None:
    init_db()


def _add_provider(session, code: str, **kw) -> SourceProvider:
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


def _add_record(session, provider, ext_id: str, lat: float, lon: float, **kw) -> SourceStationRecord:
    record = SourceStationRecord(
        source_provider_id=provider.id,
        external_id=ext_id,
        latitude=lat,
        longitude=lon,
        brand_raw=kw.get("brand", ""),
        name_raw=kw.get("name", ""),
        address_raw=kw.get("address", ""),
        payload=kw.get("payload", ""),
    )
    session.add(record)
    session.flush()
    return record


def _count_stations(session) -> int:
    return session.scalar(select(func.count()).select_from(Station))


# ---------- unit: взвешенное сравнение (§11) ----------

def test_compare_same_brand_same_point_auto_merge() -> None:
    a = CompareInput(45.0, 39.0, brand_raw="Лукойл", name_raw="АЗС Лукойл №47", phone="+7 (861) 123-45-67")
    b = CompareInput(45.0, 39.0, brand_raw="ЛУКОЙЛ", name_raw="Лукойл", phone="8 861 1234567")
    r = compare_records(a, b)
    assert r.score >= settings.dedup_auto_merge
    assert r.components["coordinates"] == 1.0
    assert r.components["brand"] == 1.0
    assert r.components["phone"] == 1.0
    # разбор по весам: ровно компоненты §11
    assert set(r.components) == {"coordinates", "brand", "address", "name", "phone"}


def test_compare_same_brand_far_not_merged() -> None:
    a = CompareInput(45.0, 39.0, brand_raw="Лукойл", name_raw="АЗС №1")
    b = CompareInput(45.06, 39.0, brand_raw="Лукойл", name_raw="АЗС №2")  # ~6.7 км
    r = compare_records(a, b)
    assert r.distance_km > 1.0
    assert r.components["coordinates"] == 0.0
    assert r.score < settings.dedup_needs_review


def test_compare_diff_brand_same_point_is_review_band() -> None:
    a = CompareInput(45.0, 39.0, brand_raw="Лукойл", name_raw="АЗС Лукойл", address_raw="ул. Северная 1")
    b = CompareInput(45.0, 39.0, brand_raw="Роснефть", name_raw="АЗС Роснефть", address_raw="ул. Северная 1")
    r = compare_records(a, b)
    assert settings.dedup_needs_review <= r.score < settings.dedup_auto_merge


def test_compare_empty_fields_are_neutral() -> None:
    a = CompareInput(45.0, 39.0)
    b = CompareInput(45.0, 39.0)
    r = compare_records(a, b)
    assert r.components["brand"] == 0.5
    assert r.components["address"] == 0.5
    assert r.components["name"] == 0.5
    assert r.components["phone"] == 0.5
    # совпали только координаты, остальное нейтрально: 0.5+0.1+0.075+0.05+0.025 = 0.75
    assert settings.dedup_needs_review <= r.score < settings.dedup_auto_merge


# ---------- интеграция: процесс дедупликации ----------

def test_auto_merge_two_sources_one_station(db_session) -> None:
    # координаты теста уникальны для общей БД (другие кластеры — дальше 2 км)
    p_osm = _add_provider(db_session, "osm_dedup")
    p_net = _add_provider(db_session, "net_dedup")
    r1 = _add_record(
        db_session, p_osm, "osm-lukoil-1", 45.10, 39.10,
        brand="Лукойл", name="АЗС Лукойл №47", address="ул. Северная, 228",
        payload=json.dumps({"phone": "+7 (861) 111-22-33"}),
    )
    r2 = _add_record(
        db_session, p_net, "net-lukoil-1", 45.10, 39.10,
        brand="ЛУКОЙЛ", name="Лукойл", address="ул. Северная 228",
        payload=json.dumps({"phone": "8 (861) 111-22-33"}),
    )
    summary = DedupService(db_session).process_pending()
    assert summary["auto_merged"] == 1 and summary["created"] == 1

    db_session.refresh(r1)
    db_session.refresh(r2)
    assert r1.station_id == r2.station_id
    assert r1.dedup_state == "MERGED" and r2.dedup_state == "MERGED"

    station = db_session.get(Station, r1.station_id)
    assert station is not None
    assert station.canonical_name == "АЗС Лукойл №47"
    assert station.phone == "+7 (861) 111-22-33"
    brand = db_session.get(StationBrand, station.brand_id)
    assert brand is not None and brand.name == "Лукойл"

    ext_ids = set(
        db_session.scalars(select(StationExternalId).where(StationExternalId.station_id == station.id))
    )
    assert {(e.source_provider_id, e.external_id) for e in ext_ids} == {
        (p_osm.id, "osm-lukoil-1"),
        (p_net.id, "net-lukoil-1"),
    }

    decision = db_session.scalar(
        select(DedupDecision).where(DedupDecision.decision == "AUTO_MERGE").order_by(DedupDecision.id.desc())
    )
    assert decision.actor == "system"
    assert decision.weights["coordinates"] == 1.0


def test_far_stations_are_not_merged(db_session) -> None:
    p = _add_provider(db_session, "far_dedup")
    r1 = _add_record(db_session, p, "far-1", 45.20, 39.20, brand="Лукойл", name="АЗС №1")
    r2 = _add_record(db_session, p, "far-2", 45.26, 39.20, brand="Лукойл", name="АЗС №2")  # ~6.7 км
    summary = DedupService(db_session).process_pending()
    assert summary["created"] == 2 and summary["auto_merged"] == 0
    assert r1.station_id != r2.station_id


def test_single_source_record_creates_station(db_session) -> None:
    """R02: станция существует при подтверждении одним источником."""
    p = _add_provider(db_session, "single_dedup")
    r = _add_record(db_session, p, "one-1", 45.30, 39.30, brand="Лукойл", name="АЗС № 47")
    summary = DedupService(db_session).process_pending()
    assert summary["created"] == 1 and summary["review"] == 0
    db_session.refresh(r)
    assert r.station_id is not None and r.dedup_state == "MERGED"
    station = db_session.get(Station, r.station_id)
    assert station.canonical_name == "АЗС № 47"


def test_review_queue_and_admin_confirm(db_session) -> None:
    """Средний score → REVIEW; админ подтверждает — merge с журналом (R10)."""
    p = _add_provider(db_session, "review_dedup")
    r1 = _add_record(db_session, p, "rev-1", 45.40, 39.40, brand="Лукойл", name="АЗС Лукойл", address="ул. Северная 1")
    r2 = _add_record(db_session, p, "rev-2", 45.40, 39.40, brand="Роснефть", name="АЗС Роснефть", address="ул. Северная 1")

    service = DedupService(db_session)
    summary = service.process_pending()
    assert summary["created"] == 1 and summary["review"] == 1

    db_session.refresh(r1)
    db_session.refresh(r2)
    review = r2 if r2.dedup_state == "REVIEW" else r1
    other = r1 if review is r2 else r2
    assert review.station_id is None

    candidates = service.review_candidates()
    assert len(candidates) == 1
    assert candidates[0]["record_id"] == review.id
    assert candidates[0]["suggested_record_id"] == other.id
    assert candidates[0]["suggested_station_id"] == other.station_id
    assert candidates[0]["score"] is not None
    assert set(candidates[0]["weights"]) == {"coordinates", "brand", "address", "name", "phone"}

    station_id = service.admin_merge(other.id, review.id, actor="admin")
    db_session.refresh(review)
    assert review.station_id == station_id
    assert review.dedup_state == "MERGED"

    decision = db_session.scalar(
        select(DedupDecision).where(DedupDecision.decision == "MERGE").order_by(DedupDecision.id.desc())
    )
    assert decision.actor == "admin"
    assert decision.weights["brand"] == 0.0  # разные бренды — видно в разборе


def test_admin_split_restores_both_stations(db_session) -> None:
    """Split: ошибочно объединённая запись получает свою станцию с прежними ID (R10)."""
    p = _add_provider(db_session, "split_dedup")
    # одинаковые точка+бренд, без названий/телефонов: 0.5+0.2+0.075+0.05+0.025 = 0.85 → авто
    r1 = _add_record(db_session, p, "sp-1", 45.50, 39.50, brand="Лукойл", name="")
    r2 = _add_record(db_session, p, "sp-2", 45.50, 39.50, brand="Лукойл", name="")

    service = DedupService(db_session)
    summary = service.process_pending()
    assert summary["auto_merged"] == 1
    db_session.refresh(r1)
    db_session.refresh(r2)
    old_station_id = r1.station_id
    assert r2.station_id == old_station_id

    new_station_id = service.admin_split(r2.id, actor="admin")
    db_session.refresh(r1)
    db_session.refresh(r2)
    assert new_station_id != old_station_id
    assert r2.station_id == new_station_id
    assert r1.station_id == old_station_id

    # внешние ID последовали за записью — обе станции со своими ID (R08)
    ext = db_session.scalar(select(StationExternalId).where(StationExternalId.external_id == "sp-2"))
    assert ext.station_id == new_station_id
    ext1 = db_session.scalar(select(StationExternalId).where(StationExternalId.external_id == "sp-1"))
    assert ext1.station_id == old_station_id

    decision = db_session.scalar(
        select(DedupDecision).where(DedupDecision.decision == "SPLIT").order_by(DedupDecision.id.desc())
    )
    assert decision.actor == "admin"


def test_second_run_is_idempotent(db_session) -> None:
    """R09: повторный проход не создаёт станции повторно (идемпотентность по ext ID)."""
    p = _add_provider(db_session, "idem_dedup")
    _add_record(db_session, p, "idem-1", 45.60, 39.60, brand="Лукойл")
    _add_record(db_session, p, "idem-2", 45.60, 39.60, brand="Лукойл")

    service = DedupService(db_session)
    first = service.process_pending()
    assert first["auto_merged"] == 1 and first["created"] == 1
    stations_after_first = _count_stations(db_session)

    second = service.process_pending()
    assert second == {"auto_merged": 0, "review": 0, "created": 0}
    assert _count_stations(db_session) == stations_after_first