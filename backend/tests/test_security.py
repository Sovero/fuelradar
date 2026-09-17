"""Security hardening for the admin API: RBAC, throttling, and failed-auth auditing."""

from __future__ import annotations

import logging

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.auth import (
    BootstrapUnavailable,
    bootstrap_available,
    create_bootstrap_admin,
    verify_password,
)
from app.core.config import settings
from app.db.base import Base
from app.db.models import AdminActionLog

ADMIN_EMAIL = "test-admin@example.com"
ADMIN_PASSWORD = "test-admin-password-123"


def _audit_rows(db_session, after_id: int) -> list[AdminActionLog]:
    db_session.expire_all()
    return list(
        db_session.scalars(
            select(AdminActionLog)
            .where(AdminActionLog.id > after_id, AdminActionLog.action == "admin_auth_failed")
            .order_by(AdminActionLog.id)
        )
    )


def test_failed_admin_auth_is_audited_without_recording_token(client, db_session, caplog):
    """Missing and legacy credentials leave safe audit events, not secrets."""
    from app.api import deps

    caplog.set_level(logging.WARNING, logger="fuelradar.security")

    original_limit = settings.admin_rate_limit_per_minute
    try:
        deps.reset_rate_limit()
        settings.admin_rate_limit_per_minute = 100
        client.post("/api/v1/auth/logout")
        before = db_session.scalar(select(AdminActionLog.id).order_by(AdminActionLog.id.desc())) or 0

        missing = client.get("/api/v1/admin/sources")
        legacy = client.get("/api/v1/admin/sources", headers={"X-Admin-Token": "definitely-not-the-token"})

        assert missing.status_code == 401
        assert legacy.status_code == 401
        rows = _audit_rows(db_session, before)
        assert [row.payload["reason"] for row in rows] == ["missing_session", "legacy_header_ignored"]
        assert all(row.payload["path"] == "/api/v1/admin/sources" for row in rows)
        assert all("definitely-not-the-token" not in repr(row.payload) for row in rows)
        assert "Failed admin authentication" in caplog.text
        assert "definitely-not-the-token" not in caplog.text
    finally:
        settings.admin_rate_limit_per_minute = original_limit
        deps.reset_rate_limit()


def test_password_login_and_bootstrap_status(client):
    client.post("/api/v1/auth/logout")
    assert client.get("/api/v1/auth/bootstrap").json() == {"required": False}

    wrong = client.post(
        "/api/v1/auth/login",
        json={"email": ADMIN_EMAIL, "password": "wrong-password"},
    )
    assert wrong.status_code == 401
    assert client.post(
        "/api/v1/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
    ).status_code == 200
    assert client.get("/api/v1/auth/me").json()["user"]["role"] == "ADMIN"
    client.post("/api/v1/auth/logout")


def test_bootstrap_service_is_one_time_and_password_is_hashed(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'bootstrap.db'}")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        assert bootstrap_available(session)
        user = create_bootstrap_admin(
            session,
            display_name="First Admin",
            email="first-admin@example.com",
            password="first-admin-password-123",
        )
        assert user.role == "ADMIN"
        assert user.password_hash is not None
        assert user.password_hash != "first-admin-password-123"
        assert verify_password("first-admin-password-123", user.password_hash)
        assert not verify_password("wrong-password", user.password_hash)
        assert not bootstrap_available(session)

        with pytest.raises(BootstrapUnavailable):
            create_bootstrap_admin(
                session,
                display_name="Second Admin",
                email="second-admin@example.com",
                password="second-admin-password-123",
            )
    engine.dispose()


def test_bootstrap_http_endpoint_sets_admin_cookie_and_closes(tmp_path):
    """The public bootstrap contract creates one admin and cannot be replayed."""
    from fastapi import Depends, FastAPI
    from fastapi.testclient import TestClient

    from app.api.deps import rate_limit
    from app.api.login import router as login_router
    from app.db.session import get_db

    engine = create_engine(f"sqlite:///{tmp_path / 'bootstrap-http.db'}")
    Base.metadata.create_all(engine)
    test_app = FastAPI()
    test_app.include_router(login_router, prefix="/api/v1", dependencies=[Depends(rate_limit)])

    def override_db():
        with Session(engine) as session:
            yield session

    test_app.dependency_overrides[get_db] = override_db
    password = "first-admin-password-123"
    with TestClient(test_app) as local_client:
        assert local_client.get("/api/v1/auth/bootstrap").json() == {"required": True}
        created = local_client.post(
            "/api/v1/auth/bootstrap",
            json={
                "display_name": "First Admin",
                "email": "first-admin@example.com",
                "password": password,
                "password_confirm": password,
            },
        )
        assert created.status_code == 201
        assert created.json()["user"]["role"] == "ADMIN"
        assert "fr_session" in local_client.cookies
        assert local_client.get("/api/v1/auth/bootstrap").json() == {"required": False}

        replay = local_client.post(
            "/api/v1/auth/bootstrap",
            json={
                "display_name": "Second Admin",
                "email": "second-admin@example.com",
                "password": "second-admin-password-123",
                "password_confirm": "second-admin-password-123",
            },
        )
        assert replay.status_code == 409

        local_client.post("/api/v1/auth/logout")
        login = local_client.post(
            "/api/v1/auth/login",
            json={"email": "first-admin@example.com", "password": password},
        )
        assert login.status_code == 200
        assert local_client.get("/api/v1/auth/me").json()["user"]["role"] == "ADMIN"

    with Session(engine) as session:
        audit = session.scalar(select(AdminActionLog).where(AdminActionLog.action == "bootstrap_admin_created"))
        assert audit is not None
        assert password not in repr(audit.payload)
    engine.dispose()


def test_dev_login_cannot_impersonate_privileged_account(client):
    client.post("/api/v1/auth/logout")
    response = client.post("/api/v1/auth/dev-login", json={"email": ADMIN_EMAIL})
    assert response.status_code == 403
    assert client.get("/api/v1/auth/me").json()["user"] is None


def test_operator_can_read_admin_views_but_cannot_mutate(client, db_session):
    from app.auth import hash_password
    from app.db.models import User

    operator = db_session.scalar(select(User).where(User.email == "operator-security@example.com"))
    if operator is None:
        operator = User(
            email="operator-security@example.com",
            role="OPERATOR",
            password_hash=hash_password("operator-password-123"),
        )
        db_session.add(operator)
        db_session.commit()

    client.post("/api/v1/auth/logout")
    assert client.post(
        "/api/v1/auth/login",
        json={"email": operator.email, "password": "operator-password-123"},
    ).status_code == 200
    assert client.get("/api/v1/admin/sources").status_code == 200
    assert client.post(f"/api/v1/admin/users/{operator.id}/block").status_code == 403
    client.post("/api/v1/auth/logout")


def test_admin_rate_limit_covers_get_and_failed_attempts(client):
    """The strict admin bucket applies to GETs and returns Retry-After."""
    from app.api import deps

    original_limit = settings.admin_rate_limit_per_minute
    try:
        deps.reset_rate_limit()
        settings.admin_rate_limit_per_minute = 2
        client.post("/api/v1/auth/logout")
        assert client.get("/api/v1/admin/sources").status_code == 401
        assert client.get("/api/v1/admin/sources", headers={"X-Admin-Token": "wrong"}).status_code == 401

        limited = client.get("/api/v1/admin/sources")
        assert limited.status_code == 429
        assert limited.headers["Retry-After"].isdigit()
        assert "админ-API" in limited.json()["detail"]
    finally:
        settings.admin_rate_limit_per_minute = original_limit
        deps.reset_rate_limit()
