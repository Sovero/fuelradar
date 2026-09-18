"""T02 — парсинг источников, RESEARCH_REQUIRED-заглушки, health-статусы (R12/R57/R89)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.sources.base import (
    HEALTH_VALUES,
    AdapterError,
    ResearchRequiredError,
    SourceAdapter,
)
from app.sources.network_import import NetworkImportAdapter, parse_csv, parse_file
from app.sources.network_lists import NetworkListsAdapter, parse_stations_payload, split_urls
from app.sources.overpass import OverpassAdapter, bbox_from_region, parse_overpass_element
from app.sources.registry import ADAPTER_CLASSES

FIXTURES = Path(__file__).parent / "fixtures"
REGION = {"city": "Краснодар", "lat": 45.0355, "lon": 38.9753, "radius_km": 10.0}


# ---------- OSM/Overpass ----------

def test_bbox_from_region_center_radius() -> None:
    south, west, north, east = bbox_from_region(REGION)
    assert south < 45.0355 < north
    assert west < 38.9753 < east
    # радиус 10 км ≈ 0.09° по широте
    assert north - south == pytest.approx(0.18, abs=0.01)
    assert east - west > 0.18  # долгота сжимается косинусом широты


def test_bbox_from_region_explicit() -> None:
    bbox = (45.0, 38.9, 45.1, 39.0)
    assert bbox_from_region({"bbox": bbox}) == bbox


def test_parse_overpass_fixture() -> None:
    data = json.loads((FIXTURES / "overpass_krasnodar.json").read_text("utf-8"))
    adapter = OverpassAdapter(http_get=lambda url, params: data)
    records = adapter.discover_stations(REGION)
    # 4 fuel-ноды; ресторан отфильтрован
    assert len(records) == 4
    by_id = {r.external_id: r for r in records}
    lukoil = by_id["node/1000001"]
    assert lukoil.brand_raw == "Лукойл"
    assert lukoil.name_raw == "Лукойл"
    assert lukoil.latitude == pytest.approx(45.0401)
    assert "Северная" in lukoil.address_raw
    assert lukoil.extra["ref"] == "47"
    assert lukoil.extra["fuel_tags"]["fuel:octane_95"] == "yes"
    # сырой ответ сохраняется (R84 — диагностика)
    assert json.loads(lukoil.payload)["id"] == 1000001
    # минимальная нода — пустое имя, но координаты есть
    assert by_id["node/1000004"].name_raw == ""


def test_parse_overpass_element_filters_non_fuel() -> None:
    restaurant = {"type": "node", "id": 1000099, "lat": 45.0, "lon": 39.0, "tags": {"amenity": "restaurant"}}
    assert parse_overpass_element(restaurant) is None
    no_coords = {"type": "node", "id": 1, "tags": {"amenity": "fuel"}}
    assert parse_overpass_element(no_coords) is None


def test_overpass_is_discovery_only() -> None:
    adapter = OverpassAdapter()
    assert adapter.get_fuel_availability("node/1") == []  # availability не выдаёт
    assert adapter.attribution == "© OpenStreetMap contributors"


def test_overpass_health_statuses() -> None:
    from app.sources.base import AuthError, RateLimitedError

    ok = OverpassAdapter(http_get=lambda url, params: {"elements": []})
    assert ok.health_check().health == "ONLINE"
    limited = OverpassAdapter(http_get=lambda url, params: (_ for _ in ()).throw(RateLimitedError("429")))
    assert limited.health_check().health == "RATE_LIMITED"
    auth = OverpassAdapter(http_get=lambda url, params: (_ for _ in ()).throw(AuthError("403")))
    assert auth.health_check().health == "AUTH_ERROR"
    down = OverpassAdapter(http_get=lambda url, params: (_ for _ in ()).throw(AdapterError("boom")))
    assert down.health_check().health == "OFFLINE"


# ---------- импорт CSV/JSON ----------

def test_parse_csv_fixture_russian_headers() -> None:
    records = parse_file(FIXTURES / "network_krasnodar.csv")
    assert len(records) == 3
    r0 = records[0]
    assert r0.external_id == "Лукойл-3"
    assert r0.brand_raw == "Лукойл"
    assert r0.latitude == pytest.approx(45.0450)
    assert "Красная" in r0.address_raw


def test_parse_json_fixture() -> None:
    records = parse_file(FIXTURES / "network_krasnodar.json")
    assert len(records) == 2
    assert records[0].external_id == "Газпромнефть-101"


def test_parse_csv_english_headers() -> None:
    csv_text = "name,brand,lat,lon,address,ref\nАЗС 1,Тест,45.1,38.9,ул. Тестовая 1,5\n"
    records = parse_csv(csv_text)
    assert len(records) == 1
    assert records[0].external_id == "Тест-5"


def test_parse_csv_missing_coords_rejected() -> None:
    with pytest.raises(ValueError):
        parse_csv("name,lat\nАЗС 1,\n")


def test_network_import_health_no_file() -> None:
    adapter = NetworkImportAdapter(path="нет-такого-файла.csv")
    assert adapter.health_check().health == "DEGRADED"


# ---------- сетевые списки АЗС по HTTP (network_lists) ----------

NETWORK_LISTS_URL = "https://sources.example.com/krasnodar.geojson"


def _lists_adapter(http_get) -> NetworkListsAdapter:
    return NetworkListsAdapter(urls=[NETWORK_LISTS_URL], http_get=http_get)


def test_split_urls() -> None:
    assert split_urls("a; b\n\nc") == ["a", "b", "c"]
    assert split_urls("") == []


def test_parse_geojson_fixture() -> None:
    text = (FIXTURES / "network_lists_krasnodar.geojson").read_text("utf-8")
    records = parse_stations_payload(text)
    assert len(records) == 3
    by_ref = {r.external_id: r for r in records}
    lukoil = by_ref["Лукойл-12"]
    assert lukoil.brand_raw == "Лукойл"
    assert lukoil.latitude == pytest.approx(45.0302)
    assert lukoil.longitude == pytest.approx(38.9402)
    assert "Северная" in lukoil.address_raw
    # ref попадает в external_id (контракт record_from_row), а не в extra
    assert lukoil.external_id == "Лукойл-12"


def test_parse_csv_via_http_adapter() -> None:
    csv_text = "name,brand,lat,lon,address,ref\nАЗС 7,Тест,45.05,38.95,ул. Пример,7\n"
    adapter = _lists_adapter(lambda url: csv_text)
    records = adapter.discover_stations(REGION)
    assert len(records) == 1
    assert records[0].external_id == "Тест-7"


def test_lists_bbox_filter_keeps_only_region_stations() -> None:
    text = (FIXTURES / "network_lists_krasnodar.geojson").read_text("utf-8")
    adapter = _lists_adapter(lambda url: text)
    records = adapter.discover_stations(REGION)
    # третья станция фикстуры — вне bbox Краснодара
    assert len(records) == 2
    assert all(r.external_id != "Газпромнефть-9" for r in records)


def test_lists_discovery_only_and_records_raw_payload() -> None:
    text = (FIXTURES / "network_lists_krasnodar.geojson").read_text("utf-8")
    adapter = _lists_adapter(lambda url: text)
    assert adapter.get_fuel_availability("x") == []  # discovery-only
    records = adapter.discover_stations(REGION)
    payload = json.loads(records[0].payload)
    assert payload["brand"] == "Лукойл"  # сырой properties сохранён (R84)


def test_lists_no_urls_raises_adapter_error() -> None:
    adapter = NetworkListsAdapter(urls=[], http_get=lambda url: "{}")
    with pytest.raises(AdapterError):
        adapter.discover_stations(REGION)


def test_lists_health_statuses() -> None:
    from app.sources.base import AuthError, RateLimitedError

    ok = _lists_adapter(lambda url: "{\"type\": \"FeatureCollection\", \"features\": []}")
    assert ok.health_check().health == "ONLINE"
    limited = _lists_adapter(lambda url: (_ for _ in ()).throw(RateLimitedError("429")))
    assert limited.health_check().health == "RATE_LIMITED"
    auth = _lists_adapter(lambda url: (_ for _ in ()).throw(AuthError("403")))
    assert auth.health_check().health == "AUTH_ERROR"
    down = _lists_adapter(lambda url: (_ for _ in ()).throw(AdapterError("boom")))
    assert down.health_check().health == "OFFLINE"


def test_lists_no_urls_health_degraded() -> None:
    adapter = NetworkListsAdapter(urls=[])
    assert adapter.health_check().health == "DEGRADED"


# ---------- RESEARCH_REQUIRED (R89): без сети, без выдуманных данных ----------

def test_research_adapters_raise_and_never_network() -> None:
    for code, cls in ADAPTER_CLASSES.items():
        # network_lists — реальный адаптер (NOT_USED до настройки NETWORK_LISTS_URLS)
        if code in ("osm_overpass", "network_import", "user_reports", "network_lists"):
            continue
        adapter = cls()
        assert isinstance(adapter, SourceAdapter)
        assert adapter.research_required is True
        # никакого транспорта — сетевой вызов невозможен в принципе
        assert not hasattr(adapter, "_http_get")
        with pytest.raises(ResearchRequiredError):
            adapter.discover_stations(REGION)
        with pytest.raises(ResearchRequiredError):
            adapter.get_fuel_availability("x")
        assert adapter.health_check().health == "OFFLINE"


def test_all_health_check_values_are_valid() -> None:
    for code, cls in ADAPTER_CLASSES.items():
        adapter = cls() if code != "network_import" else NetworkImportAdapter(path="нет-файла.csv")
        if code == "osm_overpass":
            continue  # требует транспорта — проверен выше
        assert adapter.health_check().health in HEALTH_VALUES