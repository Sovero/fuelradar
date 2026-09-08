"""Общие зависимости API (T05): rate limiting (R66), пользователь, админ (R95i)."""

from __future__ import annotations

import secrets
import time
from collections import defaultdict, deque

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..auth.service import COOKIE_NAME, decode_access_token
from ..core.config import settings
from ..db.models import User
from ..db.session import get_db

_buckets: dict[str, deque[float]] = defaultdict(deque)
_WINDOW_SECONDS = 60.0


def reset_rate_limit() -> None:
    """Сброс бакетов (тесты и админ-операции)."""
    _buckets.clear()


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
    ip = request.client.host if request.client else "?"
    now = time.monotonic()
    bucket = _buckets[ip]
    while bucket and now - bucket[0] > _WINDOW_SECONDS:
        bucket.popleft()
    if len(bucket) >= limit:
        raise HTTPException(status_code=429, detail="Слишком много запросов — попробуйте позже")
    bucket.append(now)


def _user_from_cookie(request: Request, session: Session) -> User | None:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None
    user_id = decode_access_token(token)
    if user_id is None:
        return None
    user = session.get(User, user_id)
    if user is None or user.is_blocked:  # R41.1: блок админом закрывает доступ сразу
        return None
    return user


def optional_user(request: Request, session: Session = Depends(get_db)) -> User | None:
    """Пользователь по cookie или None (карта анонимна, R65)."""
    return _user_from_cookie(request, session)


def require_user(user: User | None = Depends(optional_user)) -> User:
    """Персонализация — только с профилем (R65)."""
    if user is None:
        raise HTTPException(status_code=401, detail="Требуется вход: раздел доступен только с профилем")
    return user


def require_admin(request: Request) -> None:
    """R95i: админ-API — по заголовку X-Admin-Token из .env."""
    if not settings.admin_token:
        raise HTTPException(status_code=503, detail="Админ-API не настроен: задайте ADMIN_TOKEN в .env")
    provided = request.headers.get("X-Admin-Token", "")
    if not provided:
        raise HTTPException(status_code=401, detail="Требуется заголовок X-Admin-Token")
    if not secrets.compare_digest(provided, settings.admin_token):
        raise HTTPException(status_code=403, detail="Неверный админ-токен")


def set_auth_cookie(response_cookie_setter, token: str) -> None:
    response_cookie_setter(
        COOKIE_NAME,
        token,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        max_age=7 * 24 * 3600,
        path="/",
    )
