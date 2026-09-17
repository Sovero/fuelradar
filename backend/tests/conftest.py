"""Тест-харнесс: отдельная временная SQLite-БД на каждый прогон."""

from __future__ import annotations

import os
import tempfile

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

# БД для тестов — до импорта приложения.
_tmpdir = tempfile.mkdtemp(prefix="fuelradar_test_")
os.environ["DATABASE_URL"] = f"sqlite:///{os.path.join(_tmpdir, 'test.db')}"
os.environ["DEBUG"] = "true"
# Герметичность: реальный .env разработчика (setup.ps1, docker и т.п.) не должен
# влиять на тесты — иначе один прогон даёт разный результат на разных машинах
# (см. app/core/config.py::_ROOT_ENV_FILE). Всё нужное тестам — только явные
# os.environ ниже, дефолты Settings — для того, что не выставлено явно.
os.environ["FUELRADAR_NO_ENV_FILE"] = "1"
# API-тесты: щедрые лимиты и живой кэш.
os.environ.setdefault("RATE_LIMIT_PER_MINUTE", "10000")
os.environ.setdefault("ADMIN_RATE_LIMIT_PER_MINUTE", "10000")
os.environ.setdefault("API_CACHE_TTL_SECONDS", "60")

TEST_ADMIN_EMAIL = "test-admin@example.com"
TEST_ADMIN_PASSWORD = "test-admin-password-123"


@pytest.fixture(scope="session")
def client():
    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def db_session():
    from app.auth import hash_password
    from app.db.models import BootstrapState, User
    from app.db.session import SessionLocal, init_db

    init_db()
    with SessionLocal() as s:
        if s.scalar(select(User.id).where(User.role == "ADMIN").limit(1)) is None:
            s.add(
                User(
                    display_name="Test Administrator",
                    email=TEST_ADMIN_EMAIL,
                    role="ADMIN",
                    password_hash=hash_password(TEST_ADMIN_PASSWORD),
                )
            )
            s.flush()
        state = s.get(BootstrapState, 1)
        if state is not None and not state.completed:
            state.completed = True
        s.commit()
        yield s


def login_as_admin(client: TestClient) -> None:
    """Authenticate the shared API client through the real cookie-login flow."""
    response = client.post(
        "/api/v1/auth/login",
        json={"email": TEST_ADMIN_EMAIL, "password": TEST_ADMIN_PASSWORD},
    )
    assert response.status_code == 200, response.text
