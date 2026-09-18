"""Все базовые таблицы брифа §83 существуют (R62)."""

from sqlalchemy import inspect

# Таблицы, перечисленные в брифе §83 + служебные (R67, R10).
REQUIRED_TABLES = {
    "users", "fuel_types", "fuel_brands", "station_brands",
    "stations", "station_external_ids", "source_providers",
    "source_station_records", "fuel_observations", "queue_observations",
    "station_current_status", "monitoring_zones", "favorites",
    "alert_rules", "alert_events", "user_reports", "collection_jobs",
    "collection_logs", "source_health",
    "admin_action_log", "dedup_decisions",
}


def test_all_brief_tables_exist(db_session):
    inspector = inspect(db_session.bind)
    tables = set(inspector.get_table_names())
    missing = REQUIRED_TABLES - tables
    assert not missing, f"нет таблиц: {sorted(missing)}"


def test_seeds_present(db_session):
    from app.db.models import FuelType, SourceProvider

    codes = {ft.code for ft in db_session.query(FuelType).all()}
    assert {"AI_92", "AI_95", "DIESEL"} <= codes
    providers = {p.code: p.status for p in db_session.query(SourceProvider).all()}
    assert providers.get("osm_overpass") == "ACTIVE"
    assert providers.get("network_lists") == "NOT_USED"  # реальный адаптер, ждёт NETWORK_LISTS_URLS
    assert providers.get("yandex") == "RESEARCH_REQUIRED"  # R12