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


def test_network_lists_gains_availability_without_touching_operator_choice(tmp_path):
    """Старая база: у сетевых списков появляется наличие, интервал ужимается до 15 мин.

    Проверяем и границы миграции: статус (выключенный оператором источник) и доверие
    не меняются, а выставленный человеком интервал не переписывается.
    """
    from app.db.base import Base
    from app.db.migrations import upgrade_network_lists_availability
    from app.db.models import SourceProvider

    engine = create_engine(f"sqlite:///{tmp_path / 'lists.db'}")
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(text(
            "INSERT INTO source_providers (code, name, capabilities, status, min_interval_minutes, "
            "attribution, trust) VALUES ('network_lists', 'Сетевые списки АЗС (HTTP)', "
            "'{\"discovery\": true, \"availability\": false, \"queue\": false}', 'NOT_USED', 1440, '', 0.65)"
        ))
        connection.execute(text(
            "INSERT INTO source_providers (code, name, capabilities, status, min_interval_minutes, "
            "attribution, trust) VALUES ('osm_overpass', 'OSM', '{\"discovery\": true}', 'ACTIVE', 1440, '', 0.6)"
        ))

    upgrade_network_lists_availability(engine)
    upgrade_network_lists_availability(engine)  # идемпотентность

    from sqlalchemy.orm import Session

    with Session(engine) as session:
        lists = session.query(SourceProvider).filter_by(code="network_lists").one()
        assert lists.capabilities["availability"] is True
        assert lists.capabilities["availability_bulk"] is True
        assert lists.min_interval_minutes == 15  # старый суточный сид
        assert lists.status == "NOT_USED"  # решение оператора не трогаем
        assert lists.trust == 0.65
        osm = session.query(SourceProvider).filter_by(code="osm_overpass").one()
        assert osm.min_interval_minutes == 1440  # чужие источники не затронуты
        assert osm.capabilities == {"discovery": True}

    # Оператор выставил свой интервал — миграция его не переопределяет
    with engine.begin() as connection:
        connection.execute(text("UPDATE source_providers SET min_interval_minutes = 30 WHERE code = 'network_lists'"))
    upgrade_network_lists_availability(engine)
    with Session(engine) as session:
        assert session.query(SourceProvider).filter_by(code="network_lists").one().min_interval_minutes == 30
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
