"""Аутентификация (T05/M16): cookie-сессии, bootstrap-admin, пароль, dev, magic-link, Telegram.

Карта и поиск анонимны (R65); персонализация — только с профилем.
Пароли хранятся как salted scrypt-хэши (стойкий эквивалент Argon2id без
дополнительной runtime-зависимости). Административный доступ определяется
ролью пользователя в cookie-сессии, статический admin-token не используется.
"""

from __future__ import annotations

import base64
import binascii
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
from sqlalchemy import exists, select, update
from sqlalchemy.orm import Session

from ..core.config import settings
from ..db.models import AdminActionLog, BootstrapState, User, _now

COOKIE_NAME = "fr_session"
TOKEN_TTL_DAYS = 7
MAGIC_TTL_MINUTES = 15
ALGORITHM = "HS256"
USER_ROLES = frozenset({"USER", "OPERATOR", "ADMIN"})

# scrypt parameters are deliberately encoded into the stored value so a future
# parameter change can coexist with hashes created by older deployments.
_SCRYPT_N = 2**14
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_DKLEN = 64

_ephemeral_secret: str | None = None


def hash_password(password: str) -> str:
    """Return a self-describing salted scrypt password hash.

    The raw password never leaves this function and is never logged or persisted.
    """
    if not password:
        raise ValueError("пароль не может быть пустым")
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=_SCRYPT_DKLEN,
    )
    return "$scrypt$" + "$".join(
        [
            f"n={_SCRYPT_N},r={_SCRYPT_R},p={_SCRYPT_P}",
            base64.urlsafe_b64encode(salt).decode("ascii").rstrip("="),
            base64.urlsafe_b64encode(digest).decode("ascii").rstrip("="),
        ]
    )


def verify_password(password: str, encoded: str | None) -> bool:
    """Verify a stored scrypt hash without disclosing why authentication failed."""
    if not password or not encoded or not encoded.startswith("$scrypt$"):
        return False
    try:
        _, _, parameters, salt_text, digest_text = encoded.split("$", 4)
        values = dict(part.split("=", 1) for part in parameters.split(","))
        n = int(values["n"])
        r = int(values["r"])
        p = int(values["p"])
        salt = base64.urlsafe_b64decode(salt_text + "=" * (-len(salt_text) % 4))
        expected = base64.urlsafe_b64decode(digest_text + "=" * (-len(digest_text) % 4))
        if n < 2**12 or n > 2**20 or r < 1 or r > 32 or p < 1 or p > 8:
            return False
        actual = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p, dklen=len(expected))
    except (ValueError, TypeError, KeyError, UnicodeError, binascii.Error, OverflowError):
        return False
    return hmac.compare_digest(actual, expected)


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


def create_access_token_for_user(user: User) -> str:
    """Create a session token from the database identity.

    Roles are deliberately not embedded in the JWT: every protected request
    reloads the user, so a role change or block takes effect immediately.
    """
    return create_access_token(user.id)


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


class BootstrapUnavailable(Exception):
    """The one-time bootstrap window is already closed."""


class BootstrapConflict(Exception):
    """Bootstrap data conflicts with an existing account."""



def bootstrap_available(session: Session) -> bool:
    """Return whether the first-admin setup window is still open."""
    state = session.get(BootstrapState, 1)
    admin_exists = session.scalar(select(User.id).where(User.role == "ADMIN").limit(1)) is not None
    return not admin_exists and not (state.completed if state else False)


def create_bootstrap_admin(
    session: Session,
    *,
    display_name: str,
    email: str,
    password: str,
) -> User:
    """Atomically claim the one-time bootstrap window and create the first admin.

    The conditional UPDATE is the concurrency guard: only one transaction can
    change the singleton from ``completed=false`` while no ADMIN exists. If
    validation or persistence fails, the transaction is rolled back and the
    setup window remains available.
    """
    existing = session.scalar(select(User.id).where(User.email == email).limit(1))
    if existing is not None:
        raise BootstrapConflict("Пользователь с таким email уже существует")

    state = session.get(BootstrapState, 1)
    if state is None:
        state = BootstrapState(id=1, completed=False)
        session.add(state)
        session.flush()

    claimed = session.execute(
        update(BootstrapState)
        .where(
            BootstrapState.id == 1,
            BootstrapState.completed.is_(False),
            ~exists(select(User.id).where(User.role == "ADMIN")),
        )
        .values(completed=True, completed_at=_now())
    ).rowcount
    if claimed != 1:
        session.rollback()
        raise BootstrapUnavailable("Первоначальная настройка уже завершена")

    user = User(
        display_name=display_name,
        email=email,
        role="ADMIN",
        password_hash=hash_password(password),
    )
    session.add(user)
    session.flush()
    session.add(
        AdminActionLog(
            actor="bootstrap",
            action="bootstrap_admin_created",
            target_type="user",
            target_id=str(user.id),
            payload={"role": "ADMIN", "email": email},
        )
    )
    session.commit()
    return user


def get_or_create_user(session: Session, *, telegram_id: str | None = None, email: str | None = None) -> User:
    """Найти или создать пользователя (R06); новые внешние аккаунты — USER."""
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
