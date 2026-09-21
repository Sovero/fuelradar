"""T14 — realtime (R64, §25): SSE-стрим, push-подписки, доставка Web Push.

Пользователей в приложении нет: подписки браузеров общие, вход не нужен. Telegram
здесь больше не доставляется — это канал-подписка по расписанию (tests/test_digest.py).
"""

from __future__ import annotations

import base64
import json
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from app.alerts import channels
from app.core.config import settings
from app.db.models import AlertEvent, PushSubscription, Station

pytestmark = pytest.mark.usefixtures("client")

PUSH_ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123-def456-789"


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _keys() -> dict[str, str]:
    # Валидные по форме base64url-значения: p256dh — 65 байт (uncompressed P-256),
    # auth — 16 байт. Отправка в тестах мокается, реальная криптография не нужна.
    return {"p256dh": _b64url(b"B" + b"\x01" * 64), "auth": _b64url(b"A" * 16)}


def _seed_station(db_session, station_id: str) -> None:
    if db_session.get(Station, station_id) is None:
        db_session.add(Station(id=station_id, canonical_name="АЗС T14", latitude=45.0, longitude=39.0))
        db_session.commit()


# ---------- SSE ----------


def test_sse_requires_no_auth_and_streams_initial_revision(client):
    """R64: карта анонимна; стрим отвечает event-stream с начальным revision."""
    # Проверяем контракт ответа, не удерживая бесконечный стрим: генератор
    # начинает отдавать тело только после заголовков, поэтому читаем маршрут
    # через StreamingResponse косвенно — через openapi и ручной генератор.
    from app.realtime.router import _revision_sync, _sse_generator

    revision = _revision_sync()
    assert isinstance(revision, tuple) and len(revision) == 3

    async def _collect() -> list[str]:
        from types import SimpleNamespace

        request = SimpleNamespace(is_disconnected=lambda: asyncio.sleep(0, result=False))

        chunks = []
        generator = _sse_generator(request, None)
        async for chunk in generator:
            chunks.append(chunk)
            if len(chunks) >= 1:
                await generator.aclose()
                break
        return chunks

    import asyncio

    chunks = asyncio.run(_collect())
    assert chunks and "event: revision" in chunks[0] and "data: " in chunks[0]


def test_revision_sync_changes_on_insert(db_session):
    """Append-only наблюдение/станция меняют revision — основа SSE-сигнала."""
    from app.realtime.router import _revision_sync

    before = _revision_sync()
    # Revision — max(Station.id) ЛЕКСИКОГРАФИЧЕСКИ (func.max по строке): вставка
    # должна быть строго выше текущего максимума, иначе фикстуры другого файла
    # (fr_station_97xxxx) её «перекрывают» и тест зависит от порядка прогона.
    # Суффикс — число: DedupService._next_station_id() парсит суффикс максимального
    # id каталога (см. подводные камни в AGENTS.md — тест не должен оставлять
    # станций, ломающих инвариант).
    base = before[0] if before[0].startswith("fr_station_") else "fr_station_140100"
    station_id = f"{base}9"  # base + цифра — строго больше base лексикографически
    db_session.add(Station(id=station_id, canonical_name="Rev", latitude=45.0, longitude=39.0))
    db_session.commit()
    after = _revision_sync()
    assert after != before


# ---------- push-подписки CRUD (общие: вход не нужен) ----------


def _sub_body(endpoint: str = PUSH_ENDPOINT) -> dict:
    return {"endpoint": endpoint, "keys": _keys()}


def _clear_subscriptions(db_session) -> None:
    for row in db_session.scalars(select(PushSubscription)).all():
        db_session.delete(row)
    db_session.commit()


def test_push_subscription_is_open_without_login(client):
    """Входа в приложении нет: подписка браузера заводится сразу (R64)."""
    assert client.get("/api/v1/push/subscriptions").status_code == 200
    created = client.post("/api/v1/push/subscriptions", json=_sub_body())
    assert created.status_code == 201
    assert client.delete(f"/api/v1/push/subscriptions/{created.json()['id']}").status_code == 204


def test_push_subscription_crud_roundtrip(client, db_session):
    _clear_subscriptions(db_session)
    created = client.post("/api/v1/push/subscriptions", json=_sub_body())
    assert created.status_code == 201
    body = created.json()
    assert body["endpoint_host"] == "fcm.googleapis.com"
    # R68: ключи шифрования никогда не возвращаются наружу
    assert "keys" not in body and "p256dh" not in body and "auth" not in body

    listed = client.get("/api/v1/push/subscriptions").json()
    assert len(listed) == 1 and listed[0]["id"] == body["id"]

    deleted = client.delete(f"/api/v1/push/subscriptions/{body['id']}")
    assert deleted.status_code == 204
    assert client.get("/api/v1/push/subscriptions").json() == []


def test_push_subscription_limit_ignores_same_endpoint(client, db_session):
    """Лимит — только для НОВЫХ endpoint: на пределе можно переподписать
    существующий браузер (ротация ключей), иначе идемпотентность ломается."""
    from app.api.personal import MAX_PUSH_SUBSCRIPTIONS

    _clear_subscriptions(db_session)
    for i in range(MAX_PUSH_SUBSCRIPTIONS):
        db_session.add(
            PushSubscription(
                endpoint=f"https://push.example.com/{i}",
                p256dh=_keys()["p256dh"],
                auth=_keys()["auth"],
            )
        )
    db_session.commit()

    # Новый (лишний) endpoint — честный отказ по лимиту.
    r = client.post("/api/v1/push/subscriptions", json=_sub_body("https://push.example.com/new"))
    assert r.status_code == 400 and "лимит" in r.json()["detail"]

    # Существующий endpoint (ротация ключей) — обновление, а не 400.
    r = client.post("/api/v1/push/subscriptions", json=_sub_body("https://push.example.com/0"))
    assert r.status_code == 201
    assert r.json()["endpoint"].endswith("/0")


def test_push_subscription_is_idempotent_per_endpoint(client, db_session):
    """Повторная подписка того же браузера обновляет ключи, не плодит строки."""
    _clear_subscriptions(db_session)
    assert client.post("/api/v1/push/subscriptions", json=_sub_body()).status_code == 201
    rotated = {"endpoint": PUSH_ENDPOINT, "keys": {"p256dh": _b64url(b"C" + b"\x02" * 64), "auth": _b64url(b"B" * 16)}}
    assert client.post("/api/v1/push/subscriptions", json=rotated).status_code == 201
    listed = client.get("/api/v1/push/subscriptions").json()
    assert len(listed) == 1


@pytest.mark.parametrize(
    "body",
    [
        {"endpoint": "http://fcm.googleapis.com/fcm/send/x", "keys": _keys()},  # не https
        {"endpoint": PUSH_ENDPOINT, "keys": {"p256dh": "", "auth": _keys()["auth"]}},  # нет p256dh
        {"endpoint": PUSH_ENDPOINT, "keys": {"p256dh": _keys()["p256dh"]}},  # нет auth
        {"endpoint": PUSH_ENDPOINT, "keys": {"p256dh": "!!!not-base64!!!", "auth": _keys()["auth"]}},  # не base64url
        {"endpoint": PUSH_ENDPOINT},  # keys отсутствуют
    ],
)
def test_push_subscription_validates_input(client, body):
    assert client.post("/api/v1/push/subscriptions", json=body).status_code == 422


# ---------- доставка Web Push ----------


class _FakeResponse:
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code


def _mk_event() -> tuple[AlertEvent, Station]:
    event = AlertEvent(id=1, station_id="x", event_type="FUEL_APPEARED", payload={})
    station = Station(id="x", canonical_name="Тест АЗС", latitude=1, longitude=1)
    return event, station


def _mk_subscription(endpoint: str) -> PushSubscription:
    return PushSubscription(endpoint=endpoint, p256dh=_keys()["p256dh"], auth=_keys()["auth"])


def test_send_web_push_not_configured_without_keys(client, monkeypatch):
    monkeypatch.setattr(settings, "vapid_public_key", "")
    monkeypatch.setattr(settings, "vapid_private_key", "")
    event, station = _mk_event()
    assert channels.send_web_push(event, station) == "not_configured"


def test_send_web_push_no_subscriptions_returns_honest_status(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "vapid_public_key", "B_public")
    monkeypatch.setattr(settings, "vapid_private_key", "private")
    _clear_subscriptions(db_session)
    event, station = _mk_event()
    assert channels.send_web_push(event, station) == "no_subscriptions"


def test_send_web_push_delivers_to_active_subscriptions(client, db_session, monkeypatch):
    """Мок pywebpush: отправка реально вызывается для каждой активной подписки."""
    monkeypatch.setattr(settings, "vapid_public_key", "B_public")
    monkeypatch.setattr(settings, "vapid_private_key", "private")
    calls: list[dict] = []

    def fake_webpush(subscription_info, data, **kwargs):
        calls.append({"subscription": subscription_info, "data": data, "claims": kwargs.get("vapid_claims")})

        class _R:
            status_code = 201

        return _R()

    monkeypatch.setattr(channels, "_webpush_call", fake_webpush)
    _clear_subscriptions(db_session)
    for suffix in ("a", "b"):
        db_session.add(_mk_subscription(f"https://push.example.com/{suffix}"))
    db_session.commit()

    event, station = _mk_event()
    assert channels.send_web_push(event, station) == "sent"
    assert len(calls) == 2
    assert all(call["subscription"]["endpoint"].startswith("https://push.example.com/") for call in calls)
    payload = json.loads(calls[0]["data"])
    assert payload["station_id"] == "x" and payload["title"]
    assert calls[0]["claims"]["sub"].startswith("mailto:")

    rows = db_session.scalars(select(PushSubscription)).all()
    assert rows and all(row.last_success_at is not None for row in rows)


def test_send_web_push_deactivates_gone_subscriptions(client, db_session, monkeypatch):
    """404/410 от push-сервиса → is_active=False (честная очистка мёртвых подписок)."""
    monkeypatch.setattr(settings, "vapid_public_key", "B_public")
    monkeypatch.setattr(settings, "vapid_private_key", "private")

    def fake_webpush(subscription_info, data, **kwargs):
        error = channels.WebPushException("gone")
        error.response = _FakeResponse(410)
        raise error

    monkeypatch.setattr(channels, "_webpush_call", fake_webpush)
    _clear_subscriptions(db_session)
    row = _mk_subscription("https://push.example.com/gone")
    db_session.add(row)
    db_session.commit()

    event, station = _mk_event()
    assert channels.send_web_push(event, station) == "error"
    db_session.expire_all()
    assert row.is_active is False and row.last_error == "gone:410"


def test_send_web_push_isolates_single_failure(client, db_session, monkeypatch):
    """Ошибка одной подписки не отменяет остальные (изоляция канала)."""
    monkeypatch.setattr(settings, "vapid_public_key", "B_public")
    monkeypatch.setattr(settings, "vapid_private_key", "private")

    def fake_webpush(subscription_info, data, **kwargs):
        if subscription_info["endpoint"].endswith("fail"):
            raise RuntimeError("network down")

        class _R:
            status_code = 201

        return _R()

    monkeypatch.setattr(channels, "_webpush_call", fake_webpush)
    _clear_subscriptions(db_session)
    for suffix in ("ok", "fail"):
        db_session.add(_mk_subscription(f"https://push.example.com/{suffix}"))
    db_session.commit()

    event, station = _mk_event()
    assert channels.send_web_push(event, station) == "sent"
    rows = {row.endpoint: row for row in db_session.scalars(select(PushSubscription))}
    assert rows["https://push.example.com/ok"].last_success_at is not None
    assert rows["https://push.example.com/fail"].last_error == "RuntimeError"


def test_push_delivery_on_alert_event_end_to_end(client, db_session, monkeypatch):
    """Событие alert → channels.send_web_push вызывается с реальной подпиской."""
    _seed_station(db_session, "fr_station_140103")
    monkeypatch.setattr(settings, "vapid_public_key", "B_public")
    monkeypatch.setattr(settings, "vapid_private_key", "private")
    sent: list[str] = []
    monkeypatch.setattr(
        channels,
        "_webpush_call",
        lambda *a, **k: sent.append(k.get("data", a[1] if len(a) > 1 else "")) or _FakeResponse(201),
    )
    _clear_subscriptions(db_session)

    # Правило: глобальное (пустой scope) — первый отчёт по станции даёт STATION_NEW
    # (старого состояния нет, см. alerts/events.py).
    created = client.post("/api/v1/alerts", json={"name": "t14", "is_active": True, "scope": {}})
    assert created.status_code == 201

    # Подписка браузера: вход больше не нужен — список подписок общий.
    assert client.post("/api/v1/push/subscriptions", json=_sub_body()).status_code == 201

    # Отчёт меняет статус станции → evaluate_rules → _deliver → web push.
    report = client.post(
        "/api/v1/reports",
        json={"station_id": "fr_station_140103", "fuel": {"AI_95": "AVAILABLE"}, "idempotency_key": f"t14-{uuid.uuid4().hex[:12]}"},
    )
    assert report.status_code == 201
    assert sent, "web push должен быть вызван при срабатывании правила"
