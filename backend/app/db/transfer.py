"""Экспорт/бэкап локальной базы и перенос её данных во внешнюю (Postgres).

Зачем отдельный модуль: у установленного десктоп-приложения данные живут в
локальной SQLite (`%APPDATA%\\FuelRadar\\data\\fuelradar.db`), и оператору нужно
уметь (а) снять консистентную копию базы — на случай поломки или для передачи
в поддержку, и (б) один раз перевезти накопленное в общий Postgres/PostGIS
(`backend.databaseUrl` в config.json оболочки), не потеряв историю наблюдений.

Ключевые решения (R17/R68/R97i — «не изображать работу»):

- Копия снимается штатным онлайн-бэкапом SQLite (`sqlite3.Connection.backup`), а
  не копированием файла: приложение в этот момент работает и пишет наблюдения, а
  обычная файловая копия рискует уехать «наполовину». Перенос во внешнюю базу
  тоже идёт со снимка — то есть переносится согласованный момент времени, а не
  набор таблиц, прочитанных в разные секунды.
- Схема внешней базы не выдумывается: она создаётся из тех же моделей
  (`Base.metadata`), а идемпотентные миграции и сиды словарей штатно накатывает
  `app.db.session.init_db()` — после переноса, чтобы не плодить дубликатов там,
  где строки уже пришли из локальной базы.
- Перенос идемпотентен: строки вставляются с «пропустить конфликт», поэтому
  повторный запуск на ту же базу ничего не портит и честно показывает
  «вставлено 0, пропущено N» (а не «готово» без цифр).
- Пароль внешней базы наружу не отдаётся: и в JSON-ответ, и в сообщениях об
  ошибках адрес проходит через `mask_database_url` (R68).

Чистые функции (разбор/проверки/маска/имя файла) — точки юнит-тестов без сети и
без настоящего Postgres: `default_backup_path`, `preflight_backup`,
`preflight_migration`, `mask_database_url`, `json_line`
(backend/tests/test_db_transfer.py). Копирование таблиц проверяется на паре
SQLite-баз (диалектный код вставки тот же, что для Postgres).
"""

from __future__ import annotations

import json
import re
import sqlite3
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import Engine, MetaData, Table, create_engine, func, inspect, select, text
from sqlalchemy.exc import IntegrityError

DB_FILENAME = "fuelradar.db"
BACKUP_DIRNAME = "backups"
TIMESTAMP_FORMAT = "%Y%m%d-%H%M%S"
DEFAULT_BATCH = 200

# `postgresql+psycopg://user:pass@host/db` → `postgresql+psycopg://user:***@host/db`
_PASSWORD_RE = re.compile(r"(://[^:@/]+):[^@/]*@")


def mask_database_url(raw: object) -> str | None:
    """Адрес базы без пароля — для лога, статус-экрана и JSON-ответа (R68)."""
    text_value = str(raw or "").strip()
    if not text_value:
        return None
    return _PASSWORD_RE.sub(r"\1:***@", text_value)


def mask_secrets(text_value: object) -> str:
    """Убрать пароли из произвольного текста (сообщение драйвера, стек ошибки)."""
    return _PASSWORD_RE.sub(r"\1:***@", str(text_value or ""))


def json_line(payload: dict) -> str:
    """Одна строка JSON для оболочки.

    `ensure_ascii=True` намеренно: этот вывод читают сборочные скрипты и
    `desktop/main.cjs` через консольную кодировку Windows (cp1251), поэтому
    русский текст уезжает экранированными \\uXXXX-последовательностями, а не
    зависит от кодовой страницы машины.
    """
    return json.dumps(payload, ensure_ascii=True)


def local_sqlite_path(data_dir: str | Path | None, filename: str = DB_FILENAME) -> Path | None:
    """Путь к локальной базе в каталоге данных (None — каталог данных не задан)."""
    if not data_dir:
        return None
    return Path(data_dir) / filename


def backup_dir(data_dir: str | Path) -> Path:
    """Каталог резервных копий рядом с локальной базой (не в Program Files)."""
    return Path(data_dir) / BACKUP_DIRNAME


def default_backup_path(data_dir: str | Path, now: datetime | None = None) -> Path:
    """Куда положить копию без выбора пути: `<данные>/backups/fuelradar-<UTC-штамп>.db`."""
    stamp = (now or datetime.now(UTC)).strftime(TIMESTAMP_FORMAT)
    return backup_dir(data_dir) / f"fuelradar-{stamp}.db"


def preflight_backup(source: str | Path, destination: str | Path) -> dict:
    """Проверить копирование до его начала: что копировать и куда это можно писать.

    Ошибка здесь — это ответ оператору («локальная база не найдена: …»), а не
    исключение: оболочка показывает именно его.
    """
    source_path = Path(source)
    destination_path = Path(destination)
    if not source_path.is_file():
        return {"ok": False, "error": f"локальная база не найдена: {source_path}"}
    if source_path.resolve() == destination_path.resolve():
        return {"ok": False, "error": "копия не может совпадать с самой локальной базой"}
    parent = destination_path.parent
    if parent.exists() and not parent.is_dir():
        return {"ok": False, "error": f"путь для копии занят файлом: {parent}"}
    return {"ok": True, "source": str(source_path), "destination": str(destination_path)}


def preflight_migration(source_url: str, target_url: str | None) -> dict:
    """Проверить перенос: откуда (локальная SQLite) и куда (внешний Postgres).

    Осознанно узкие условия: переносим только из локальной SQLite (это её
    перенос, а не универсальный мигратор) и только во внешнюю не-SQLite базу —
    «перенос в Postgres» означает Postgres, иначе оператор получил бы копию
    локальной базы, ничего не заметив (R97i).
    """
    source = str(source_url or "").strip()
    target = str(target_url or "").strip()
    if not source:
        return {"ok": False, "error": "не задан источник: укажите каталог данных (--data-dir) с локальной базой"}
    if not source.startswith("sqlite"):
        return {"ok": False, "error": "перенос возможен только из локальной базы SQLite"}
    if not target:
        return {
            "ok": False,
            "error": "не задан адрес внешней базы (backend.databaseUrl в config.json или DATABASE_URL)",
        }
    if target.startswith("sqlite"):
        return {"ok": False, "error": "внешняя база должна быть Postgres: укажите postgresql+psycopg://…"}
    if not target.startswith("postgresql"):
        return {
            "ok": False,
            "error": f"поддерживается только Postgres, а указано: {mask_database_url(target)}",
        }
    if source == target:
        return {"ok": False, "error": "источник и цель совпадают"}
    return {"ok": True, "source": source, "target": mask_database_url(target)}


def sqlite_engine(path: str | Path) -> Engine:
    """Движок локальной SQLite (файл может быть залочен работающим приложением)."""
    return create_engine(f"sqlite:///{Path(path).as_posix()}", connect_args={"check_same_thread": False})


def table_rows(engine: Engine, metadata: MetaData) -> dict[str, int]:
    """Сколько строк в каждой таблице (для сводки «что именно скопировано»)."""
    existing = set(inspect(engine).get_table_names())
    counts: dict[str, int] = {}
    with engine.connect() as connection:
        for table in metadata.sorted_tables:
            if table.name not in existing:
                continue
            counts[table.name] = int(connection.execute(select(func.count()).select_from(table)).scalar_one())
    return counts


def backup_sqlite(source: str | Path, destination: str | Path) -> dict:
    """Консистентный снимок локальной базы в файл (штатный online-backup SQLite).

    Читаем источник в режиме «только чтение» и не держим его открытым дольше
    нужного: приложение может работать и писать наблюдения (R17 не нарушается —
    снимок берётся из уже закоммиченных данных).
    """
    source_path = Path(source)
    destination_path = Path(destination)
    check = preflight_backup(source_path, destination_path)
    if not check["ok"]:
        return check
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    created = False
    try:
        source_conn = sqlite3.connect(f"file:{source_path.as_posix()}?mode=ro", uri=True)
        try:
            target_conn = sqlite3.connect(destination_path)
            created = True
            try:
                source_conn.backup(target_conn)
                target_conn.commit()
                tables = target_conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
                ).fetchall()
                counts = {
                    name: int(target_conn.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]) for (name,) in tables
                }
            finally:
                target_conn.close()
        finally:
            source_conn.close()
    except Exception as exc:  # noqa: BLE001 — оператору нужна причина, а не стектрейс
        if created:
            destination_path.unlink(missing_ok=True)
        return {"ok": False, "error": f"не удалось снять копию: {type(exc).__name__}: {exc}"}
    return {
        "ok": True,
        "path": str(destination_path),
        "bytes": destination_path.stat().st_size,
        "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "tables": counts,
        "rows": sum(counts.values()),
    }


def insert_rows_ignoring_conflicts(connection, table: Table, rows: list[dict]) -> int:
    """Вставить пачку строк, пропуская конфликты; вернуть число вставленных.

    `ON CONFLICT DO NOTHING` есть и в Postgres, и в SQLite (3.24+) — этого
    достаточно, чтобы повторный перенос был безопасен. Для прочих диалектов
    (например, тестового в памяти) падаем на построчную вставку в savepoint.
    """
    dialect = connection.dialect.name
    if dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert as dialect_insert
    elif dialect == "sqlite":
        from sqlalchemy.dialects.sqlite import insert as dialect_insert
    else:
        dialect_insert = None
    if dialect_insert is not None:
        result = connection.execute(dialect_insert(table).values(rows).on_conflict_do_nothing())
        inserted = result.rowcount
        return len(rows) if inserted is None or inserted < 0 else int(inserted)
    inserted = 0
    for row in rows:
        try:
            with connection.begin_nested():
                connection.execute(table.insert().values(**row))
            inserted += 1
        except IntegrityError:
            continue
    return inserted


def copy_database(
    source: Engine,
    target: Engine,
    metadata: MetaData,
    *,
    batch: int = DEFAULT_BATCH,
) -> dict:
    """Перенести данные всех таблиц `metadata` из `source` в `target`.

    Порядок таблиц — `metadata.sorted_tables` (сначала справочники, потом то, что
    на них ссылается), поэтому внешние ключи не мешают, а чужие строки не
    появляются. Чтение идёт в одной транзакции источника: это снимок «одного
    момента», даже если снимок файла уже снят.
    """
    target_names = set(inspect(target).get_table_names())
    per_table: dict[str, dict[str, int]] = {}
    inserted_total = 0
    skipped_total = 0
    with source.connect() as source_connection:
        with source_connection.begin():
            for table in metadata.sorted_tables:
                if table.name not in target_names:
                    continue
                columns = [column.name for column in table.columns]
                rows = [
                    {column: value for column, value in row._mapping.items() if column in columns}
                    for row in source_connection.execute(select(table))
                ]
                inserted = 0
                for start in range(0, len(rows), batch):
                    chunk = rows[start : start + batch]
                    with target.begin() as target_connection:
                        inserted += insert_rows_ignoring_conflicts(target_connection, table, chunk)
                skipped = len(rows) - inserted
                per_table[table.name] = {"rows": len(rows), "inserted": inserted, "skipped": skipped}
                inserted_total += inserted
                skipped_total += skipped
    return {"tables": per_table, "inserted": inserted_total, "skipped": skipped_total}


def reset_postgres_sequences(target: Engine, metadata: MetaData) -> list[str]:
    """Догнать последовательности Postgres до максимумов перенесённых id.

    При переносе строки едут с явными id (иначе связность потерялась бы), а
    SERIAL-последовательность цели об этом не знает: следующая же вставка
    приложения получила бы занятый id. Возвращаем имена сдвинутых
    последовательностей — это часть честного отчёта, а не побочный эффект.
    """
    if target.dialect.name != "postgresql":
        return []
    from sqlalchemy import Integer

    target_names = set(inspect(target).get_table_names())
    reset: list[str] = []
    with target.begin() as connection:
        for table in metadata.sorted_tables:
            if table.name not in target_names:
                continue
            for column in table.primary_key.columns:
                if not isinstance(column.type, Integer):
                    continue
                sequence = connection.execute(
                    text("SELECT pg_get_serial_sequence(:table_name, :column_name)"),
                    {"table_name": table.name, "column_name": column.name},
                ).scalar()
                if not sequence:
                    continue
                connection.execute(
                    text(
                        f'SELECT setval(:sequence, COALESCE((SELECT MAX("{column.name}") '
                        f'FROM "{table.name}"), 0) + 1, false)'
                    ),
                    {"sequence": sequence},
                )
                reset.append(sequence)
    return reset


def snapshot_for_migration(source: str | Path) -> tuple[Path, dict]:
    """Снимок локальной базы во временном каталоге — источник переноса.

    Возвращает (путь снимка, сводку бэкапа): снимок лежит в собственном
    временном каталоге, и убрать за собой обязан вызывающий (`discard_snapshot`).
    """
    directory = Path(tempfile.mkdtemp(prefix="fuelradar-migrate-"))
    snapshot = directory / DB_FILENAME
    summary = backup_sqlite(source, snapshot)
    if not summary.get("ok"):
        directory.rmdir()
    return snapshot, summary


def discard_snapshot(snapshot: str | Path) -> None:
    """Убрать временный снимок вместе с его каталогом (ошибку уборки глотаем:
    это временные файлы, и падение из-за них не должно затирать результат)."""
    try:
        path = Path(snapshot)
        if path.exists():
            path.unlink()
        path.parent.rmdir()
    except OSError:
        return
