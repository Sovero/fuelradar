"""T03 — нормализация (R10/R13): чистые функции, без БД."""

from __future__ import annotations

from app.normalization import (
    display_name,
    extract_station_number,
    normalize_brand,
    normalize_fuel,
    tokens,
)


def test_normalize_fuel_common() -> None:
    """«95», «АИ-95», «AI95», «95 Экто», «95 G-Drive» → AI_95 + коммерческое имя (R13)."""
    cases: dict[str, tuple[str, str]] = {
        "95": ("AI_95", ""),
        "АИ-95": ("AI_95", ""),
        "AI95": ("AI_95", ""),
        "95 Экто": ("AI_95", "ЭКТО"),
        "Экто 95": ("AI_95", "ЭКТО"),
        "95 G-Drive": ("AI_95", "G-Drive"),
        "Premium 95": ("AI_95_PREMIUM", ""),
        "95 Премиум": ("AI_95_PREMIUM", ""),
        "Экто 100": ("AI_100", "ЭКТО"),
        "АИ-98": ("AI_98", ""),
        "АИ-92": ("AI_92", ""),
        "ДТ": ("DIESEL", ""),
        "дизельное топливо": ("DIESEL", ""),
        "ДТ-Евро 5": ("DIESEL", ""),
        "Газ": ("LPG", ""),
        "пропан": ("LPG", ""),
        "СУГ": ("LPG", ""),
        "метан": ("CNG", ""),
    }
    for raw, expected in cases.items():
        nf = normalize_fuel(raw)
        assert (nf.base_code, nf.commercial_name) == expected, raw


def test_normalize_fuel_unknown_is_not_error() -> None:
    """Незнакомое название → UNKNOWN, а не исключение конвейера (R13/R14)."""
    assert normalize_fuel("фигня какая-то").base_code == "UNKNOWN"
    assert normalize_fuel("").base_code == "UNKNOWN"
    assert normalize_fuel("   ").base_code == "UNKNOWN"


def test_normalize_brand_aliases() -> None:
    """«Лукойл»/«ЛУКОЙЛ»/«АЗС Лукойл №47»/«Lukoil» → один канон (R10)."""
    assert normalize_brand("Лукойл") == "Лукойл"
    assert normalize_brand("ЛУКОЙЛ") == "Лукойл"
    assert normalize_brand("Lukoil") == "Лукойл"
    assert normalize_brand("АЗС Лукойл №47") == "Лукойл"
    assert normalize_brand("ЛУКОЙЛ-Югнефтепродукт") == "Лукойл"
    assert normalize_brand("Роснефть") == "Роснефть"
    assert normalize_brand("Газпромнефть") == "Газпромнефть"
    assert normalize_brand("GazpromNeft") == "Газпромнефть"
    assert normalize_brand("АЗС") == ""
    assert normalize_brand("") == ""


def test_tokens_for_comparison() -> None:
    assert tokens("АЗС Лукойл №47") == {"азс", "лукойл", "47"}
    assert tokens("ул. Северная, д. 228") == {"ул", "северная", "д", "228"}


def test_display_name_and_number() -> None:
    assert extract_station_number("АЗС Лукойл №47") == "47"
    assert display_name("АЗС № 3", "Лукойл", "3") == "АЗС № 3"
    assert display_name("", "Лукойл", "47") == "Лукойл №47"
    assert display_name("", "", "") == "АЗС"