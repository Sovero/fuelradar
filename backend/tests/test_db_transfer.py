"""Тесты экспорта/бэкапа локальной базы и переноса данных во внешнюю (db/transfer.py).

Настоящий Postgres в прогоне не поднимается — и не нужен: проверяются чистые
функции (пути, предпроверки, маска адреса, JSON-строка) и сам механизм копирования
на паре SQLite-баз. Диалектная вставка «пропустить конфликт» для SQLite и Postgres
общая по смыслу (`ON CONFLICT DO NOTHING`), поэтому перенос и его идемпотентность
здесь проверяются честно, без выдуманного «против Postgres тоже сработает».
"""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy.exc import IntegrityError

from app.db.base import Base
from app.db.models import FuelType, Station, StationBrand
from app.db.transfer import (
    BACKUP_DIRNAME,
    DB_FILENAME,
    backup_dir,
    backup_sqlite,
    copy_database,
    default_backup_path,
    discard_snapshot,
    insert_rows_ignoring_conflicts,
    json_line,
    local_sqlite_path,
    mask_database_url,
    mask_secrets,
    preflight_backup,
    preflight_migration,
    reset_postgres_sequences,
    snapshot_for_migration,
    sqlite_engine,
    table_rows,
)


def _make_sqlite(path: Path, rows: int = 3) -> Path:
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE demo (id INTEGER PRIMARY KEY, name TEXT)")
    connection.executemany("INSERT INTO demo (name) VALUES (?)", [(f"азс-{i}",) for i in range(rows)])
    connection.commit()
    connection.close()
    return path


def _count(path: Path, table: str = "demo") -> int:
    """Сколько строк в таблице — соединение закрываем: на Windows открытый
    дескриптор не даёт удалить файл (ни тесту, ни временному каталогу прогона)."""
    connection = sqlite3.connect(path)
    try:
        return int(connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
    finally:
        connection.close()


# ---------- пути и предпроверки ----------

def test_local_sqlite_path_needs_data_dir(tmp_path: Path) -> None:
    assert local_sqlite_path(None) is None
    assert local_sqlite_path(tmp_path) == tmp_path / DB_FILENAME


def test_default_backup_path_lands_in_backups_dir_with_utc_stamp(tmp_path: Path) -> None:
    moment = datetime(2026, 10, 6, 7, 5, 9, tzinfo=UTC)
    path = default_backup_path(tmp_path, moment)
    assert path == tmp_path / BACKUP_DIRNAME / "fuelradar-20261006-070509.db"
    assert backup_dir(tmp_path) == tmp_path / BACKUP_DIRNAME


def test_preflight_backup_names_missing_source(tmp_path: Path) -> None:
    result = preflight_backup(tmp_path / "нет.db", tmp_path / "copy.db")
    assert result["ok"] is False
    assert "не найдена" in result["error"]


def test_preflight_backup_refuses_copy_onto_itself(tmp_path: Path) -> None:
    source = _make_sqlite(tmp_path / "fuelradar.db")
    assert preflight_backup(source, source)["ok"] is False
    assert preflight_backup(source, tmp_path / "backups" / "copy.db")["ok"] is True


def test_preflight_backup_reports_path_taken_by_a_file(tmp_path: Path) -> None:
    source = _make_sqlite(tmp_path / "fuelradar.db")
    blocker = tmp_path / "backups"
    blocker.write_text("не каталог", encoding="utf-8")
    result = preflight_backup(source, blocker / "copy.db")
    assert result["ok"] is False
    assert "занят файлом" in result["error"]


def test_preflight_migration_covers_the_honest_failures() -> None:
    sqlite_source = "sqlite:///C:/data/fuelradar.db"
    # Цель не задана — это «не настроено», а не «готово».
    assert "backend.databaseUrl" in preflight_migration(sqlite_source, None)["error"]
    # Источник — не локальная SQLite: переносим именно её.
    assert preflight_migration("postgresql+psycopg://db/fr", "postgresql+psycopg://db/fr2")["ok"] is False
    # Цель-строка без внешней базы — частая ошибка конфигурации.
    assert "должна быть Postgres" in preflight_migration(sqlite_source, "sqlite:///C:/data/other.db")["error"]
    assert "только Postgres" in preflight_migration(sqlite_source, "mysql://db/fr")["error"]
    # Пароль не показываем даже в тексте ошибки.
    wrong = preflight_migration(sqlite_source, "oracle://user:secret@db/fr")
    assert "secret" not in wrong["error"]


def test_preflight_migration_accepts_postgres_and_masks_the_password() -> None:
    result = preflight_migration("sqlite:///C:/data/fuelradar.db", "postgresql+psycopg://fr:pw@db:5432/fuelradar")
    assert result["ok"] is True
    assert result["target"] == "postgresql+psycopg://fr:***@db:5432/fuelradar"
    assert "pw" not in json.dumps(result)


def test_mask_helpers_hide_only_the_password() -> None:
    assert mask_database_url("") is None
    assert mask_database_url("postgresql+psycopg://user:pass@host:5432/db") == "postgresql+psycopg://user:***@host:5432/db"
    assert mask_database_url("sqlite:///C:/data/fuelradar.db") == "sqlite:///C:/data/fuelradar.db"
    assert mask_secrets("could not connect: postgresql://u:secret@db/fr") == "could not connect: postgresql://u:***@db/fr"


def test_json_line_is_ascii_only_and_single_line() -> None:
    line = json_line({"kind": "backup", "error": "копия не найдена"})
    assert "\n" not in line
    assert line.isascii()
    assert json.loads(line)["error"] == "копия не найдена"


# ---------- снимок локальной базы ----------

def test_backup_sqlite_copies_rows_and_keeps_the_source_intact(tmp_path: Path) -> None:
    source = _make_sqlite(tmp_path / "fuelradar.db", rows=4)
    destination = tmp_path / "backups" / "copy.db"
    summary = backup_sqlite(source, destination)
    assert summary["ok"] is True
    assert summary["path"] == str(destination)
    assert summary["bytes"] > 0
    assert summary["tables"] == {"demo": 4}
    assert summary["rows"] == 4
    assert datetime.fromisoformat(summary["created_at"]).tzinfo is not None
    # Источник не тронут: приложение продолжает на нём работать.
    assert _count(source) == 4
    assert _count(destination) == 4


def test_backup_sqlite_reports_failure_instead_of_raising(tmp_path: Path) -> None:
    summary = backup_sqlite(tmp_path / "нет.db", tmp_path / "copy.db")
    assert summary["ok"] is False
    assert not (tmp_path / "copy.db").exists()


def test_snapshot_for_migration_leaves_a_readable_copy_and_can_be_discarded(tmp_path: Path) -> None:
    source = _make_sqlite(tmp_path / "fuelradar.db", rows=2)
    snapshot, summary = snapshot_for_migration(source)
    assert summary["ok"] is True
    assert snapshot != source
    assert _count(snapshot) == 2
    discard_snapshot(snapshot)
    assert not snapshot.exists()
    assert not snapshot.parent.exists()
    # Вторая уборка — no-op, а не исключение.
    discard_snapshot(snapshot)


# ---------- перенос данных ----------

def _seed_source(engine) -> None:
    from sqlalchemy.orm import Session

    with Session(engine) as session:
        session.add(FuelType(id=7, code="AI_95", display_name_ru="АИ-95"))
        session.add(StationBrand(id=3, name="Лукойл", canonical_name="Лукойл", priority=2))
        session.add(
            Station(
                id="fr_station_000001",
                brand_id=3,
                canonical_name="АЗС Лукойл 12",
                latitude=45.03,
                longitude=38.97,
                address="Красная 12",
            )
        )
        session.commit()


def test_copy_database_moves_every_table_and_is_idempotent(tmp_path: Path) -> None:
    source_engine = sqlite_engine(tmp_path / "source.db")
    target_engine = sqlite_engine(tmp_path / "target.db")
    Base.metadata.create_all(source_engine)
    Base.metadata.create_all(target_engine)
    _seed_source(source_engine)

    first = copy_database(source_engine, target_engine, Base.metadata)
    assert first["tables"]["fuel_types"] == {"rows": 1, "inserted": 1, "skipped": 0}
    assert first["tables"]["station_brands"]["inserted"] == 1
    assert first["tables"]["stations"]["inserted"] == 1
    assert first["inserted"] >= 3
    assert first["skipped"] == 0

    # Повторный запуск на ту же внешнюю базу ничего не дублирует и честно это
    # показывает: вставлено 0, пропущено N.
    second = copy_database(source_engine, target_engine, Base.metadata)
    assert second["inserted"] == 0
    assert second["skipped"] == first["inserted"]
    assert table_rows(target_engine, Base.metadata)["stations"] == 1
    assert table_rows(target_engine, Base.metadata)["fuel_types"] == 1

    source_engine.dispose()
    target_engine.dispose()


class _FakeConnection:
    """Подмена соединения: запоминает выражения и считает вставленные строки.

    Настоящего Postgres в прогоне нет, но диалектную ветку вставки проверить
    нужно: по ней идёт весь перенос, а не только SQLite→SQLite. `conflict_at`
    имитирует конфликт уникальности на N-й построчной вставке.
    """

    def __init__(self, name: str, rowcount: int = 1, conflict_at: int | None = None) -> None:
        from types import SimpleNamespace

        self.dialect = SimpleNamespace(name=name)
        self.statements: list = []
        self.rowcount = rowcount
        self.conflict_at = conflict_at
        self.calls = 0

    def begin_nested(self):
        from contextlib import nullcontext

        return nullcontext()

    def execute(self, statement):  # noqa: ANN001 — SQLAlchemy-выражение
        from types import SimpleNamespace

        self.calls += 1
        self.statements.append(statement)
        if self.conflict_at is not None and self.calls == self.conflict_at:
            raise IntegrityError("insert", {}, Exception("duplicate"))
        return SimpleNamespace(rowcount=self.rowcount)


def _demo_table():
    from sqlalchemy import Column, Integer, MetaData, String, Table

    return Table("demo", MetaData(), Column("id", Integer, primary_key=True), Column("name", String(8)))


def test_postgres_copy_statement_is_on_conflict_do_nothing() -> None:
    from sqlalchemy.dialects import postgresql

    connection = _FakeConnection("postgresql", rowcount=2)
    inserted = insert_rows_ignoring_conflicts(
        connection, _demo_table(), [{"id": 1, "name": "a"}, {"id": 2, "name": "b"}]
    )
    assert inserted == 2  # одна пачка → одно выражение, а не построчные вставки
    assert connection.calls == 1
    sql = str(connection.statements[0].compile(dialect=postgresql.dialect()))
    assert "INSERT INTO demo" in sql
    assert "ON CONFLICT DO NOTHING" in sql


def test_sqlite_copy_statement_is_on_conflict_do_nothing() -> None:
    from sqlalchemy.dialects import sqlite as sqlite_dialect

    connection = _FakeConnection("sqlite", rowcount=1)
    assert insert_rows_ignoring_conflicts(connection, _demo_table(), [{"id": 1, "name": "a"}]) == 1
    assert connection.calls == 1
    sql = str(connection.statements[0].compile(dialect=sqlite_dialect.dialect()))
    assert "ON CONFLICT DO NOTHING" in sql


def test_unknown_dialect_falls_back_to_row_by_row_savepoints() -> None:
    # Прочие диалекты не должны ронять перенос целиком: построчная вставка, а
    # конфликтная строка просто пропускается (не выдаём её за вставленную).
    connection = _FakeConnection("oracle", conflict_at=2)
    rows = [{"id": 1, "name": "a"}, {"id": 2, "name": "b"}, {"id": 3, "name": "c"}]
    assert insert_rows_ignoring_conflicts(connection, _demo_table(), rows) == 2
    assert connection.calls == 3


def test_reset_postgres_sequences_is_a_noop_outside_postgres(tmp_path: Path) -> None:
    engine = sqlite_engine(tmp_path / "source.db")
    Base.metadata.create_all(engine)
    assert reset_postgres_sequences(engine, Base.metadata) == []
    engine.dispose()


def test_table_rows_counts_only_existing_tables(tmp_path: Path) -> None:
    engine = sqlite_engine(tmp_path / "partial.db")
    with engine.begin() as connection:
        connection.execute(sqlite3_compat_create())
    counts = table_rows(engine, Base.metadata)
    # Ни одной таблицы моделей в базе — пустая сводка, а не выдуманные нули.
    assert counts == {}
    engine.dispose()


def sqlite3_compat_create():
    """Небольшая таблица «не из моделей» — чтобы база была не пустой."""
    from sqlalchemy import text

    return text("CREATE TABLE something_else (id INTEGER PRIMARY KEY)")
