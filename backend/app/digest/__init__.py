"""Telegram-дайджест (подписка на события без пользователей)."""

from .service import (
    TELEGRAM_SETTING_KEY,
    TelegramSettings,
    build_digest_message,
    digest_due,
    fetch_chat_id,
    load_telegram_settings,
    maybe_send_digest,
    public_state,
    save_telegram_settings,
    send_telegram_message,
    send_test_message,
    token_fingerprint,
)

__all__ = [
    "TELEGRAM_SETTING_KEY",
    "TelegramSettings",
    "build_digest_message",
    "digest_due",
    "fetch_chat_id",
    "load_telegram_settings",
    "maybe_send_digest",
    "public_state",
    "save_telegram_settings",
    "send_telegram_message",
    "send_test_message",
    "token_fingerprint",
]
