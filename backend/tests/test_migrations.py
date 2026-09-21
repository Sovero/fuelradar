"""Существующий каталог переживает дополняющие миграции схемы.

Пользователей в приложении нет, поэтому отдельный тест проверяет, что старая
персональная схема (users/favorites с user_id) очищается идемпотентно и при этом
НЕ трогает каталог АЗС и историю наблюдений.
"""

from sqlalchemy import create_engine, inspect, text


def test_legacy_user_schema_is_dropped_and_is_repeatable(tmp_path):
    from app.db.migrations import upgrade_no_users

    engine = create_engine(f"sqlite:///{tmp_path / 'legacy.db'}")
    with engine.begin() as connection:
        connection.execute(text(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, email VARCHAR(256), "
            "display_name VARCHAR(128), role VARCHAR(16), password_hash VARCHAR(256))"
        ))
        connection.execute(text("INSERT INTO users (id, email) VALUES (11, 'legacy@example.com')"))
        connection.execute(text(
            "CREATE TABLE favorites (id INTEGER PRIMARY KEY, user_id INTEGER, station_id VARCHAR(32))"
        ))
        connection.execute(text("CREATE UNIQUE INDEX uq_favorite_user_station ON favorites (user_id, station_id)"))
        connection.execute(text(
            "CREATE TABLE monitoring_zones (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), name VARCHAR(128))"
        ))
        connection.execute(text(
            "CREATE TABLE stations (id VARCHAR(32) PRIMARY KEY, canonical_name VARCHAR(256), "
            "latitude FLOAT, longitude FLOAT)"
        ))
        connection.execute(text("INSERT INTO stations VALUES ('fr_station_1', 'АЗС', 45.0, 39.0)"))

    upgrade_no_users(engine)
    upgrade_no_users(engine)  # идемпотентность: второй прогон ничего не меняет

    inspector = inspect(engine)
    assert not inspector.has_table("users"), "таблица пользователей удаляется"
    assert "user_id" not in {column["name"] for column in inspector.get_columns("monitoring_zones")}
    # Избранное пересоздано в актуальной схеме (без user_id) — не потеряно вовсе.
    assert inspector.has_table("favorites")
    assert "user_id" not in {column["name"] for column in inspector.get_columns("favorites")}
    with engine.connect() as connection:
        assert connection.execute(text("SELECT id FROM stations")).scalar() == "fr_station_1"
    engine.dispose()


def test_legacy_worker_jobs_upgrade_keeps_jobs(tmp_path):
    from app.db.migrations import upgrade_worker_jobs

    engine = create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE collection_jobs (id INTEGER PRIMARY KEY, status VARCHAR(16))"))
        connection.execute(text("INSERT INTO collection_jobs VALUES (7, 'PENDING')"))
    upgrade_worker_jobs(engine)
    upgrade_worker_jobs(engine)
    columns = {column["name"] for column in inspect(engine).get_columns("collection_jobs")}
    assert {"station_id", "next_run_at", "locked_until", "lock_token"} <= columns
    with engine.connect() as connection:
        assert connection.execute(text("SELECT id, status FROM collection_jobs")).one() == (7, "PENDING")
        assert connection.execute(text("SELECT next_run_at FROM collection_jobs")).scalar() is not None
    engine.dispose()
