"""Кэш ответов карты/списка (T05, R82): in-memory TTL, заголовок X-Cache: HIT|MISS.

Ключ — путь + отсортированные непустые параметры. TTL из конфигурации (§18);
TTL <= 0 выключает кэш. Версия данных в ключе меняется при добавлении станции
или наблюдения, поэтому устаревший ответ не ждёт TTL.
"""

from __future__ import annotations

import hashlib
import threading
import time

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db.models import FuelObservation, QueueObservation, Station

_store: dict[str, tuple[float, object]] = {}
_lock = threading.Lock()


def data_revision(session: Session) -> tuple[str, ...]:
    """Компактная версия данных для ленивой инвалидации кэша карты.

    Наблюдения append-only (R17), поэтому максимальные id надёжно меняются при
    каждой новой записи. Максимальный id станции покрывает пополнение каталога.
    Все три поля — индексированные первичные ключи, чтобы проверка версии не
    превращала кэшированный запрос в полный проход по таблицам.
    """
    row = session.execute(
        select(
            select(func.max(Station.id)).scalar_subquery(),
            select(func.max(FuelObservation.id)).scalar_subquery(),
            select(func.max(QueueObservation.id)).scalar_subquery(),
        )
    ).one()
    return tuple(str(value) for value in row)


def cache_key(path: str, params: dict, revision: tuple[str, ...] = ()) -> str:
    raw = path + "?" + "&".join(f"{k}={params[k]}" for k in sorted(params) if params[k] is not None)
    raw += "#" + "|".join(revision)
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
