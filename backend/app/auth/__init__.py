"""Пакет аутентификации (T05/M16): cookie-сессии, bootstrap-admin, пароль, Telegram."""

from .service import (
    COOKIE_NAME,
    MAGIC_TTL_MINUTES,
    TOKEN_TTL_DAYS,
    BootstrapConflict,
    BootstrapUnavailable,
    bootstrap_available,
    create_access_token,
    create_bootstrap_admin,
    create_magic_link_token,
    decode_access_token,
    decode_magic_link_token,
    get_or_create_user,
    hash_password,
    jwt_secret,
    verify_password,
)

__all__ = [
    "COOKIE_NAME",
    "MAGIC_TTL_MINUTES",
    "TOKEN_TTL_DAYS",
    "BootstrapConflict",
    "BootstrapUnavailable",
    "bootstrap_available",
    "create_access_token",
    "create_bootstrap_admin",
    "create_magic_link_token",
    "decode_access_token",
    "decode_magic_link_token",
    "get_or_create_user",
    "hash_password",
    "jwt_secret",
    "verify_password",
]
