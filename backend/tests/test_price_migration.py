"""T13 — additive price migration is safe on an existing database."""

from sqlalchemy import create_engine, inspect, text


def test_price_migration_preserves_existing_rows_and_is_repeatable(tmp_path):
    from app.db.migrations import upgrade_prices

    engine = create_engine(f"sqlite:///{tmp_path / 'old-prices.db'}")
    with engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE station_current_status ("
                "id INTEGER PRIMARY KEY, station_id VARCHAR(32), fuel_type_id INTEGER, "
                "status VARCHAR(32), confidence INTEGER)"
            )
        )
        connection.execute(
            text(
                "INSERT INTO station_current_status "
                "(id, station_id, fuel_type_id, status, confidence) "
                "VALUES (7, 'fr_old', 2, 'AVAILABLE', 91)"
            )
        )

    upgrade_prices(engine)
    upgrade_prices(engine)

    columns = {column["name"] for column in inspect(engine).get_columns("station_current_status")}
    assert {"price", "price_currency", "price_source_provider_id", "price_updated_at"} <= columns
    with engine.connect() as connection:
        row = connection.execute(
            text(
                "SELECT id, station_id, status, confidence, price, price_currency "
                "FROM station_current_status"
            )
        ).one()
    assert row == (7, "fr_old", "AVAILABLE", 91, None, "RUB")
