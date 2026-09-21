"""Общие зависимости API: rate limiting.

Пользователей в приложении нет: всё, что умеет система, доступно тому, кто её
запустил. Поэтому здесь не осталось ни cookie-сессий, ни RBAC — только защита от
случайного заливания API (общий лимит и отдельный, более строгий, для админ-API).
"""

from __future__ import annotations

import math
import time
from collections import defaultdict, deque
from threading import Lock

from fastapi import HTTPException, Request

from ..core.config import settings

# Кто «совершил» действие для журнала: единый локальный оператор (без входа).
LOCAL_ACTOR = "local"

_buckets: dict[str, deque[float]] = defaultdict(deque)
_admin_buckets: dict[str, deque[float]] = defaultdict(deque)
_admin_bucket_lock = Lock()
_WINDOW_SECONDS = 60.0
_ADMIN_WINDOW_SECONDS = 60.0


def reset_admin_rate_limit() -> None:
    """Сбросить отдельные бакеты админ-API (тесты и обслуживание)."""
    with _admin_bucket_lock:
        _admin_buckets.clear()


def reset_rate_limit() -> None:
    """Сброс бакетов (тесты и админ-операции)."""
    _buckets.clear()
    reset_admin_rate_limit()


def _client_ip(request: Request) -> str:
    """Адрес TCP-клиента; не доверяем spoofable X-Forwarded-For."""
    return request.client.host if request.client else "?"


def admin_rate_limit(request: Request) -> None:
    """Строгий per-IP лимит запросов к admin-API (управление источниками и каталогом).

    Это не авторизация: приложение открыто целиком. Лимит нужен, чтобы случайный
    или зацикленный клиент не положил админские операции (импорт, слияния).
    0 — выключен.
    """
    limit = settings.admin_rate_limit_per_minute
    if limit <= 0:
        return
    ip = _client_ip(request)
    now = time.monotonic()
    with _admin_bucket_lock:
        bucket = _admin_buckets[ip]
        while bucket and now - bucket[0] >= _ADMIN_WINDOW_SECONDS:
            bucket.popleft()
        if len(bucket) >= limit:
            retry_after = max(1, math.ceil(_ADMIN_WINDOW_SECONDS - (now - bucket[0])))
            raise HTTPException(
                status_code=429,
                detail="Слишком много запросов к админ-API — попробуйте позже",
                headers={"Retry-After": str(retry_after)},
            )
        bucket.append(now)


def rate_limit(request: Request) -> None:
    """R66: простой per-IP sliding window; 429 при превышении. 0 — выключен."""
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        origin = request.headers.get("origin")
        allowed = {str(request.base_url).rstrip("/"), *(o.strip() for o in settings.cors_origins.split(",") if o.strip())}
        if origin and origin not in allowed:
            raise HTTPException(status_code=403, detail="Недопустимый источник запроса")
    limit = settings.rate_limit_per_minute
    if limit <= 0:
        return
    ip = _client_ip(request)
    now = time.monotonic()
    bucket = _buckets[ip]
    while bucket and now - bucket[0] > _WINDOW_SECONDS:
        bucket.popleft()
    if len(bucket) >= limit:
        raise HTTPException(status_code=429, detail="Слишком много запросов — попробуйте позже")
    bucket.append(now)
