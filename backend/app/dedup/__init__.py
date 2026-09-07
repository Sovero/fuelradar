"""Пакет дедупликации (T03): взвешенное сравнение и мастер-каталог станций."""

from .compare import CompareInput, CompareResult, compare_records, distance_km
from .service import DedupService

__all__ = [
    "CompareInput",
    "CompareResult",
    "compare_records",
    "distance_km",
    "DedupService",
]