"""Нормализация топлива (T03, R13): сырые строки источников → код из справочника.

«95», «АИ-95», «AI95», «95 Экто», «95 G-Drive», «Premium 95» → base_fuel AI_95 +
коммерческое название (ЭКТО, G-Drive…). Неизвестное название — UNKNOWN, а не
ошибка конвейера (R13/R14: «нет данных» ≠ «топлива нет»). Чистые функции — без БД.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Коммерческие названия: длинные варианты раньше — выигрывает самое длинное совпадение.
COMMERCIAL_ALIASES: list[tuple[str, str]] = [
    ("экто плюс", "ЭКТО Плюс"),
    ("экто", "ЭКТО"),
    ("g-drive", "G-Drive"),
    ("gdrive", "G-Drive"),
    ("pulsar", "Pulsar"),
    ("премиум", "Премиум"),
    ("premium", "Премиум"),
]

_OCTANE = re.compile(r"(\d{2,3})")
_WORDS = re.compile(r"[а-яёa-z]+")


@dataclass(frozen=True)
class NormalizedFuel:
    """Результат нормализации: код из fuel_types + коммерческое название (R13.4)."""

    base_code: str = "UNKNOWN"
    commercial_name: str = ""


def _strip_commercial(lower: str) -> tuple[str, str]:
    """Возвращает (рабочая_строка, коммерческое_название). Одно название на запись."""
    for alias, display in COMMERCIAL_ALIASES:
        if alias in lower:
            return lower.replace(alias, " "), display
    return lower, ""


def normalize_fuel(raw: str) -> NormalizedFuel:
    """Строка источника → NormalizedFuel. Любая строка безопасна: незнакомое → UNKNOWN."""
    if not raw or not raw.strip():
        return NormalizedFuel("UNKNOWN", "")

    lower = raw.lower().strip()
    lower, commercial = _strip_commercial(lower)

    # метан / CNG — раньше «газ», чтобы «метан» не попал в LPG
    if "метан" in lower or "cng" in lower:
        return NormalizedFuel("CNG", commercial)
    # газ / пропан / СУГ / LPG
    if any(m in lower for m in ("газ", "пропан", "суг", "lpg", "autogas")):
        return NormalizedFuel("LPG", commercial)

    # дизель / ДТ / diesel
    words = set(_WORDS.findall(lower))
    is_diesel = "дизель" in lower or "диз" in lower or "diesel" in lower or "дт" in words
    if is_diesel:
        if commercial == "Премиум":
            return NormalizedFuel("DIESEL_PREMIUM", "")
        return NormalizedFuel("DIESEL", commercial)

    m = _OCTANE.search(lower)
    if m:
        octane = int(m.group(1))
        if octane <= 93:
            base = "AI_92"
        elif octane <= 96:
            base = "AI_95"
        elif octane <= 99:
            base = "AI_98"
        else:
            base = "AI_100"
        if commercial == "Премиум" and base == "AI_95":
            return NormalizedFuel("AI_95_PREMIUM", "")
        return NormalizedFuel(base, "" if commercial == "Премиум" else commercial)

    # «бензин» без октанового числа — октан неизвестен: честный UNKNOWN (R13)
    return NormalizedFuel("UNKNOWN", commercial or "")