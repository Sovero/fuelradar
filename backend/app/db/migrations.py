"""Small additive upgrades for catalogs created before the worker existed."""

from sqlalchemy import Engine, inspect, text

# Таблицы, которые приложение больше не использует: данные в них были привязаны к
# профилю. ``favorites`` пересоздаётся целиком (её уникальность включала user_id и
# не может быть снята отдельным DROP INDEX), остальные теряют только колонку.
_LEGACY_TABLES = ("bootstrap_state", "users")
_LEGACY_REBUILT_TABLES = ("favorites",)
_LEGACY_INDEXED_COLUMNS = {
    "monitoring_zones": (("ix_monitoring_zones_user_id", "user_id"),),
    "push_subscriptions": (
        ("ix_push_subscriptions_user", "user_id"),
        ("ix_push_subscriptions_user_id", "user_id"),
    ),
    "alert_rules": (("ix_alert_rules_user_id", "user_id"),),
    "alert_events": (("ix_alert_events_user_id", "user_id"),),
    "user_reports": (("ix_user_reports_user_id", "user_id"),),
}


def upgrade_no_users(engine: Engine) -> None:
    """Убрать пользователей из схeмы: приложение показывает всё тому, кто его запустил.

    Идемпотентно и по инспекции: на свежей базе (колонок нет) не делает ничего.
    Избранное/зоны/правила/push-подписки становятся общими, поэтому привязка к
    пользователю не нужна. Наблюдения, каталог АЗС и история не трогаются —
    теряются только персональные списки (их оператор собирает заново).
    """
    with engine.begin() as connection:
        if connection.dialect.name == "postgresql":
            connection.execute(text("SELECT pg_advisory_xact_lock(72819301)"))
        inspector = inspect(connection)

        for table in _LEGACY_REBUILT_TABLES:
            if not inspector.has_table(table):
                continue
            columns = {column["name"] for column in inspector.get_columns(table)}
            if "user_id" not in columns:
                # Свежая/уже миграциированная база: user_id нет — таблица нужна как есть
                # (иначе DROP на каждом старте уничтожал бы избранное).
                continue
            # Уникальность favorites включала user_id: снять её иначе как
            # пересозданием таблицы нельзя; список избранного собирается заново.
            connection.execute(text(f"DROP TABLE IF EXISTS {table}"))
            _recreate_table(connection, table)

        for table, indexed_columns in _LEGACY_INDEXED_COLUMNS.items():
            if not inspector.has_table(table):
                continue
            columns = {column["name"] for column in inspector.get_columns(table)}
            if all(column_name not in columns for _, column_name in indexed_columns):
                continue
            if connection.dialect.name == "sqlite":
                # SQLite не умеет DROP COLUMN, на которую ссылается foreign key
                # (например user_id в alert_rules → users): table-rebuild целиком.
                connection.execute(text(f"DROP TABLE IF EXISTS {table}"))
                _recreate_table(connection, table)
                continue
            for index_name, column_name in indexed_columns:
                if column_name not in columns:
                    continue
                connection.execute(text(f"DROP INDEX IF EXISTS {index_name}"))
                columns.discard(column_name)
                connection.execute(text(f"ALTER TABLE {table} DROP COLUMN {column_name}"))

        for table in _LEGACY_TABLES:
            if inspector.has_table(table):
                connection.execute(text(f"DROP TABLE IF EXISTS {table}"))


def _recreate_table(connection, table: str) -> None:
    """Пересоздать таблицу по актуальной модели (после DROP старой версии)."""
    from .models import Base  # локальный импорт: модели знают о миграциях только через session

    Base.metadata.tables[table].create(connection, checkfirst=True)


def upgrade_spatial_index(engine: Engine) -> None:
    """Create the production geography column and its spatial search index."""
    if engine.dialect.name != "postgresql":
        return
    with engine.begin() as connection:
        connection.execute(text("SELECT pg_advisory_xact_lock(72819301)"))
        connection.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
        connection.execute(text(
            "ALTER TABLE stations ADD COLUMN IF NOT EXISTS geog geography(Point,4326) "
            "GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude,latitude),4326)::geography) STORED"
        ))
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_stations_geog ON stations USING GIST (geog)"))


def upgrade_worker_jobs(engine: Engine) -> None:
    """Add scheduling fields without replacing existing jobs or catalog data."""
    with engine.begin() as connection:
        if connection.dialect.name == "postgresql":
            connection.execute(text("SELECT pg_advisory_xact_lock(72819301)"))
        inspector = inspect(connection)
        if not inspector.has_table("collection_jobs"):
            return
        columns = {column["name"] for column in inspector.get_columns("collection_jobs")}
        additions = {
            "station_id": "VARCHAR(32) REFERENCES stations(id)",
            "next_run_at": "TIMESTAMP",
            "locked_until": "TIMESTAMP",
            "lock_token": "VARCHAR(64)",
        }
        for name, sql_type in additions.items():
            if name not in columns:
                connection.execute(text(f"ALTER TABLE collection_jobs ADD COLUMN {name} {sql_type}"))
        connection.execute(text(
            "UPDATE collection_jobs SET next_run_at = CURRENT_TIMESTAMP WHERE next_run_at IS NULL"
        ))
        connection.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_collection_jobs_next_run_at ON collection_jobs (next_run_at)"
        ))
        if {"source_provider_id", "job_type"} <= columns:
            # Retain older duplicate jobs as failed audit records, never delete them.
            connection.execute(text(
                "UPDATE collection_jobs SET status='FAILED' WHERE id IN ("
                "SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY source_provider_id, "
                "job_type, coalesce(station_id,'') ORDER BY id) AS position FROM collection_jobs "
                "WHERE status IN ('PENDING','RUNNING')) AS duplicates WHERE position > 1)"
            ))
            connection.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_collection_active ON collection_jobs "
                "(source_provider_id, job_type, coalesce(station_id,'')) WHERE status IN ('PENDING','RUNNING')"
            ))


def upgrade_prices(engine: Engine) -> None:
    """R78 (T13): price-колонки агрегата для каталогов, созданных до T13.

    Идемпотентно: сначала инспекция, добавление только отсутствующих колонок.
    Внутри одного engine.begin() — атомарно для Postgres, итеративно для SQLite.
    """
    with engine.begin() as connection:
        if connection.dialect.name == "postgresql":
            connection.execute(text("SELECT pg_advisory_xact_lock(72819301)"))
        inspector = inspect(connection)
        if not inspector.has_table("station_current_status"):
            return
        columns = {column["name"] for column in inspector.get_columns("station_current_status")}
        additions = {
            "price": "FLOAT",
            "price_currency": "VARCHAR(8) DEFAULT 'RUB' NOT NULL",
            "price_source_provider_id": "INTEGER",
        }
        for name, sql_type in additions.items():
            if name not in columns:
                connection.execute(text(f"ALTER TABLE station_current_status ADD COLUMN {name} {sql_type}"))
        if "price_updated_at" not in columns:
            connection.execute(text(
                "ALTER TABLE station_current_status ADD COLUMN price_updated_at TIMESTAMP"
            ))
