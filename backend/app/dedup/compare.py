"""Взвешенное сопоставление записей источников (T03, R10).

Веса — из конфигурации §11 брифа: координаты 50%, бренд 20%, адрес 15%,
название 10%, телефон 5%. Пороги auto_merge / needs_review — тоже конфигурация
(§18). Чистые функции: unit-тесты без БД.

Геометрия компонентов:
  - coordinates: 1.0 до 100 м, линейный спад до 0 на 1 км (дальше — разные АЗС);
  - brand: канонический бренд равен → 1.0; разные → 0.0; пустая сторона
    (или обе) → 0.5 (нейтрально: нет ни подтверждения, ни противоречия —
    обогащение записи не штрафуется, см. R84-кейс ручного импорта);
  - address/name: максимум из Jaccard и containment по токенам; пустая сторона → 0.5;
  - phone: последние 10 цифр равны → 1.0; пустая сторона → 0.5.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

from ..core.config import settings
from ..normalization.names import normalize_brand, tokens

EARTH_RADIUS_KM = 6371.0

# Максимальная дистанция кандидата: за 1 км coordinates = 0 и максимум суммы
# остальных весов (0.5) ниже порога needs_review — сравнение бессмысленно.
MAX_CANDIDATE_DISTANCE_KM = 2.0

NAME_STOPWORDS = frozenset({"азс", "азк", "агазс", "заправка", "станция"})
ADDR_STOPWORDS = frozenset(
    {"ул", "улица", "ш", "шоссе", "пр", "проспект", "пер", "переулок", "дом", "д", "город", "г", "обл", "область"}
)

_PHONE_DIGITS = re.compile(r"\d+")


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Расстояние по haversine, км."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = phi2 - phi1
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


@dataclass(frozen=True)
class CompareInput:
    """Лёгкое представление записи для сравнения (из SourceStationRecord или тестов)."""

    latitude: float
    longitude: float
    brand_raw: str = ""
    name_raw: str = ""
    address_raw: str = ""
    phone: str = ""


@dataclass(frozen=True)
class CompareResult:
    """Итог сравнения: общий score и разбор по весам (R10.1 — объяснимость)."""

    score: float
    weights: dict[str, float] = field(default_factory=dict)
    components: dict[str, float] = field(default_factory=dict)
    distance_km: float = 0.0


def _coord_component(d_km: float) -> float:
    if d_km <= 0.1:
        return 1.0
    if d_km >= 1.0:
        return 0.0
    return 1.0 - (d_km - 0.1) / 0.9


def _brand_component(brand_a: str, brand_b: str) -> float:
    ca, cb = normalize_brand(brand_a), normalize_brand(brand_b)
    if ca and cb:
        return 1.0 if ca == cb else 0.0
    return 0.5  # хотя бы одна сторона пуста — нейтрально (обогащение не штрафуем)


def _token_component(text_a: str, text_b: str, stopwords: frozenset[str]) -> float:
    ta = tokens(text_a) - stopwords
    tb = tokens(text_b) - stopwords
    if not ta or not tb:
        return 0.5  # пустая сторона — нейтрально (обогащение не штрафуем)
    inter = len(ta & tb)
    jaccard = inter / len(ta | tb)
    containment = inter / min(len(ta), len(tb))
    return max(jaccard, containment)


def _phone_component(phone_a: str, phone_b: str) -> float:
    da = "".join(_PHONE_DIGITS.findall(phone_a or ""))
    db = "".join(_PHONE_DIGITS.findall(phone_b or ""))
    if not da or not db:
        return 0.5  # пустая сторона — нейтрально (обогащение не штрафуем)
    return 1.0 if da[-10:] == db[-10:] else 0.0


def compare_records(
    a: CompareInput,
    b: CompareInput,
    weights: dict[str, float] | None = None,
) -> CompareResult:
    """Взвешенное сравнение двух записей. Веса по умолчанию — из settings (§11)."""
    w = weights or dict(settings.dedup_weights)
    d = distance_km(a.latitude, a.longitude, b.latitude, b.longitude)
    components = {
        "coordinates": _coord_component(d),
        "brand": _brand_component(a.brand_raw, b.brand_raw),
        "address": _token_component(a.address_raw, b.address_raw, ADDR_STOPWORDS),
        "name": _token_component(a.name_raw, b.name_raw, NAME_STOPWORDS),
        "phone": _phone_component(a.phone, b.phone),
    }
    score = sum(w[k] * components.get(k, 0.0) for k in w)
    return CompareResult(score=score, weights=w, components=components, distance_km=d)