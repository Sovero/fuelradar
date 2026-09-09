"""Каркас метрик (R70).

Счётчики: запросы/ошибки по источникам, станции, наблюдения, уведомления,
длительность сбора — наполняются воркером (T06) и API. Два процесса (api и
worker) не разделяют память, поэтому без общего хранилища `/metrics`,
опрошенный у API, не увидит то, что насчитал воркер (и наоборот).

Если задан `REDIS_URL` — счётчики хранятся в Redis (`INCRBY`/`SET`, один
хэш `fuelradar:metrics`), и оба процесса видят одни и те же значения.
Без него — in-memory на процесс, как и раньше (годится для локальной
разработки и тестов, где всё работает в одном процессе).
"""

from __future__ import annotations

import threading
from collections import defaultdict
from functools import lru_cache

from .config import settings

_lock = threading.Lock()
_counters: dict[str, int] = defaultdict(int)

_REDIS_KEY = "fuelradar:metrics"


@lru_cache
def _redis_client():
    """`None`, если `REDIS_URL` не задан или пакет/сервер недоступны — тихий откат на in-memory."""
    if not settings.redis_url:
        return None
    try:
        import redis

        client = redis.Redis.from_url(settings.redis_url, decode_responses=True, socket_connect_timeout=2)
        client.ping()
        return client
    except Exception:  # noqa: BLE001 — метрики не должны ронять приложение из-за недоступного Redis
        return None


def inc(name: str, by: int = 1) -> None:
    client = _redis_client()
    if client is not None:
        try:
            client.hincrby(_REDIS_KEY, name, by)
            return
        except Exception:  # noqa: BLE001
            pass  # Redis отвалился в рантайме — не теряем счётчик, пишем в память
    with _lock:
        _counters[name] += by


def set_gauge(name: str, value: int) -> None:
    client = _redis_client()
    if client is not None:
        try:
            client.hset(_REDIS_KEY, name, value)
            return
        except Exception:  # noqa: BLE001
            pass
    with _lock:
        _counters[name] = value


def snapshot() -> dict[str, int]:
    client = _redis_client()
    if client is not None:
        try:
            raw = client.hgetall(_REDIS_KEY)
            return {k: int(v) for k, v in raw.items()}
        except Exception:  # noqa: BLE001
            pass
    with _lock:
        return dict(_counters)


def reset_for_tests() -> None:
    """Только для тестов: сбрасывает in-memory счётчики и кэш клиента Redis."""
    with _lock:
        _counters.clear()
    if hasattr(_redis_client, "cache_clear"):
        _redis_client.cache_clear()
