"""Тест-харнесс: отдельная временная SQLite-БД на каждый прогон.

Входа и ролей в приложении нет — API открыт целиком, поэтому харнессу нужны
только клиент и сессия к БД.
"""

from __future__ import annotations

import atexit
import os
import shutil
import tempfile

import pytest
from fastapi.testclient import TestClient

# БД для тестов — до импорта приложения.
_tmpdir = tempfile.mkdtemp(prefix="fuelradar_test_")
# Фолбэк на случай, если тир-даун фикстуры не успел (прерванный прогон): на
# Windows каталог может быть ещё занят драйвером — тогда это просто no-op.
atexit.register(shutil.rmtree, _tmpdir, ignore_errors=True)

# Каталоги прогонов не должны копиться в системном temp (за месяцы набралось
# несколько сотен папок с базами): фикстура ниже закрывает пул соединений и
# удаляет каталог за собой — именно в таком порядке, иначе Windows не отдаёт файл.


@pytest.fixture(scope="session", autouse=True)
def _temp_storage():
    yield
    from app.db import session as db_module

    db_module.SessionLocal.kw["bind"].dispose()
    shutil.rmtree(_tmpdir, ignore_errors=True)
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

@pytest.fixture(scope="session")
def client():
    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def db_session():
    from app.db.session import SessionLocal, init_db

    init_db()
    # Пользователей в приложении нет: сессия к БД — это весь тест-харнесс.
    with SessionLocal() as s:
        yield s
