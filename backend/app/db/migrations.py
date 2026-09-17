"""Small additive upgrades for catalogs created before the worker existed."""

from sqlalchemy import Engine, inspect, text


def upgrade_auth(engine: Engine) -> None:
    """Add role/password fields to existing users without dropping accounts.

    ``create_all`` does not alter an already-existing table, so these additions
    are deliberately kept as an idempotent post-init migration.  Existing
    passwordless users remain ordinary USER accounts and can continue using
    Telegram/magic-link authentication.
    """
    with engine.begin() as connection:
        if connection.dialect.name == "postgresql":
            connection.execute(text("SELECT pg_advisory_xact_lock(72819301)"))
        inspector = inspect(connection)
        if not inspector.has_table("users"):
            return
        columns = {column["name"] for column in inspector.get_columns("users")}
        additions = {
            "display_name": "VARCHAR(128) DEFAULT '' NOT NULL",
            "role": "VARCHAR(16) DEFAULT 'USER' NOT NULL",
            "password_hash": "TEXT",
        }
        for name, sql_type in additions.items():
            if name not in columns:
                connection.execute(text(f"ALTER TABLE users ADD COLUMN {name} {sql_type}"))


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
