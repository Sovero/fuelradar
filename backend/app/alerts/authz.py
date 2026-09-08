"""Резолвинг пользователя для /reports и /notifications (T07, R41.1).

Не переиспользует `api.deps.require_user` намеренно: тот «проглатывает»
блокировку в 401 (заблокированный выглядит как разлогиненный — удобно для
персонализации T05, но не подходит здесь). Тикет требует различать:
  - гость (нет cookie/сессии) → 401 везде;
  - заблокированный пользователь → всё ещё видит свою историю (`current_user`),
    но НЕ может отправлять новые отчёты → 403 (`current_active_user`, R41.1).
"""

from __future__ import annotations

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..auth.service import COOKIE_NAME, decode_access_token
from ..db.models import User
from ..db.session import get_db


def current_user(request: Request, session: Session = Depends(get_db)) -> User:
    """Пользователь по cookie сессии; блокировка не скрывает историю (R41.1)."""
    token = request.cookies.get(COOKIE_NAME)
    user_id = decode_access_token(token) if token else None
    user = session.get(User, user_id) if user_id is not None else None
    if user is None:
        raise HTTPException(status_code=401, detail="Требуется вход: раздел доступен только с профилем")
    return user


def current_active_user(user: User = Depends(current_user)) -> User:
    """R41.1: заблокированный администратором пользователь не может слать новые сообщения."""
    if user.is_blocked:
        raise HTTPException(
            status_code=403,
            detail="Аккаунт заблокирован администратором: новые отчёты не принимаются",
        )
    return user
