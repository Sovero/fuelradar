"""Тесты газетира регионов (cli/regions.py) — данные региона, не код (R04/R81).

Регион задаётся тремя способами (ключ газетира, координаты, DEFAULT_REGION_CITY);
тесты фиксируют их приоритет и то, что настроенный радиус не теряется.
"""

from __future__ import annotations

import pytest

from cli.regions import REGIONS, resolve_region


def test_gazetteer_key_returns_centre() -> None:
    region = resolve_region("krasnodar")
    assert region == REGIONS["krasnodar"]


def test_radius_overrides_gazetteer_value() -> None:
    region = resolve_region("krasnodar", radius_km=3.5)
    assert region["radius_km"] == 3.5
    assert region["city"] == REGIONS["krasnodar"]["city"]


def test_explicit_coordinates_win_over_gazetteer() -> None:
    region = resolve_region("krasnodar", lat=45.1, lon=39.1, radius_km=2.0, default_city="Сочи")
    assert (region["lat"], region["lon"], region["radius_km"]) == (45.1, 39.1, 2.0)
    # Без имени город берётся из настроек (город, а не координаты, — данные).
    assert region["city"] == "Сочи"


def test_default_city_matches_gazetteer_by_name() -> None:
    region = resolve_region(default_city="Краснодар")
    assert region["lat"] == REGIONS["krasnodar"]["lat"]


def test_default_region_accepts_gazetteer_key_as_well_as_city_name() -> None:
    # Оболочка знает только ключ (`backend.seedRegion: krasnodar`), а .env —
    # город («Краснодар»): оба варианта должны работать одинаково.
    by_key = resolve_region(default_city="krasnodar")
    by_name = resolve_region(default_city="Краснодар")
    assert by_key == by_name == REGIONS["krasnodar"]


def test_default_city_keeps_configured_radius() -> None:
    # Радиус из настроек (DEFAULT_REGION_RADIUS_KM) должен применяться и когда
    # регион пришёл именем города: иначе воркер собирал бы по радиусу газетира.
    region = resolve_region(default_city="Краснодар", radius_km=4.0)
    assert region["radius_km"] == 4.0


def test_unknown_region_without_coordinates_is_an_error() -> None:
    with pytest.raises(ValueError, match="не указан регион"):
        resolve_region()
    with pytest.raises(ValueError, match="не указан регион"):
        resolve_region("нет-такого-региона", default_city="Нет такого города")
