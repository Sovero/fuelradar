"""Пакет аутентификации (T05): JWT, cookie-сессии, dev-вход, magic-link."""

from .service import (
    COOKIE_NAME,
    MAGIC_TTL_MINUTES,
    TOKEN_TTL_DAYS,
    create_access_token,
    create_magic_link_token,
    decode_access_token,
    decode_magic_link_token,
    get_or_create_user,
    jwt_secret,
)

__all__ = [
    "COOKIE_NAME",
    "MAGIC_TTL_MINUTES",
    "TOKEN_TTL_DAYS",
    "create_access_token",
    "create_magic_link_token",
    "decode_access_token",
    "decode_magic_link_token",
    "get_or_create_user",
    "jwt_secret",
]
