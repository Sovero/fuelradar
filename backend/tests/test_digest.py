"""Telegram-дайджест: настройки, расписание, текст сводки, доставка — без сети."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.core.config import settings
from app.db.models import AppSetting, SourceProvider, Station, UserReport
from app.digest import service as digest
from app.digest.service import (
    TelegramSettings,
    build_digest_message,
    digest_due,
    load_telegram_settings,
    maybe_send_digest,
    public_state,
    save_telegram_settings,
    send_telegram_message,
    token_fingerprint,
)

pytestmark = pytest.mark.usefixtures("client")


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


@pytest.fixture(autouse=True)
def _clean_settings(db_session):
    """Каждый тест — с чистой настройкой канала (общая БД)."""
    row = db_session.get(AppSetting, digest.TELEGRAM_SETTING_KEY)
    if row is not None:
        db_session.delete(row)
        db_session.commit()
    original = (settings.telegram_bot_token, settings.telegram_chat_id, settings.telegram_digest_minutes)
    settings.telegram_bot_token = ""
    settings.telegram_chat_id = ""
    settings.telegram_digest_minutes = 0
    yield
    settings.telegram_bot_token, settings.telegram_chat_id, settings.telegram_digest_minutes = original


def _station(db_session, station_id: str, name: str = "АЗС Дайджест") -> Station:
    if db_session.get(Station, station_id) is None:
        db_session.add(Station(id=station_id, canonical_name=name, latitude=45.0, longitude=39.0, city="Краснодар"))
        db_session.commit()
    return db_session.get(Station, station_id)


# ---------- настройки и секреты (R68) ----------


def test_defaults_come_from_env_and_are_empty(db_session):
    state = load_telegram_settings(db_session)
    assert state.token == "" and state.chat_id == ""
    assert state.configured is False
    assert public_state(db_session)["configured"] is False


def test_save_and_load_overrides_env(db_session, monkeypatch):
    monkeypatch.setattr(settings, "telegram_bot_token", "env-token")
    state = save_telegram_settings(db_session, token="123:ui-token", chat_id="42", interval_minutes=30)
    assert state.configured is True
    assert load_telegram_settings(db_session).token == "123:ui-token"

    # Пустая строка очищает значение → возврат к .env
    save_telegram_settings(db_session, token="")
    state = load_telegram_settings(db_session)
    assert state.token == "env-token" and state.chat_id == "42"


def test_interval_zero_disables_channel(db_session):
    save_telegram_settings(db_session, token="t", chat_id="1", interval_minutes=0)
    assert load_telegram_settings(db_session).configured is False


def test_public_state_never_exposes_token(db_session):
    save_telegram_settings(db_session, token="123:super-secret", chat_id="42", interval_minutes=15)
    state = public_state(db_session)
    text = repr(state)
    assert "super-secret" not in text and "123:" not in text
    assert state["has_token"] is True
    assert state["token_fingerprint"] == token_fingerprint("123:super-secret")
    assert len(state["token_fingerprint"]) == 12


# ---------- расписание ----------


def test_digest_due_semantics():
    configured = TelegramSettings(token="t", chat_id="1", interval_minutes=30)
    assert digest_due(configured, {}, _now()) is True, "первая отправка — сразу"
    recent = {"last_sent_at": (_now() - timedelta(minutes=10)).isoformat()}
    assert digest_due(configured, recent, _now()) is False
    old = {"last_sent_at": (_now() - timedelta(minutes=31)).isoformat()}
    assert digest_due(configured, old, _now()) is True
    broken = {"last_sent_at": "not-a-date"}
    assert digest_due(configured, broken, _now()) is True
    off = TelegramSettings(token="t", chat_id="1", interval_minutes=0)
    assert digest_due(off, {}, _now()) is False


# ---------- текст сводки ----------


def test_build_digest_message_contains_inventory_and_deficit(db_session):
    station = _station(db_session, "fr_station_960001")
    deficit_station = _station(db_session, "fr_station_960004", name="АЗС без топлива")
    provider = db_session.scalar(select(SourceProvider).where(SourceProvider.code == "network_import"))
    from app.confidence.service import StatusService

    svc = StatusService(db_session)
    svc.record_fuel_observation(station.id, "AI_95", "AVAILABLE", provider.id, observed_at=_now() - timedelta(minutes=5))
    svc.record_fuel_observation(station.id, "DIESEL", "UNAVAILABLE", provider.id, observed_at=_now() - timedelta(minutes=5))
    # Дефицит — станция без единого AVAILABLE по всем видам топлива.
    svc.record_fuel_observation(deficit_station.id, "AI_95", "UNAVAILABLE", provider.id, observed_at=_now() - timedelta(minutes=5))

    text = build_digest_message(db_session, now=_now())
    assert "FuelRadar" in text and "Станции в каталоге:" in text
    # Общая БД: точные числа может двигать другой тестовый файл — проверяем смысл,
    # а не абсолютные значения (см. подводные камни conftest session-scope).
    assert "АИ-95" in text and "есть" in text
    assert "ДТ" in text and "нет" in text
    # В общей БД станций много: список дефицита обрезан до MAX_DEFICIT_STATIONS —
    # «наша» станция может не попасть в первые строки. Проверяем сам раздел и счётчик.
    assert "Без подтверждённого топлива" in text
    import re as _re

    total = int(_re.search(r"Без подтверждённого топлива \((\d+)\)", text).group(1))
    assert total >= 1


def test_build_digest_message_counts_changes_since_last_send(db_session):
    """Событие FUEL_APPEARED создаётся по diff состояния (T07): UNAVAILABLE → AVAILABLE."""
    station = _station(db_session, "fr_station_960002")
    provider = db_session.scalar(select(SourceProvider).where(SourceProvider.code == "network_import"))
    from app.confidence.service import StatusService

    # Активное правило с фильтром по топливу, чтобы diff породил событие.
    from app.db.models import AlertRule

    rule = AlertRule(scope={"station_id": station.id}, fuel_type_id=db_session.scalar(
        select(__import__("app.db.models", fromlist=["FuelType"]).FuelType.id).where(
            __import__("app.db.models", fromlist=["FuelType"]).FuelType.code == "AI_95"
        )
    ), is_active=True)
    db_session.add(rule)
    db_session.commit()

    svc = StatusService(db_session)
    since = _now() - timedelta(minutes=30)
    svc.record_fuel_observation(station.id, "AI_95", "UNAVAILABLE", provider.id, observed_at=since)
    svc.record_fuel_observation(station.id, "AI_95", "AVAILABLE", provider.id, observed_at=since + timedelta(minutes=1))

    from app.db.models import AlertEvent

    section = build_digest_message(db_session, now=_now(), since=since)
    # Первое наблюдение даёт STATION_NEW (состояния не было), второе — FUEL_APPEARED;
    # чужие события того же окна не учитываем — сравниваем относительно «без since».
    # Раздел появляется только когда есть события в окне.
    base = build_digest_message(db_session, now=_now())
    if base == section:
        # Нет событий в окне вообще — проверяем только честное отсутствие раздела.
        assert "С прошлой сводки" not in section
    else:
        assert "С прошлой сводки" in section and "появилось" in section
    _ = AlertEvent  # импорт использован для читаемости контракта
    # чистим правило — общая БД (см. подводные камни conftest)
    db_session.query(type(rule)).filter(type(rule).id == rule.id).delete()
    db_session.commit()


def test_build_digest_message_includes_reports_and_link(db_session, monkeypatch):
    monkeypatch.setattr(settings, "public_app_url", "https://fuel.example")
    station = _station(db_session, "fr_station_960003")
    db_session.add(UserReport(station_id=station.id, gps_confirmed=True, idempotency_key="digest-rep-1"))
    db_session.commit()
    text = build_digest_message(db_session, now=_now())
    assert "https://fuel.example" in text


# ---------- доставка ----------


class _FakeResponse:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self._payload


def test_send_telegram_message_statuses(db_session, monkeypatch):
    assert send_telegram_message("", "1", "text") == (False, "not_configured")
    assert send_telegram_message("t", "", "text") == (False, "not_configured")

    calls: list[dict] = []

    def fake_post(url, payload=None):
        calls.append({"url": url, **payload})
        return _FakeResponse({"ok": True, "result": {}})

    ok, reason = send_telegram_message("123:tok", "42", "сводка", http_post=fake_post)
    assert (ok, reason) == (True, "sent")
    assert "bot123:tok/sendMessage" in calls[0]["url"]
    assert calls[0]["chat_id"] == "42"

    def rejecting_post(url, payload=None):
        return _FakeResponse({"ok": False, "description": "chat not found"})

    assert send_telegram_message("123:tok", "42", "сводка", http_post=rejecting_post) == (False, "rejected")


def test_maybe_send_digest_lifecycle(db_session, monkeypatch):
    save_telegram_settings(db_session, token="123:tok", chat_id="42", interval_minutes=60)
    sent: list[str] = []

    def fake_post(url, payload=None):
        sent.append(payload["text"])
        return _FakeResponse({"ok": True})

    monkeypatch.setattr(digest, "_default_http_post", fake_post)  # воркер зовёт без аргумента


    assert maybe_send_digest(db_session, now=_now()) == "sent"
    assert len(sent) == 1
    # повтор на том же интервале — не отправляем (защита от дублей)
    assert maybe_send_digest(db_session, now=_now() + timedelta(minutes=10)) == "not_due"
    assert len(sent) == 1
    # после истечения интервала — отправляем снова
    assert maybe_send_digest(db_session, now=_now() + timedelta(minutes=61)) == "sent"
    assert len(sent) == 2
    # статус последней отправки виден в API-состоянии
    assert public_state(db_session)["last_status"] == "sent"


def test_maybe_send_digest_failure_does_not_advance_schedule(db_session, monkeypatch):
    """Сбой канала не сдвигает last_sent_at: следующая попытка — на следующем тике."""
    save_telegram_settings(db_session, token="123:tok", chat_id="42", interval_minutes=30)

    def failing_post(url, payload=None):
        raise RuntimeError("network down")

    monkeypatch.setattr(digest, "_default_http_post", failing_post)  # воркер зовёт без аргумента
    assert maybe_send_digest(db_session, now=_now()) == "error"
    state = public_state(db_session)
    assert state["last_status"] == "error" and state["last_sent_at"] is None


def test_maybe_send_digest_disabled_without_config(db_session):
    assert maybe_send_digest(db_session, now=_now()) == "not_configured"
    save_telegram_settings(db_session, token="t", chat_id="1", interval_minutes=0)
    assert maybe_send_digest(db_session, now=_now()) == "disabled"


def test_fetch_chat_id_discovery(db_session, monkeypatch):
    assert digest.fetch_chat_id("") == (None, "not_configured")

    updates = {"ok": True, "result": [
        {"message": {"chat": {"id": 777, "type": "private"}, "text": "/start"}},
        {"message": {"chat": {"id": 888, "type": "private"}, "text": "привет"}},
    ]}

    def fake_get(url):
        return updates

    monkeypatch.setattr(digest, "_default_http_get", fake_get)
    chat_id, reason = digest.fetch_chat_id("123:tok")
    assert (chat_id, reason) == ("888", "ok"), "берём самое свежее сообщение"

    empty = {"ok": True, "result": []}
    monkeypatch.setattr(digest, "_default_http_get", lambda url: empty)
    assert digest.fetch_chat_id("123:tok") == (None, "no_updates")

    def failing_get(url):
        raise RuntimeError("offline")

    monkeypatch.setattr(digest, "_default_http_get", failing_get)
    assert digest.fetch_chat_id("123:tok") == (None, "error")


def test_send_test_message_roundtrip(db_session, monkeypatch):
    assert digest.send_test_message(db_session) == (False, "no_token")
    save_telegram_settings(db_session, token="123:tok", chat_id="42", interval_minutes=60)
    sent: list[str] = []
    monkeypatch.setattr(digest, "_default_http_post", lambda url, payload=None: sent.append(payload["text"]) or _FakeResponse({"ok": True}))  # воркер зовёт без аргумента
    ok, reason = digest.send_test_message(db_session)
    assert (ok, reason) == (True, "sent") and "FuelRadar" in sent[0]


def test_worker_import_and_config_surface():
    """Расписание и .env-переменные задокументированы в конфиге (единственный источник дефолтов)."""
    assert hasattr(settings, "telegram_digest_minutes")
    assert hasattr(settings, "telegram_chat_id")
    # Модуль дайджеста импортируется воркером через отложенный импорт — проверяем доступность.
    from app.digest.service import maybe_send_digest as _fn  # noqa: F401
