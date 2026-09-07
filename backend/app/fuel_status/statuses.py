"""Статусы топлива и очередей (T04, §4, R03/R14/R15/R20).

Один набор значений в модели, агрегации, UI (переводы — /meta, A02), правилах и
тестах. Инвариант R15: UNKNOWN и UNAVAILABLE — разные статусы, не смешиваются ни
в одну сторону (проверяется валидатором переходов и тестами агрегации).
"""

from __future__ import annotations

AVAILABLE = "AVAILABLE"
LIKELY_AVAILABLE = "LIKELY_AVAILABLE"
LOW_STOCK = "LOW_STOCK"
UNCERTAIN = "UNCERTAIN"
UNAVAILABLE = "UNAVAILABLE"
UNKNOWN = "UNKNOWN"

FUEL_STATUSES: tuple[str, ...] = (
    AVAILABLE,
    LIKELY_AVAILABLE,
    LOW_STOCK,
    UNCERTAIN,
    UNAVAILABLE,
    UNKNOWN,
)

QUEUE_NONE = "NONE"
QUEUE_LOW = "LOW"
QUEUE_MEDIUM = "MEDIUM"
QUEUE_HIGH = "HIGH"
QUEUE_VERY_HIGH = "VERY_HIGH"

QUEUE_LEVELS: tuple[str, ...] = (
    QUEUE_NONE,
    QUEUE_LOW,
    QUEUE_MEDIUM,
    QUEUE_HIGH,
    QUEUE_VERY_HIGH,
    UNKNOWN,
)

# R15: переходы, запрещённые в обе стороны (смешение «не знаю» и «нет»).
FORBIDDEN_TRANSITIONS: frozenset[tuple[str, str]] = frozenset(
    {(UNKNOWN, UNAVAILABLE), (UNAVAILABLE, UNKNOWN)}
)


class StatusError(ValueError):
    """Некорректный статус или запрещённый переход (R15)."""


def validate_fuel_status(value: str) -> str:
    if value not in FUEL_STATUSES:
        raise StatusError(f"неизвестный статус топлива: {value!r}")
    return value


def validate_queue_level(value: str) -> str:
    if value not in QUEUE_LEVELS:
        raise StatusError(f"неизвестный уровень очереди: {value!r}")
    return value


def assert_status_transition(current: str, new: str) -> None:
    """Запрещает смешение UNKNOWN и UNAVAILABLE (R15) — ни в одну сторону."""
    validate_fuel_status(current)
    validate_fuel_status(new)
    if (current, new) in FORBIDDEN_TRANSITIONS:
        raise StatusError(
            f"запрещённый переход статусов (R15): {current} → {new}; "
            "«не знаю» и «нет» — разные состояния и не смешиваются"
        )