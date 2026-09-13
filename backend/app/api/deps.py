"""Общие зависимости API (T05): rate limiting (R66), пользователь, админ (R95i)."""

from __future__ import annotations

import logging
import math
import secrets
import time
from collections import defaultdict, deque
from threading import Lock

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..auth.service import COOKIE_NAME, decode_access_token
from ..core.config import settings
from ..db.models import AdminActionLog, User
from ..db.session import get_db

_buckets: dict[str, deque[float]] = defaultdict(deque)
_admin_buckets: dict[str, deque[float]] = defaultdict(deque)
_admin_bucket_lock = Lock()
_WINDOW_SECONDS = 60.0
_ADMIN_WINDOW_SECONDS = 60.0
logger = logging.getLogger("fuelradar.security")


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
    """Строгий per-IP лимит всех запросов к admin-API.

    В отличие от общего лимита API, этот бакет вызывается внутри `require_admin`
    и поэтому защищает также GET и неуспешные проверки токена. 0 — выключен.
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


def _audit_admin_auth_failure(session: Session, request: Request, reason: str) -> None:
    """Записать безопасное предупреждение об отказе без сохранения токена.

    Аудит не должен превращать поломку БД в 500 на auth endpoint: при ошибке
    записи оставляем warning в системном логе и сохраняем исходную 401/403/503.
    """
    ip = _client_ip(request)
    path = request.url.path.replace("\r", "").replace("\n", "")[:512]
    payload = {"reason": reason, "method": request.method, "path": path, "ip": ip}
    try:
        session.add(
            AdminActionLog(
                actor="anonymous",
                action="admin_auth_failed",
                target_type="admin_auth",
                target_id=ip[:64],
                payload=payload,
            )
        )
        session.commit()
    except Exception:  # noqa: BLE001 — аудит не должен скрывать исходную auth-ошибку
        try:
            session.rollback()
        except Exception:  # noqa: BLE001 — сессия может быть уже недоступна
            pass
        logger.exception("Could not persist failed admin-auth audit event")
    logger.warning("Failed admin authentication: reason=%s method=%s path=%s ip=%s", reason, request.method, path, ip)


def _user_from_cookie(request: Request, session: Session) -> User | None:
    """Пользователь по cookie или None (карта анонимна, R65)."""
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


def require_admin(request: Request, session: Session = Depends(get_db)) -> None:
    """R95i: X-Admin-Token + отдельный строгий per-IP лимит админ-API."""
    admin_rate_limit(request)
    if not settings.admin_token:
        _audit_admin_auth_failure(session, request, "not_configured")
        raise HTTPException(status_code=503, detail="Админ-API не настроен: задайте ADMIN_TOKEN в .env")
    provided = request.headers.get("X-Admin-Token", "")
    if not provided:
        _audit_admin_auth_failure(session, request, "missing_token")
        raise HTTPException(status_code=401, detail="Требуется заголовок X-Admin-Token")
    if not secrets.compare_digest(provided, settings.admin_token):
        _audit_admin_auth_failure(session, request, "invalid_token")
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
