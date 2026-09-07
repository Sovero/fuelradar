"""Каркас метрик (R70).

In-memory счётчики на процесс. Наполняются воркером (T06): запросы/ошибки по источникам,
станции, наблюдения, длительность сбора. При Redis в prod — переносится без изменения API.

Зарегистрированные счётчики — по имени, с метками вида `source:osm_overpass`.
"""

from __future__ import annotations

import threading
from collections import defaultdict

_lock = threading.Lock()
_counters: dict[str, int] = defaultdict(int)


def inc(name: str, by: int = 1) -> None:
    with _lock:
        _counters[name] += by


def set_gauge(name: str, value: int) -> None:
    with _lock:
        _counters[name] = value


def snapshot() -> dict[str, int]:
    with _lock:
        return dict(_counters)