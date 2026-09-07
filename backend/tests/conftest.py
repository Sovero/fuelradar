"""Тест-харнесс: отдельная временная SQLite-БД на каждый прогон."""

from __future__ import annotations

import os
import tempfile

import pytest
from fastapi.testclient import TestClient

# БД для тестов — до импорта приложения.
_tmpdir = tempfile.mkdtemp(prefix="fuelradar_test_")
os.environ["DATABASE_URL"] = f"sqlite:///{os.path.join(_tmpdir, 'test.db')}"


@pytest.fixture(scope="session")
def client():
    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def db_session():
    from app.db.session import SessionLocal

    with SessionLocal() as s:
        yield s