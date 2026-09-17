"""Вход и профиль (T05/M16): bootstrap-admin, пароль, dev, magic-link, Telegram."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..auth.service import (
    COOKIE_NAME,
    BootstrapConflict,
    BootstrapUnavailable,
    bootstrap_available,
    create_access_token,
    create_bootstrap_admin,
    create_magic_link_token,
    decode_magic_link_token,
    get_or_create_user,
    send_magic_link,
    verify_password,
    verify_telegram_login,
)
from ..core.config import settings
from ..db.models import User
from ..db.session import get_db
from .deps import optional_user, set_auth_cookie
from .schemas import (
    BootstrapAdminBody,
    DevLoginBody,
    MagicLinkBody,
    MagicVerifyBody,
    PasswordLoginBody,
)

router = APIRouter(prefix="/auth", tags=["auth"])


def _user_payload(user: User) -> dict:
    return {
        "id": user.id,
        "telegram_id": user.telegram_id,
        "email": user.email,
        "display_name": user.display_name,
        "role": user.role,
        "reliability_score": user.reliability_score,
    }


@router.get("/bootstrap")
def bootstrap_status(session: Session = Depends(get_db)) -> dict:
    """Public first-run probe used by the setup/login screen."""
    return {"required": bootstrap_available(session)}


@router.post("/bootstrap", status_code=201)
def bootstrap(
    body: BootstrapAdminBody,
    response: Response,
    session: Session = Depends(get_db),
) -> dict:
    """Create exactly one first administrator, then close bootstrap forever."""
    try:
        user = create_bootstrap_admin(
            session,
            display_name=body.display_name,
            email=body.email,
            password=body.password,
        )
    except BootstrapConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except BootstrapUnavailable as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except IntegrityError:
        session.rollback()
        raise HTTPException(status_code=409, detail="Первоначальная настройка уже завершена") from None
    set_auth_cookie(response.set_cookie, create_access_token(user.id))
    return {"user": _user_payload(user)}


@router.post("/login")
def password_login(
    body: PasswordLoginBody,
    response: Response,
    session: Session = Depends(get_db),
) -> dict:
    """Normal email/password login for bootstrapped accounts."""
    user = session.scalar(select(User).where(User.email == body.email).limit(1))
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Неверный email или пароль")
    if user.is_blocked:
        raise HTTPException(status_code=403, detail="Профиль заблокирован")
    set_auth_cookie(response.set_cookie, create_access_token(user.id))
    return {"user": _user_payload(user)}


@router.post("/dev-login")
def dev_login(body: DevLoginBody, response: Response, session: Session = Depends(get_db)) -> dict:
    """Dev-вход: активен, пока реальные каналы (Telegram/SMTP) не настроены (R97i)."""
    if not settings.debug or settings.smtp_url or settings.telegram_bot_token:
        raise HTTPException(status_code=403, detail="Dev-вход отключён: настроены реальные каналы входа")
    if not body.telegram_id and not body.email:
        raise HTTPException(status_code=422, detail="Укажите telegram_id или email")
    lookup = select(User).where(
        User.telegram_id == body.telegram_id if body.telegram_id else User.email == body.email
    )
    existing = session.scalar(lookup.limit(1))
    # Dev-вход создаёт/использует только обычные passwordless USER-профили.
    # Иначе знание email администратора в DEBUG-окружении превращается в обход
    # password/RBAC. Привилегированные аккаунты проходят обычный login.
    if existing is not None and (existing.role != "USER" or existing.password_hash):
        raise HTTPException(status_code=403, detail="Dev-вход недоступен для этого аккаунта: используйте обычный вход")
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
    set_auth_cookie(response.set_cookie, create_access_token(user.id))
    return {"user": _user_payload(user)}


@router.get("/me")
def me(user: User | None = Depends(optional_user)) -> dict:
    """Анонимный гость — 200 + {"user": null}; админская роль всегда читается из БД."""
    if user is None:
        return {"user": None}
    return {"user": _user_payload(user)}


@router.post("/logout")
def logout(response: Response) -> dict:
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}
