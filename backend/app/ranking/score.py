"""FuelRadar Score, очередь и ETA (T04, §10, R20/R43/R44/R45/R77).

Score — сумма взвешенных нормализованных компонент (веса — конфигурация §18):
fuel_available, confidence, freshness, distance, travel_time, queue,
user_preferences (приоритет сети R77 — только компонент сортировки, не фильтр).
Разбор сохраняется в `score_breakdown` (R43.1 — объяснимость).

Очередь (R20): исходное число машин хранится оригиналом; ожидание оценивается
(по умолчанию ~80 с/машина); без данных — null, а не выдуманная точность.
ETA (R45) = travel_time (haversine × средняя скорость, ASSUMPTION) + ожидание.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..core.config import settings
from ..fuel_status import UNKNOWN, validate_fuel_status, validate_queue_level

# Статус → «насколько топливо реально доступно» (для Score; UNKNOWN > 0, но < уверенного)
FUEL_STATUS_VALUE: dict[str, float] = {
    "AVAILABLE": 1.0,
    "LIKELY_AVAILABLE": 0.8,
    "LOW_STOCK": 0.5,
    "UNCERTAIN": 0.35,
    "UNKNOWN": 0.2,
    "UNAVAILABLE": 0.0,
}

QUEUE_LEVEL_VALUE: dict[str, float] = {
    "NONE": 1.0,
    "LOW": 0.8,
    "MEDIUM": 0.5,
    "HIGH": 0.2,
    "VERY_HIGH": 0.0,
    "UNKNOWN": 0.6,  # нет данных об очереди ≠ «очереди нет» (R20.1)
}

# Уровень → ожидание в минутах (оценка для ETA, когда нет точного числа машин)
QUEUE_LEVEL_MINUTES: dict[str, int | None] = {
    "NONE": 0,
    "LOW": 5,
    "MEDIUM": 15,
    "HIGH": 30,
    "VERY_HIGH": 60,
    "UNKNOWN": None,
}


def estimated_wait_minutes(
    queue_vehicles: int | None,
    queue_level: str | None = None,
    seconds_per_vehicle: int | None = None,
) -> int | None:
    """R20: ожидание из точного числа машин (~80 с/машина) или из уровня.

    Без данных — None (в UI «≈», а не факт, R45.1).
    """
    seconds_per_vehicle = seconds_per_vehicle or settings.queue_seconds_per_vehicle
    if queue_vehicles is not None and queue_vehicles > 0:
        return round(queue_vehicles * seconds_per_vehicle / 60)
    if queue_level and queue_level != UNKNOWN:
        minutes = QUEUE_LEVEL_MINUTES.get(queue_level)
        if minutes is not None:
            return minutes
    return None


def travel_time_minutes(distance_km: float, speed_kmh: float | None = None) -> float:
    """Время в пути по haversine-расстоянию и средней скорости (ASSUMPTION)."""
    speed = speed_kmh or settings.avg_speed_kmh
    if speed <= 0:
        return 0.0
    return distance_km / speed * 60.0


def eta_minutes(
    distance_km: float,
    wait_minutes: int | None,
    speed_kmh: float | None = None,
) -> float | None:
    """R45: ETA = travel_time + ожидание; без данных об очереди — только дорога."""
    travel = travel_time_minutes(distance_km, speed_kmh)
    if wait_minutes is None:
        return round(travel, 1)
    return round(travel + wait_minutes, 1)


def network_priority_value(priority: int | None) -> float:
    """R77: приоритет сети (1=высокий … 5=низкий) → компонент 1.0…0.5.

    Дефолт (5) нейтрален (0.5); настройка меняет только сортировку.
    """
    p = priority if priority is not None else 5
    return max(0.0, 1.0 - (p - 1) * 0.125)


@dataclass(frozen=True)
class ScoreInput:
    """Вход Score. distance/travel — от позиции пользователя (вычисляются в API, T05)."""

    fuel_status: str = UNKNOWN
    confidence: int = 0                 # 0–100
    observed_age_minutes: int | None = None  # свежесть последнего наблюдения
    distance_km: float | None = None
    queue_level: str = UNKNOWN
    queue_vehicles: int | None = None
    network_priority: int | None = 5    # R77
    ttl_minutes: int | None = None      # TTL категории (топливо по умолчанию)


@dataclass(frozen=True)
class ScoreResult:
    score: float                        # 0–100
    breakdown: dict[str, dict[str, float]]  # компонент → {value, weight, contribution}


def score(input_data: ScoreInput, weights: dict[str, float] | None = None) -> ScoreResult:
    """Взвешенная сумма нормализованных компонент + разбор (R43/R43.1)."""
    w = weights or dict(settings.score_weights)
    ttl = input_data.ttl_minutes or settings.ttl_fuel_minutes
    validate_fuel_status(input_data.fuel_status)
    validate_queue_level(input_data.queue_level)

    components: dict[str, float] = {
        "fuel_available": FUEL_STATUS_VALUE[input_data.fuel_status],
        "confidence": max(0.0, min(1.0, input_data.confidence / 100.0)),
        "freshness": _freshness_component(input_data.observed_age_minutes, ttl),
        "distance": _distance_component(input_data.distance_km),
        "travel_time": _travel_component(input_data.distance_km),
        "queue": QUEUE_LEVEL_VALUE[input_data.queue_level],
        "user_preferences": network_priority_value(input_data.network_priority),
    }

    total = sum(w[k] * components[k] for k in w if k in components)
    breakdown = {
        name: {
            "value": round(value, 3),
            "weight": w.get(name, 0.0),
            "contribution": round(w.get(name, 0.0) * value, 3),
        }
        for name, value in components.items()
        if w.get(name, 0.0) > 0
    }
    return ScoreResult(score=round(100.0 * total, 1), breakdown=breakdown)


def _freshness_component(age_minutes: int | None, ttl_minutes: int) -> float:
    if age_minutes is None:
        return 0.5  # нейтрально: возраст неизвестен
    if age_minutes >= ttl_minutes:
        return 0.0
    return max(0.0, 1.0 - age_minutes / ttl_minutes)


def _distance_component(distance_km: float | None) -> float:
    if distance_km is None:
        return 0.5  # нейтрально: позиция пользователя не задана
    return max(0.0, 1.0 - distance_km / settings.score_distance_max_km)


def _travel_component(distance_km: float | None) -> float:
    if distance_km is None:
        return 0.5
    travel = travel_time_minutes(distance_km)
    return max(0.0, 1.0 - travel / settings.score_travel_max_minutes)