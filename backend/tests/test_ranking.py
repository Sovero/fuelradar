"""T04 — FuelRadar Score: бриф §58 (Б лучше А), разбор, очередь, ETA, приоритеты сетей."""

from __future__ import annotations

import pytest

from app.fuel_status import AVAILABLE, LIKELY_AVAILABLE, UNAVAILABLE, UNKNOWN
from app.ranking import (
    FUEL_STATUS_VALUE,
    ScoreInput,
    estimated_wait_minutes,
    eta_minutes,
    network_priority_value,
    score,
    travel_time_minutes,
)

# ---------- бриф §58: Б (5 км, 96%, очередь 5 мин) лучше А (2 км, 45%, 30 мин) ----------


def _station_a() -> ScoreInput:
    return ScoreInput(
        fuel_status=LIKELY_AVAILABLE, confidence=45, observed_age_minutes=10,
        distance_km=2.0, queue_level="HIGH", network_priority=5,
    )


def _station_b() -> ScoreInput:
    return ScoreInput(
        fuel_status=AVAILABLE, confidence=96, observed_age_minutes=10,
        distance_km=5.0, queue_level="LOW", network_priority=5,
    )


def test_score_prefirms_confirmed_station_b() -> None:
    """R44: не «ближайшая с очередью 30 минут», а подтверждённая в 5 км без очереди."""
    a = score(_station_a())
    b = score(_station_b())
    assert a.score < b.score
    assert 0 <= a.score <= 100 and 0 <= b.score <= 100


def test_score_breakdown_components() -> None:
    """R43.1: разбор по компонентам сохраняется; сумма вкладов = score."""
    result = score(_station_b())
    assert set(result.breakdown) == {
        "fuel_available", "confidence", "freshness", "distance", "travel_time", "queue", "user_preferences",
    }
    total = sum(c["contribution"] for c in result.breakdown.values())
    assert result.score == pytest.approx(100 * total, abs=0.1)
    assert result.breakdown["fuel_available"]["value"] == 1.0
    assert result.breakdown["confidence"]["value"] == 0.96


def test_unknown_not_unavailable_in_scoring() -> None:
    """Инвариант отражён в оценке: «не знаю» не равно «нет» (R15)."""
    assert FUEL_STATUS_VALUE[UNKNOWN] > FUEL_STATUS_VALUE[UNAVAILABLE] == 0.0
    assert score(ScoreInput(UNAVAILABLE, 0)).score < score(ScoreInput(UNKNOWN, 0)).score


def test_network_priority_only_changes_order() -> None:
    """R77: приоритет сети — компонент сортировки; станции не «прячутся»."""
    low_priority = score(ScoreInput(AVAILABLE, 90, 5, 3.0, "NONE", network_priority=5))
    high_priority = score(ScoreInput(AVAILABLE, 90, 5, 3.0, "NONE", network_priority=1))
    assert high_priority.score > low_priority.score
    assert network_priority_value(1) == 1.0
    assert network_priority_value(5) == 0.5
    assert network_priority_value(None) == 0.5  # без предпочтений — нейтрально


# ---------- очередь и ETA (R20/R45) ----------


def test_estimated_wait_minutes() -> None:
    assert estimated_wait_minutes(5, None) == 7          # 5 машин × 80 с ≈ 7 мин
    assert estimated_wait_minutes(None, "MEDIUM") == 15  # оценка по уровню
    assert estimated_wait_minutes(None, "UNKNOWN") is None  # нет данных — не выдумываем (R45.1)
    assert estimated_wait_minutes(None, None) is None


def test_travel_and_eta() -> None:
    assert travel_time_minutes(6.0) == pytest.approx(12.0)  # 6 км при 30 км/ч
    assert eta_minutes(3.0, 5) == pytest.approx(11.0)       # дорога 6 + очередь 5
    assert eta_minutes(3.0, None) == pytest.approx(6.0)     # без данных об очереди — только дорога
