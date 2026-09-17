"""Existing catalogs survive additive worker schema upgrades."""

from sqlalchemy import create_engine, inspect, text


def test_auth_migration_preserves_existing_users_and_is_repeatable(tmp_path):
    from app.db.migrations import upgrade_auth

    engine = create_engine(f"sqlite:///{tmp_path / 'old-users.db'}")
    with engine.begin() as connection:
        connection.execute(text(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, email VARCHAR(256), "
            "reliability_score FLOAT DEFAULT 0.5, is_blocked BOOLEAN DEFAULT 0)"
        ))
        connection.execute(text("INSERT INTO users (id, email) VALUES (11, 'legacy@example.com')"))

    upgrade_auth(engine)
    upgrade_auth(engine)

    columns = {column["name"] for column in inspect(engine).get_columns("users")}
    assert {"display_name", "role", "password_hash"} <= columns
    with engine.connect() as connection:
        row = connection.execute(text("SELECT id, email, role, password_hash FROM users")).one()
        assert row == (11, "legacy@example.com", "USER", None)
    engine.dispose()



    from app.db.migrations import upgrade_worker_jobs

    engine = create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE collection_jobs (id INTEGER PRIMARY KEY, status VARCHAR(16))"))
        connection.execute(text("INSERT INTO collection_jobs VALUES (7, 'PENDING')"))
    upgrade_worker_jobs(engine)
    upgrade_worker_jobs(engine)
    columns = {column['name'] for column in inspect(engine).get_columns('collection_jobs')}
    assert {'station_id', 'next_run_at', 'locked_until', 'lock_token'} <= columns
    with engine.connect() as connection:
        assert connection.execute(text("SELECT id, status FROM collection_jobs")).one() == (7, 'PENDING')
        assert connection.execute(text("SELECT next_run_at FROM collection_jobs")).scalar() is not None
