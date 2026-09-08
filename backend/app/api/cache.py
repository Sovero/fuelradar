"""Кэш ответов карты/списка (T05, R82): in-memory TTL, заголовок X-Cache: HIT|MISS.

Ключ — путь + отсортированные непустые параметры. TTL из конфигурации (§18);
TTL <= 0 выключает кэш. Этого достаточно для карты MVP; сброс — по TTL.
"""

from __future__ import annotations

import hashlib
import threading
import time

_store: dict[str, tuple[float, object]] = {}
_lock = threading.Lock()


def cache_key(path: str, params: dict) -> str:
    raw = path + "?" + "&".join(f"{k}={params[k]}" for k in sorted(params) if params[k] is not None)
    return hashlib.sha256(raw.encode()).hexdigest()


def get_cached(key: str, ttl_seconds: int) -> tuple[bool, object | None]:
    if ttl_seconds <= 0:
        return False, None
    with _lock:
        entry = _store.get(key)
        if entry is None:
            return False, None
        stored_at, value = entry
        if time.monotonic() - stored_at > ttl_seconds:
            _store.pop(key, None)
            return False, None
        return True, value


def store(key: str, value: object, ttl_seconds: int) -> None:
    if ttl_seconds <= 0:
        return
    with _lock:
        now = time.monotonic()
        for old_key, (created, _) in list(_store.items()):
            if now - created > ttl_seconds:
                _store.pop(old_key, None)
        if len(_store) >= 1024:
            _store.pop(next(iter(_store)))
        _store[key] = (time.monotonic(), value)
