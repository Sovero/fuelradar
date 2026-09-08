"""Событийный движок (R35, брифа §46): чистая функция diff двух состояний.

Событие производно от ИЗМЕНЕНИЯ состояния (station, fuel), не от самого факта
наблюдения — повторное наблюдение того же состояния не порождает событие (R37).
Никакого доступа к БД здесь: единственный шов для тестов — `diff_event` (см.
`interfaces.md`: «событийный движок — чистая функция diff состояния»).
"""

from __future__ import annotations

from dataclasses import dataclass

from ..fuel_status import (
    AVAILABLE,
    LIKELY_AVAILABLE,
    LOW_STOCK,
    UNAVAILABLE,
)

FUEL_APPEARED = "FUEL_APPEARED"
FUEL_DISAPPEARED = "FUEL_DISAPPEARED"
FUEL_LOW = "FUEL_LOW"
QUEUE_INCREASED = "QUEUE_INCREASED"
QUEUE_DECREASED = "QUEUE_DECREASED"
CONFIDENCE_INCREASED = "CONFIDENCE_INCREASED"
STATION_NEW = "STATION_NEW"

EVENT_TYPES: tuple[str, ...] = (
    FUEL_APPEARED,
    FUEL_DISAPPEARED,
    FUEL_LOW,
    QUEUE_INCREASED,
    QUEUE_DECREASED,
    CONFIDENCE_INCREASED,
    STATION_NEW,
)

# события, привязанные к конкретному виду топлива (для дедуп-ключа/фильтра
# правил); QUEUE_* — по станции в целом (очередь общая на АЗС, не по топливу).
FUEL_SCOPED_EVENTS: frozenset[str] = frozenset({FUEL_APPEARED, FUEL_DISAPPEARED, FUEL_LOW, CONFIDENCE_INCREASED, STATION_NEW})

_AVAILABLE_LIKE = frozenset({AVAILABLE, LIKELY_AVAILABLE})

# Порог значимого роста достоверности без смены статуса — иначе шум на каждый
# пересчёт (единичный спорный сигнал не должен спамить, ср. R19.1).
CONFIDENCE_JUMP = 15

# Порядок уровней очереди для сравнения «выросла/упала»; UNKNOWN сюда намеренно
# не входит — устаревание очереди (TTL) не должно генерировать QUEUE_* событие
# (это не рост и не падение, это отсутствие данных).
_QUEUE_ORDER: tuple[str, ...] = ("NONE", "LOW", "MEDIUM", "HIGH", "VERY_HIGH")


def queue_rank(level: str) -> int | None:
    """Порядковый номер уровня очереди; None — уровень не сравним (в т.ч. UNKNOWN)."""
    try:
        return _QUEUE_ORDER.index(level)
    except ValueError:
        return None


@dataclass(frozen=True)
class EventState:
    """Снимок состояния (station, fuel), достаточный для diff'а."""

    status: str
    confidence: int
    queue_level: str = "UNKNOWN"


def diff_event(old: EventState | None, new: EventState) -> str | None:
    """R35/R37: тип события по разнице состояний либо None — без изменений.

    Порядок приоритета — по значимости из брифа: появление/исчезновение/дефицит
    топлива важнее очереди, очередь важнее роста доверия при том же статусе.
    Только одно событие на вызов (не «взрыв» уведомлений на одно изменение).
    """
    if old is None:
        # Первое состояние, которое видит движок для этой пары (station, fuel).
        # ASSUMPTION (см. CONCERNS отчёта таска): точного хука в момент создания
        # станции в каталоге (stations/ingest.py, зона T03) у этого модуля нет —
        # трактуем «впервые появилось состояние» как приближение STATION_NEW.
        return STATION_NEW

    if old.status != new.status:
        if new.status in _AVAILABLE_LIKE and old.status not in _AVAILABLE_LIKE:
            return FUEL_APPEARED
        if new.status == UNAVAILABLE and old.status != UNAVAILABLE:
            return FUEL_DISAPPEARED
        if new.status == LOW_STOCK and old.status != LOW_STOCK:
            return FUEL_LOW
        # Прочие переходы (например, в UNCERTAIN/UNKNOWN) — не заголовочное
        # событие само по себе; падаем ниже к проверке очереди/доверия.

    old_q, new_q = queue_rank(old.queue_level), queue_rank(new.queue_level)
    if old_q is not None and new_q is not None and old_q != new_q:
        return QUEUE_INCREASED if new_q > old_q else QUEUE_DECREASED

    if old.status == new.status and new.confidence - old.confidence >= CONFIDENCE_JUMP:
        return CONFIDENCE_INCREASED

    return None
