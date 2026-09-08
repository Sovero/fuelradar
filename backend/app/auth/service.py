"""Аутентификация (T05, §15, R65/R95i): JWT в httpOnly-cookie, dev-вход, magic-link.

Карта и поиск анонимны (R65); персонализация — только с профилем. Каналы входа
активируются ключами из .env: без TELEGRAM_BOT_TOKEN/SMTP_URL работает dev-вход.
Секрет JWT — из .env (R68); пусто → эфемерный на процесс (достаточно для dev).
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import smtplib
import ssl
import time
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from urllib.parse import unquote, urlencode, urlparse

import jwt
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core.config import settings
from ..db.models import User

COOKIE_NAME = "fr_session"
TOKEN_TTL_DAYS = 7
MAGIC_TTL_MINUTES = 15
ALGORITHM = "HS256"

_ephemeral_secret: str | None = None


def jwt_secret() -> str:
    """Секрет подписи: из .env; если пуст — один эфемерный на процесс."""
    global _ephemeral_secret
    if settings.jwt_secret:
        return settings.jwt_secret
    if _ephemeral_secret is None:
        _ephemeral_secret = secrets.token_hex(32)
    return _ephemeral_secret


def create_access_token(user_id: int) -> str:
    payload = {
        "sub": str(user_id),
        "exp": datetime.now(UTC) + timedelta(days=TOKEN_TTL_DAYS),
    }
    return jwt.encode(payload, jwt_secret(), algorithm=ALGORITHM)


def decode_access_token(token: str) -> int | None:
    try:
        payload = jwt.decode(token, jwt_secret(), algorithms=[ALGORITHM])
        return int(payload["sub"])
    except (jwt.InvalidTokenError, KeyError, TypeError, ValueError):
        return None


def create_magic_link_token(email: str) -> str:
    payload = {
        "email": email,
        "purpose": "magic",
        "exp": datetime.now(UTC) + timedelta(minutes=MAGIC_TTL_MINUTES),
    }
    return jwt.encode(payload, jwt_secret(), algorithm=ALGORITHM)


def decode_magic_link_token(token: str) -> str | None:
    try:
        payload = jwt.decode(token, jwt_secret(), algorithms=[ALGORITHM])
    except jwt.InvalidTokenError:
        return None
    if payload.get("purpose") != "magic" or not payload.get("email"):
        return None
    return str(payload["email"])


def get_or_create_user(session: Session, *, telegram_id: str | None = None, email: str | None = None) -> User:
    """Найти или создать пользователя (R06): по telegram_id или email."""
    user: User | None = None
    if telegram_id:
        user = session.scalar(select(User).where(User.telegram_id == telegram_id))
    elif email:
        user = session.scalar(select(User).where(User.email == email))
    if user is None:
        user = User(telegram_id=telegram_id, email=email)
        session.add(user)
        session.commit()  # фиксируем сразу: сессия Depends(get_db) иначе откатится при закрытии
    return user


def send_magic_link(email: str, token: str) -> None:
    """Send a sign-in link using the configured SMTP transport."""
    url = urlparse(settings.smtp_url)
    if url.scheme not in {"smtp", "smtps"} or not url.hostname:
        raise ValueError("Invalid SMTP configuration")
    message = EmailMessage()
    message["Subject"] = "Вход в FuelRadar"
    message["From"] = settings.smtp_from
    message["To"] = email
    link = settings.public_app_url.rstrip("/") + "/auth/verify?" + urlencode({"token": token})
    message.set_content("Ссылка для входа (действует 15 минут): " + link)
    transport = smtplib.SMTP_SSL if url.scheme == "smtps" else smtplib.SMTP
    with transport(url.hostname, url.port or (465 if url.scheme == "smtps" else 587), timeout=15) as smtp:
        if url.scheme == "smtp":
            smtp.starttls(context=ssl.create_default_context())
        if url.username:
            smtp.login(unquote(url.username), unquote(url.password or ""))
        smtp.send_message(message)


def verify_telegram_login(data: dict[str, str | int]) -> str | None:
    """Verify Telegram Login Widget HMAC and reject stale payloads."""
    try:
        auth_date = int(data["auth_date"])
        telegram_id = str(int(data["id"]))
        signature = str(data["hash"])
    except (KeyError, TypeError, ValueError):
        return None
    if not 0 <= time.time() - auth_date <= 86400:
        return None
    check = "\n".join(f"{key}={value}" for key, value in sorted(data.items()) if key != "hash")
    secret = hashlib.sha256(settings.telegram_bot_token.encode()).digest()
    expected = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return telegram_id if hmac.compare_digest(signature, expected) else None
