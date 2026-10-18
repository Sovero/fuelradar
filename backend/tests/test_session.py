"""Тесты подключения к БД (app/db/session.py) — то, что зависит не от данных.

Проверяется выбор аргументов соединения по схеме адреса: SQLite должен работать
из нескольких потоков (SSE, фоновый тикер сбора), у Postgres должен быть таймаут
установления соединения — иначе недоступная база вешает старт приложения.
"""

from __future__ import annotations

from app.db.session import connect_args


def test_sqlite_connections_are_usable_from_several_threads() -> None:
    assert connect_args("sqlite:///./fuelradar.db", connect_timeout=10) == {"check_same_thread": False}
    assert connect_args("sqlite+pysqlite:///:memory:", connect_timeout=10) == {"check_same_thread": False}


def test_postgres_gets_a_connect_timeout() -> None:
    for url in ("postgresql://u:p@db/fuelradar", "postgresql+psycopg://u:p@db/fuelradar"):
        assert connect_args(url, connect_timeout=7) == {"connect_timeout": 7}


def test_unknown_driver_gets_no_arguments() -> None:
    # Тестовые/сторонние драйверы не должны получать чужие аргументы: SQLAlchemy
    # передаёт их как есть в DBAPI и падает, если тот их не понимает.
    assert connect_args("duckdb:///tmp/x.db", connect_timeout=10) == {}
