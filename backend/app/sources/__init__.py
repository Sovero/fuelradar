"""Источники данных: адаптерная архитектура (T02, R12)."""

from .base import (
    AdapterError,
    AuthError,
    HealthResult,
    RateLimitedError,
    ResearchRequiredError,
    SourceAdapter,
    SourceRecord,
)
from .registry import ADAPTER_CLASSES, build_adapter

__all__ = [
    "ADAPTER_CLASSES",
    "AdapterError",
    "AuthError",
    "HealthResult",
    "RateLimitedError",
    "ResearchRequiredError",
    "SourceAdapter",
    "SourceRecord",
    "build_adapter",
]