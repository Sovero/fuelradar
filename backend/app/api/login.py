"""Вход и профиль (T05, §15, R06/R65): dev-вход, magic-link, Telegram-заглушка."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from ..auth.service import (
    COOKIE_NAME,
    create_access_token,
    create_magic_link_token,
    decode_magic_link_token,
    get_or_create_user,
    send_magic_link,
    verify_telegram_login,
)
from ..core.config import settings
from ..db.models import User
from ..db.session import get_db
from .deps import optional_user, set_auth_cookie
from .schemas import DevLoginBody, MagicLinkBody, MagicVerifyBody

router = APIRouter(prefix="/auth", tags=["auth"])


def _user_payload(user: User) -> dict:
    return {"id": user.id, "telegram_id": user.telegram_id, "email": user.email, "reliability_score": user.reliability_score}


@router.post("/dev-login")
def dev_login(body: DevLoginBody, response: Response, session: Session = Depends(get_db)) -> dict:
    """Dev-вход: активен, пока реальные каналы (Telegram/SMTP) не настроены (R97i)."""
    if not settings.debug or settings.smtp_url or settings.telegram_bot_token:
        raise HTTPException(status_code=403, detail="Dev-вход отключён: настроены реальные каналы входа")
    if not body.telegram_id and not body.email:
        raise HTTPException(status_code=422, detail="Укажите telegram_id или email")
    user = get_or_create_user(session, telegram_id=body.telegram_id, email=body.email)
    if user.is_blocked:
        raise HTTPException(status_code=403, detail="Профиль заблокирован")
    set_auth_cookie(response.set_cookie, create_access_token(user.id))
    return {
        "user": _user_payload(user),
        "note": "dev-вход: активен, пока не настроены SMTP_URL/TELEGRAM_BOT_TOKEN",
    }


@router.post("/magic-link")
def magic_link(body: MagicLinkBody, session: Session = Depends(get_db)) -> dict:
    """R06: email magic-link. Без SMTP_URL — честное «не настроено»."""
    if not settings.smtp_url:
        raise HTTPException(status_code=503, detail="Вход по email не настроен: задайте SMTP_URL в .env")
    token = create_magic_link_token(body.email)
    try:
        send_magic_link(body.email, token)
    except (OSError, ValueError):
        raise HTTPException(status_code=503, detail="Не удалось отправить письмо, повторите позже") from None
    return {"sent": True, "note": "письмо со ссылкой отправлено"}


@router.post("/verify")
def verify(body: MagicVerifyBody, response: Response, session: Session = Depends(get_db)) -> dict:
    """Подтверждение magic-link: обмен токена на cookie-сессию."""
    email = decode_magic_link_token(body.token)
    if email is None:
        raise HTTPException(status_code=401, detail="Ссылка недействительна или устарела")
    user = get_or_create_user(session, email=email)
    if user.is_blocked:
        raise HTTPException(status_code=403, detail="Профиль заблокирован")
    set_auth_cookie(response.set_cookie, create_access_token(user.id))
    return {"user": _user_payload(user)}


@router.post("/telegram")
def telegram_login(response: Response, body: dict[str, str | int] | None = None, session: Session = Depends(get_db)) -> dict:
    """Вход через Telegram активируется ключом TELEGRAM_BOT_TOKEN (R97i)."""
    if not settings.telegram_bot_token:
        raise HTTPException(status_code=503, detail="Вход через Telegram не настроен: задайте TELEGRAM_BOT_TOKEN в .env")
    telegram_id = verify_telegram_login(body or {})
    if telegram_id is None:
        raise HTTPException(status_code=401, detail="Подпись Telegram недействительна или устарела")
    user = get_or_create_user(session, telegram_id=telegram_id)
    if user.is_blocked:
        raise HTTPException(status_code=403, detail="Профиль заблокирован")
    if user.is_blocked:
        raise HTTPException(status_code=403, detail="Профиль заблокирован")
    set_auth_cookie(response.set_cookie, create_access_token(user.id))
    return {"user": _user_payload(user)}


@router.get("/me")
def me(request: Request, user: User | None = Depends(optional_user)) -> dict:
    if user is None:
        raise HTTPException(status_code=401, detail="Нет активной сессии")
    return {"user": _user_payload(user)}


@router.post("/logout")
def logout(response: Response) -> dict:
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}
