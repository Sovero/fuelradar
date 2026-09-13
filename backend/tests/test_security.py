"""Security hardening for the admin API: throttling and failed-auth auditing."""

from __future__ import annotations

import logging

from sqlalchemy import select

from app.core.config import settings
from app.db.models import AdminActionLog

ADMIN = {"X-Admin-Token": "test-admin-token"}


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
    """Missing and invalid credentials leave safe audit events, not secrets."""
    from app.api import deps

    caplog.set_level(logging.WARNING, logger="fuelradar.security")

    original_limit = settings.admin_rate_limit_per_minute
    try:
        deps.reset_rate_limit()
        settings.admin_rate_limit_per_minute = 100
        before = db_session.scalar(select(AdminActionLog.id).order_by(AdminActionLog.id.desc())) or 0

        missing = client.get("/api/v1/admin/sources")
        invalid = client.get("/api/v1/admin/sources", headers={"X-Admin-Token": "definitely-not-the-token"})

        assert missing.status_code == 401
        assert invalid.status_code == 403
        rows = _audit_rows(db_session, before)
        assert [row.payload["reason"] for row in rows] == ["missing_token", "invalid_token"]
        assert all(row.payload["path"] == "/api/v1/admin/sources" for row in rows)
        assert all("definitely-not-the-token" not in repr(row.payload) for row in rows)
        assert "Failed admin authentication" in caplog.text
        assert "definitely-not-the-token" not in caplog.text
    finally:
        settings.admin_rate_limit_per_minute = original_limit
        deps.reset_rate_limit()


def test_admin_rate_limit_covers_get_and_failed_attempts(client):
    """The strict admin bucket applies to GETs and returns Retry-After."""
    from app.api import deps

    original_limit = settings.admin_rate_limit_per_minute
    try:
        deps.reset_rate_limit()
        settings.admin_rate_limit_per_minute = 2
        assert client.get("/api/v1/admin/sources").status_code == 401
        assert client.get("/api/v1/admin/sources", headers={"X-Admin-Token": "wrong"}).status_code == 403

        limited = client.get("/api/v1/admin/sources", headers=ADMIN)
        assert limited.status_code == 429
        assert limited.headers["Retry-After"].isdigit()
        assert "админ-API" in limited.json()["detail"]
    finally:
        settings.admin_rate_limit_per_minute = original_limit
        deps.reset_rate_limit()
