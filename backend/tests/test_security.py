"""Защита открытого приложения: per-IP лимиты, проверка Origin и журнал действий.

RBAC и входа в приложении больше нет (пользователей нет) — приложение показывает
всё тому, кто его запустил. Оставшаяся защита: лимиты (общий и строгий для
admin-API), origin-проверка на изменяющие запросы (анти-CSRF для браузера) и
журнал действий, где каждая правка видна с актором и полезной нагрузкой.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from app.core.config import settings
from app.db.models import AdminActionLog, SourceProvider


def _audit_rows(db_session, after_id: int, action: str | None = None) -> list[AdminActionLog]:
    db_session.expire_all()
    query = select(AdminActionLog).where(AdminActionLog.id > after_id)
    if action is not None:
        query = query.where(AdminActionLog.action == action)
    return list(db_session.scalars(query.order_by(AdminActionLog.id)))


def _last_audit_id(db_session) -> int:
    return db_session.scalar(select(AdminActionLog.id).order_by(AdminActionLog.id.desc())) or 0


def test_admin_api_is_open_for_the_local_operator(client):
    """Входа нет: админские чтения доступны сразу, без токенов и cookie."""
    response = client.get("/api/v1/admin/sources")
    assert response.status_code == 200


def test_legacy_admin_token_header_is_ignored(client, db_session):
    """Статический X-Admin-Token больше не существует — он не даёт никаких прав."""
    before = _last_audit_id(db_session)
    with_header = client.get("/api/v1/admin/sources", headers={"X-Admin-Token": "definitely-not-the-token"})
    without_header = client.get("/api/v1/admin/sources")
    assert with_header.status_code == without_header.status_code == 200
    assert with_header.json() == without_header.json()
    assert _audit_rows(db_session, before) == [], "лишнего аудита на успешные чтения нет"


def test_admin_mutation_is_audited_with_actor_and_payload(client, db_session):
    """R67: правка источника журналируется — кто (локальный оператор), что и когда."""
    provider = SourceProvider(code="t_security_src", name="Security", status="ACTIVE", trust=0.5)
    db_session.add(provider)
    db_session.commit()
    before = _last_audit_id(db_session)
    try:
        updated = client.patch(f"/api/v1/admin/sources/{provider.id}", json={"trust": 0.9})
        assert updated.status_code == 200

        rows = _audit_rows(db_session, before)
        assert rows and rows[-1].action == "source_update"
        assert rows[-1].actor == "local"
        assert rows[-1].target_id == "t_security_src"
        assert rows[-1].payload["trust"] == {"from": 0.5, "to": 0.9}
    finally:
        db_session.query(AdminActionLog).filter(AdminActionLog.id > before).delete()
        db_session.delete(provider)
        db_session.commit()


def test_cross_origin_mutation_is_rejected(client):
    """Анти-CSRF: браузер с чужого origin не может менять данные приложения."""
    response = client.post("/api/v1/reports", json={}, headers={"Origin": "https://evil.example"})
    assert response.status_code == 403
    assert response.json()["detail"] == "Недопустимый источник запроса"


def test_general_rate_limit_returns_429(client):
    from app.api import deps

    original = settings.rate_limit_per_minute
    try:
        deps.reset_rate_limit()
        settings.rate_limit_per_minute = 3
        codes = [client.get("/api/v1/meta").status_code for _ in range(5)]
        assert codes[:3] == [200, 200, 200]
        assert 429 in codes[3:]
    finally:
        settings.rate_limit_per_minute = original
        deps.reset_rate_limit()


def test_admin_rate_limit_covers_get_and_mutation(client):
    """Админ-API лимитируется строже общего — и на чтения тоже (операции тяжёлые)."""
    from app.api import deps

    original_admin = settings.admin_rate_limit_per_minute
    original_general = settings.rate_limit_per_minute
    try:
        deps.reset_rate_limit()
        settings.rate_limit_per_minute = 10_000
        settings.admin_rate_limit_per_minute = 3
        codes = [client.get("/api/v1/admin/sources").status_code for _ in range(5)]
        assert codes[:3] == [200, 200, 200]
        assert 429 in codes[3:]
        assert client.patch("/api/v1/admin/sources/1", json={"trust": 0.5}).status_code == 429
    finally:
        settings.admin_rate_limit_per_minute = original_admin
        settings.rate_limit_per_minute = original_general
        deps.reset_rate_limit()


def test_admin_rate_limit_can_be_disabled(client):
    from app.api import deps

    original = settings.admin_rate_limit_per_minute
    try:
        deps.reset_rate_limit()
        settings.admin_rate_limit_per_minute = 0
        assert [client.get("/api/v1/admin/sources").status_code for _ in range(5)] == [200] * 5
    finally:
        settings.admin_rate_limit_per_minute = original
        deps.reset_rate_limit()


def test_admin_action_log_endpoint_exposes_filters(client, db_session):
    """Журнал читается через API и фильтруется по действию/дате (интерфейс админки)."""
    page = client.get("/api/v1/admin/action-log", params={"limit": 5})
    assert page.status_code == 200
    body = page.json()
    assert "items" in body and "total" in body
    assert client.get("/api/v1/admin/action-log", params={"date_from": "not-a-date"}).status_code == 422


@pytest.mark.parametrize("path", ["/api/v1/admin/sources", "/api/v1/admin/action-log", "/api/v1/admin/dedup-queue"])
def test_admin_read_endpoints_do_not_leak_secrets(client, path, monkeypatch):
    """R68: секреты из конфигурации не попадают в ответы админ-API."""
    monkeypatch.setattr(settings, "telegram_bot_token", "123456:secret-token-value")
    monkeypatch.setattr(settings, "vapid_private_key", "secret-vapid-private")
    text = client.get(path).text
    assert "secret-token-value" not in text
    assert "secret-vapid-private" not in text
