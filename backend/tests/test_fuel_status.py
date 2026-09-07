"""T04 — наборы статусов и инвариант R15: UNKNOWN ≠ UNAVAILABLE."""

from __future__ import annotations

import pytest

from app.fuel_status import (
    AVAILABLE,
    FUEL_STATUSES,
    QUEUE_LEVELS,
    UNAVAILABLE,
    UNKNOWN,
    StatusError,
    assert_status_transition,
    validate_fuel_status,
    validate_queue_level,
)


def test_status_sets_exact() -> None:
    """Наборы из брифа §17/§24 фиксируются тестом (R14/R20)."""
    assert FUEL_STATUSES == (
        "AVAILABLE", "LIKELY_AVAILABLE", "LOW_STOCK", "UNCERTAIN", "UNAVAILABLE", "UNKNOWN",
    )
    assert QUEUE_LEVELS == ("NONE", "LOW", "MEDIUM", "HIGH", "VERY_HIGH", "UNKNOWN")


def test_validate_status() -> None:
    assert validate_fuel_status("AVAILABLE") == "AVAILABLE"
    assert validate_queue_level("UNKNOWN") == "UNKNOWN"
    with pytest.raises(StatusError):
        validate_fuel_status("MAYBE")
    with pytest.raises(StatusError):
        validate_queue_level("HUGE")


def test_invariant_unknown_not_unavailable() -> None:
    """R15: смешение «не знаю» и «нет» запрещено в обе стороны."""
    # легальные переходы не ругаются
    assert_status_transition(AVAILABLE, UNKNOWN)  # устаревание
    assert_status_transition(UNKNOWN, AVAILABLE)  # появились данные
    assert_status_transition(AVAILABLE, UNAVAILABLE)  # реально закончилось

    # запрещённые — StatusError
    with pytest.raises(StatusError, match="R15"):
        assert_status_transition(UNKNOWN, UNAVAILABLE)
    with pytest.raises(StatusError, match="R15"):
        assert_status_transition(UNAVAILABLE, UNKNOWN)
