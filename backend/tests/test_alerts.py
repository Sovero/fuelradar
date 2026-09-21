"""T07 — событийный движок и правила уведомлений (R34-R38, R97i).

БД общая на весь прогон тестов (db_session — session-scope): станции/провайдеры/
пользователи — с уникальными для этого файла идентификаторами (fr_station_97xxxx,
t07_*), правила (AlertRule) — активные только внутри своего теста, удаляются в
конце (see incident note in T05/T06 reports — не оставлять активные объекты,
которые могут срабатывать на станциях других тестовых файлов).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select

from app.alerts import channels
from app.alerts.events import (
    CONFIDENCE_INCREASED,
    FUEL_APPEARED,
    FUEL_DISAPPEARED,
    FUEL_LOW,
    QUEUE_DECREASED,
    QUEUE_INCREASED,
    STATION_NEW,
    EventState,
    diff_event,
)
from app.alerts.models import AlertStateSnapshot
from app.alerts.service import evaluate_rules
from app.confidence.service import StatusService
from app.core.config import settings
from app.db.models import AlertEvent, AlertRule, Favorite, FuelType, SourceProvider, Station

pytestmark = pytest.mark.usefixtures("client")  # форсируем полную регистрацию моделей (app.main) до init_db


def _ago(minutes: float) -> datetime:
    return datetime.now(UTC).replace(tzinfo=None) - timedelta(minutes=minutes)


# ---------- unit: чистая diff-функция (R35/R37) ----------


def test_diff_event_station_new_when_no_previous_state():
    assert diff_event(None, EventState("AVAILABLE", 90, "NONE")) == STATION_NEW


def test_diff_event_fuel_appeared_and_disappeared():
    assert diff_event(EventState("UNAVAILABLE", 0, "UNKNOWN"), EventState("AVAILABLE", 90, "UNKNOWN")) == FUEL_APPEARED
    assert diff_event(EventState("UNCERTAIN", 40, "UNKNOWN"), EventState("LIKELY_AVAILABLE", 65, "UNKNOWN")) == FUEL_APPEARED
    assert diff_event(EventState("AVAILABLE", 90, "UNKNOWN"), EventState("UNAVAILABLE", 0, "UNKNOWN")) == FUEL_DISAPPEARED


def test_diff_event_fuel_low():
    assert diff_event(EventState("AVAILABLE", 90, "UNKNOWN"), EventState("LOW_STOCK", 80, "UNKNOWN")) == FUEL_LOW


def test_diff_event_no_change_no_event_r37():
    """R37: состояние не изменилось → уведомление повторно не шлём."""
    state = EventState("AVAILABLE", 90, "LOW")
    assert diff_event(state, state) is None
    assert diff_event(EventState("AVAILABLE", 90, "LOW"), EventState("AVAILABLE", 91, "LOW")) is None  # рост < порога


def test_diff_event_queue_increased_decreased():
    assert diff_event(EventState("AVAILABLE", 90, "NONE"), EventState("AVAILABLE", 90, "HIGH")) == QUEUE_INCREASED
    assert diff_event(EventState("AVAILABLE", 90, "HIGH"), EventState("AVAILABLE", 90, "LOW")) == QUEUE_DECREASED


def test_diff_event_queue_unknown_transition_is_not_an_event():
    """Устаревание очереди (TTL → UNKNOWN) — не «выросла»/«упала»."""
    assert diff_event(EventState("AVAILABLE", 90, "HIGH"), EventState("AVAILABLE", 90, "UNKNOWN")) is None
    assert diff_event(EventState("AVAILABLE", 90, "UNKNOWN"), EventState("AVAILABLE", 90, "NONE")) is None


def test_diff_event_confidence_increased():
    assert diff_event(EventState("AVAILABLE", 60, "NONE"), EventState("AVAILABLE", 80, "NONE")) == CONFIDENCE_INCREASED


# ---------- интеграция: правила + БД ----------


def _provider(db_session, code: str, trust: float = 0.8) -> SourceProvider:
    provider = db_session.scalar(select(SourceProvider).where(SourceProvider.code == code))
    if provider is None:
        provider = SourceProvider(code=code, name=code, capabilities={}, status="TEST", trust=trust)
        db_session.add(provider)
        db_session.flush()
    return provider


def _station(db_session, station_id: str, **kwargs) -> Station:
    station = db_session.get(Station, station_id)
    if station is None:
        station = Station(id=station_id, canonical_name=f"АЗС {station_id}", latitude=45.0, longitude=39.0, **kwargs)
        db_session.add(station)
        db_session.flush()
    return station


def _cleanup_rule(db_session, rule: AlertRule) -> None:
    """Не оставлять активные правила на общей тестовой БД (see T05/T06 incident)."""
    db_session.delete(rule)
    db_session.commit()


def test_one_notification_when_status_becomes_available(db_session):
    """§127-подобный сценарий: правило «следить» → статус стал AVAILABLE → одно уведомление."""
    station = _station(db_session, "fr_station_970001")
    provider = _provider(db_session, "t07_official", trust=0.9)
    rule = AlertRule(scope={"station_id": station.id}, status_filter="AVAILABLE", is_active=True)
    db_session.add(rule)
    db_session.commit()
    try:
        service = StatusService(db_session)
        service.record_fuel_observation(station.id, "AI_95", "UNAVAILABLE", provider.id, observed_at=_ago(20))
        service.record_fuel_observation(station.id, "AI_95", "AVAILABLE", provider.id, observed_at=_ago(1))

        events = list(db_session.scalars(select(AlertEvent).where(AlertEvent.rule_id == rule.id)))
        assert len(events) == 1
        assert events[0].event_type == FUEL_APPEARED
        assert events[0].delivered is False

        db_session.refresh(rule)
        assert rule.trigger_count == 1
        assert rule.last_event_at is not None
    finally:
        db_session.query(AlertEvent).filter(AlertEvent.rule_id == rule.id).delete()
        db_session.commit()
        _cleanup_rule(db_session, rule)


def test_no_repeat_notification_when_status_stays_available(db_session):
    """R37: AVAILABLE → AVAILABLE повторно не шлёт уведомление."""
    station = _station(db_session, "fr_station_970002")
    provider = _provider(db_session, "t07_official2", trust=0.9)
    rule = AlertRule(scope={"station_id": station.id}, status_filter="AVAILABLE", is_active=True)
    db_session.add(rule)
    db_session.commit()
    try:
        service = StatusService(db_session)
        service.record_fuel_observation(station.id, "AI_95", "AVAILABLE", provider.id, observed_at=_ago(20))
        first_count = db_session.scalar(select(func.count()).select_from(AlertEvent).where(AlertEvent.rule_id == rule.id))
        service.record_fuel_observation(station.id, "AI_95", "AVAILABLE", provider.id, observed_at=_ago(1))
        second_count = db_session.scalar(select(func.count()).select_from(AlertEvent).where(AlertEvent.rule_id == rule.id))
        assert second_count == first_count
    finally:
        db_session.query(AlertEvent).filter(AlertEvent.rule_id == rule.id).delete()
        db_session.commit()
        _cleanup_rule(db_session, rule)


def test_three_confirmations_within_window_yield_one_notification(db_session):
    """R38: одно и то же изменение (тут — очередь по станции), увиденное с трёх
    строк топлива в одном пересчёте (реальный путь дедупликации — dedup_key без
    fuel_type_id для QUEUE_*), даёт ровно одно уведомление в окне 5 минут."""
    station = _station(db_session, "fr_station_970003")
    provider = _provider(db_session, "t07_queue_src", trust=0.9)
    rule = AlertRule(scope={"station_id": station.id}, is_active=True)
    db_session.add(rule)
    db_session.commit()
    try:
        service = StatusService(db_session)
        # Три вида топлива на одной станции — recompute_station_queue пересчитает
        # очередь для всех трёх строк station_current_status за один вызов.
        for fuel_code in ("AI_92", "AI_95", "DIESEL"):
            service.record_fuel_observation(station.id, fuel_code, "AVAILABLE", provider.id, observed_at=_ago(30))
        service.record_queue_observation(station.id, "NONE", provider.id, observed_at=_ago(20))
        before = db_session.scalar(select(func.count()).select_from(AlertEvent).where(AlertEvent.rule_id == rule.id))
        service.record_queue_observation(station.id, "HIGH", provider.id, observed_at=_ago(1))
        after = db_session.scalar(select(func.count()).select_from(AlertEvent).where(AlertEvent.rule_id == rule.id))
        queue_events = list(
            db_session.scalars(
                select(AlertEvent).where(AlertEvent.rule_id == rule.id, AlertEvent.event_type == QUEUE_INCREASED)
            )
        )
        assert after - before == 1, "три строки топлива → одно и то же изменение очереди → одно уведомление (R38)"
        assert len(queue_events) == 1
    finally:
        db_session.query(AlertEvent).filter(AlertEvent.rule_id == rule.id).delete()
        db_session.commit()
        _cleanup_rule(db_session, rule)


def test_confidence_min_gates_notification(db_session):
    station = _station(db_session, "fr_station_970004")
    # trust ниже confidence_min_weight (по умолчанию 0.30) → единственный голос
    # не набирает минимальный вес → UNCERTAIN, confidence <= 50 (R19.1).
    provider = _provider(db_session, "t07_weak_src", trust=0.15)
    rule = AlertRule(scope={"station_id": station.id}, confidence_min=90, is_active=True)
    db_session.add(rule)
    db_session.commit()
    try:
        service = StatusService(db_session)
        # Единственный слабый источник — статус появляется, но confidence низкий.
        service.record_fuel_observation(station.id, "AI_95", "AVAILABLE", provider.id, observed_at=_ago(1))
        count = db_session.scalar(select(func.count()).select_from(AlertEvent).where(AlertEvent.rule_id == rule.id))
        assert count == 0, "правило с confidence_min=90 не должно сработать на слабом источнике"
    finally:
        db_session.query(AlertEvent).filter(AlertEvent.rule_id == rule.id).delete()
        db_session.commit()
        _cleanup_rule(db_session, rule)


def test_favorites_scope_only_matches_favorited_station(db_session):
    watched = _station(db_session, "fr_station_970005")
    other = _station(db_session, "fr_station_970006")
    provider = _provider(db_session, "t07_fav_src", trust=0.9)
    db_session.add(Favorite(station_id=watched.id))
    rule = AlertRule(scope={"type": "favorites"}, is_active=True)
    db_session.add(rule)
    db_session.commit()
    try:
        service = StatusService(db_session)
        service.record_fuel_observation(other.id, "AI_95", "AVAILABLE", provider.id, observed_at=_ago(1))
        assert db_session.scalar(
            select(func.count()).select_from(AlertEvent).where(AlertEvent.rule_id == rule.id)
        ) == 0

        service.record_fuel_observation(watched.id, "AI_95", "AVAILABLE", provider.id, observed_at=_ago(1))
        assert db_session.scalar(
            select(func.count()).select_from(AlertEvent).where(AlertEvent.rule_id == rule.id)
        ) == 1
    finally:
        db_session.query(AlertEvent).filter(AlertEvent.rule_id == rule.id).delete()
        db_session.commit()
        db_session.query(Favorite).filter(Favorite.station_id == watched.id).delete()
        db_session.commit()
        _cleanup_rule(db_session, rule)


def test_evaluate_rules_returns_empty_without_current_status(db_session):
    """Нет station_current_status для (station, fuel) — оценивать нечего."""
    fuel_id = db_session.scalar(select(FuelType.id).where(FuelType.code == "AI_95"))
    assert evaluate_rules(db_session, "fr_station_nonexistent", fuel_id) == []


def test_snapshot_cache_persists_between_calls(db_session):
    station = _station(db_session, "fr_station_970008")
    provider = _provider(db_session, "t07_snapshot_src", trust=0.9)
    service = StatusService(db_session)
    service.record_fuel_observation(station.id, "AI_95", "AVAILABLE", provider.id, observed_at=_ago(1))
    fuel_id = db_session.scalar(select(FuelType.id).where(FuelType.code == "AI_95"))
    snapshot = db_session.scalar(
        select(AlertStateSnapshot).where(
            AlertStateSnapshot.station_id == station.id, AlertStateSnapshot.fuel_type_id == fuel_id
        )
    )
    assert snapshot is not None
    assert snapshot.status == "AVAILABLE"


# ---------- канал Web Push (R64/R97i) ----------


def test_web_push_not_configured_without_keys(monkeypatch):
    monkeypatch.setattr(settings, "vapid_public_key", "")
    monkeypatch.setattr(settings, "vapid_private_key", "")
    event = AlertEvent(id=1, station_id="x", event_type="FUEL_APPEARED", payload={})
    station = Station(id="x", latitude=1, longitude=1)
    assert channels.send_web_push(event, station) == "not_configured"


def test_web_push_without_subscriptions_is_honest(client, db_session, monkeypatch):
    """T14: ключи заданы, но хранилище подписок пусто — честный статус, не «sent»."""
    from sqlalchemy import select as _select

    from app.db.models import PushSubscription

    monkeypatch.setattr(settings, "vapid_public_key", "pub-key")
    monkeypatch.setattr(settings, "vapid_private_key", "priv-key")
    for row in db_session.scalars(_select(PushSubscription)).all():
        db_session.delete(row)
    db_session.commit()
    event = AlertEvent(id=1, station_id="x", event_type="FUEL_APPEARED", payload={})
    station = Station(id="x", latitude=1, longitude=1)
    assert channels.send_web_push(event, station) == "no_subscriptions"


# ---------- лента уведомлений (A03) ----------


def test_notifications_feed_and_read_reset(client, db_session):
    station = _station(db_session, "fr_station_970009")
    provider = _provider(db_session, "t07_notif_src", trust=0.9)
    rule = AlertRule(scope={"station_id": station.id}, status_filter="AVAILABLE", is_active=True)
    db_session.add(rule)
    db_session.commit()
    try:
        service = StatusService(db_session)
        service.record_fuel_observation(station.id, "AI_95", "UNAVAILABLE", provider.id, observed_at=_ago(20))
        service.record_fuel_observation(station.id, "AI_95", "AVAILABLE", provider.id, observed_at=_ago(1))

        page = client.get("/api/v1/notifications").json()
        assert page["unread_count"] >= 1
        assert any(item["station_id"] == station.id for item in page["items"])

        r = client.post("/api/v1/notifications/read", json={})
        assert r.status_code == 200
        assert r.json()["unread_count"] == 0

        page_after = client.get("/api/v1/notifications").json()
        assert page_after["unread_count"] == 0
    finally:
        db_session.query(AlertEvent).filter(AlertEvent.rule_id == rule.id).delete()
        db_session.commit()
        _cleanup_rule(db_session, rule)
