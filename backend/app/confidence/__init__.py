"""Пакет Confidence Engine (T04): агрегация наблюдений и сервис статусов."""

from .aggregate import (
    AggregateResult,
    AggregationConfig,
    Contribution,
    ObservationInput,
    aggregate,
    freshness,
)
from .service import StatusService

__all__ = [
    "ObservationInput",
    "AggregationConfig",
    "AggregateResult",
    "Contribution",
    "aggregate",
    "freshness",
    "StatusService",
]
