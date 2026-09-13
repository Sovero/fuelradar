"""Тест-харнесс: отдельная временная SQLite-БД на каждый прогон."""

from __future__ import annotations

import os
import tempfile

import pytest
from fastapi.testclient import TestClient

# БД для тестов — до импорта приложения.
_tmpdir = tempfile.mkdtemp(prefix="fuelradar_test_")
os.environ["DATABASE_URL"] = f"sqlite:///{os.path.join(_tmpdir, 'test.db')}"
os.environ["DEBUG"] = "true"
# Герметичность: реальный .env разработчика (setup.ps1, docker и т.п.) не должен
# влиять на тесты — иначе один прогон даёт разный результат на разных машинах
# (см. app/core/config.py::_ROOT_ENV_FILE). Всё нужное тестам — только явные
# os.environ ниже, дефолты Settings — для того, что не выставлено явно.
os.environ["FUELRADAR_NO_ENV_FILE"] = "1"
# API-тесты: фиксированный админ-токен, щедрые лимиты и живой кэш.
os.environ.setdefault("ADMIN_TOKEN", "test-admin-token")
os.environ.setdefault("RATE_LIMIT_PER_MINUTE", "10000")
os.environ.setdefault("ADMIN_RATE_LIMIT_PER_MINUTE", "10000")
os.environ.setdefault("API_CACHE_TTL_SECONDS", "60")


@pytest.fixture(scope="session")
def client():
    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def db_session():
    from app.db.session import SessionLocal, init_db

    init_db()
    with SessionLocal() as s:
        yield s