"""Нормализация названий и брендов АЗС (T03, R10).

«Лукойл» / «ЛУКОЙЛ» / «АЗС Лукойл №47» / «Lukoil» → канонический бренд «Лукойл».
Список алиасов — данные, а не код: расширяется в одном месте, без правки логики.
"""

from __future__ import annotations

import re

# Канонические бренды сетей: сырое вхождение → канон. Длинные ключи раньше.
BRAND_ALIASES: list[tuple[str, str]] = [
    ("газпромнефть", "Газпромнефть"),
    ("газпром нефть", "Газпромнефть"),
    ("gazpromneft", "Газпромнефть"),
    ("лукойл", "Лукойл"),
    ("лукоил", "Лукойл"),
    ("lukoil", "Лукойл"),
    ("роснефть", "Роснефть"),
    ("rosneft", "Роснефть"),
    ("татнефть", "Татнефть"),
    ("tatneft", "Татнефть"),
    ("газпром", "Газпром"),
    ("gazprom", "Газпром"),
    ("башнефть", "Башнефть"),
    ("славнефть", "Славнефть"),
    ("shell", "Shell"),
    ("шелл", "Shell"),
    ("тнк", "ТНК"),
    ("bp", "BP"),
]

# Служебные токены, не несущие идентичности (не бренды).
GENERIC_TOKENS = frozenset({"азс", "азк", "агазс", "автозаправка", "станция", "заправка"})

_NON_ALNUM = re.compile(r"[^\w\u0400-\u04FF]+", re.UNICODE)
_NUMBER = re.compile(r"№?\s*(\d{1,4})\b")


def normalize_text(raw: str) -> str:
    """Нижний регистр, ё→е, только буквы/цифры, один пробел. Для сравнения (R10)."""
    if not raw:
        return ""
    s = raw.lower().replace("ё", "е")
    s = _NON_ALNUM.sub(" ", s)
    return " ".join(s.split())


def tokens(raw: str) -> set[str]:
    """Множество токенов для сравнения названий/адресов."""
    text = normalize_text(raw)
    return set(text.split()) if text else set()


def normalize_brand(raw: str) -> str:
    """Сырой бренд/оператор → каноническое имя сети; неизвестный — "" (не ошибка)."""
    if not raw:
        return ""
    lower = raw.lower()
    for alias, canonical in BRAND_ALIASES:
        if re.search(rf"\b{re.escape(alias)}\b", lower):
            return canonical
    return ""


def extract_station_number(raw: str) -> str:
    """«АЗС Лукойл №47» → «47». Пусто, если номер не найден."""
    if not raw:
        return ""
    m = _NUMBER.search(raw)
    return m.group(1) if m else ""


def display_name(name_raw: str, brand: str, station_number: str = "") -> str:
    """Имя станции для каталога: конкретное имя > бренд > «АЗС № n»."""
    name = (name_raw or "").strip()
    if name and name not in GENERIC_TOKENS:
        return name
    if brand:
        return f"{brand} №{station_number}" if station_number else brand
    return f"АЗС №{station_number}" if station_number else "АЗС"