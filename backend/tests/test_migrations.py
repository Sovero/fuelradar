"""Existing catalogs survive additive worker schema upgrades."""

from sqlalchemy import create_engine, inspect, text


def test_worker_migration_preserves_jobs_and_is_repeatable(tmp_path):
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
