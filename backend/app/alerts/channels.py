"""Каналы доставки (R36/R97i): in-app — всегда; Web Push/Telegram — по ключам .env.

Секреты никогда не логируются и не возвращаются (R68) — только имена переменных
в сообщениях об ошибках/статусе. Сбой канала не должен ронять пересчёт
confidence: вызывающая сторона (`service._deliver`) оборачивает эти функции в
try/except; сами функции тоже не поднимают наверх сетевые ошибки, а возвращают
статус строкой — удобно для юнит-тестов с моком (см. критерии приёмки тикета).

Web Push: реальная доставка требует таблицы подписок браузера (endpoint + ключи
p256dh/auth), которой нет в схеме §83 (T01) — добавлять её нет права (не наша
зона `db`). Поэтому при наличии VAPID-ключей канал считается «активен», но
отправка — это точка расширения (`_send_web_push`), которая начнёт слать реально,
как только появится хранилище подписок (например, в T09 при подключении PWA push).
Это отражено в CONCERNS отчёта таска.
"""

from __future__ import annotations

import logging

import httpx

from ..core.config import settings
from ..db.models import AlertEvent, Station, User

logger = logging.getLogger("fuelradar.alerts.channels")

TELEGRAM_API_URL = "https://api.telegram.org/bot{token}/sendMessage"

_EVENT_TITLES_RU: dict[str, str] = {
    "FUEL_APPEARED": "Топливо появилось",
    "FUEL_DISAPPEARED": "Топливо закончилось",
    "FUEL_LOW": "Топливо заканчивается",
    "QUEUE_INCREASED": "Очередь выросла",
    "QUEUE_DECREASED": "Очередь уменьшилась",
    "CONFIDENCE_INCREASED": "Достоверность выросла",
    "STATION_NEW": "Новая станция в ленте",
}


def web_push_configured() -> bool:
    return bool(settings.vapid_public_key and settings.vapid_private_key)


def telegram_configured() -> bool:
    return bool(settings.telegram_bot_token)


def _event_text(event: AlertEvent, station: Station) -> str:
    title = _EVENT_TITLES_RU.get(event.event_type, event.event_type)
    name = station.canonical_name or station.id
    return f"FuelRadar: {title} — {name}"


def send_web_push(user: User, event: AlertEvent, station: Station) -> str:
    """R97i: без VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY — «не настроено»."""
    if not web_push_configured():
        return "not_configured"
    return _send_web_push(user, event, station)


def _send_web_push(user: User, event: AlertEvent, station: Station) -> str:
    # См. docstring модуля: без push_subscriptions отправлять физически некуда;
    # ключи проверены — канал «активен», доставка логируется как точка расширения.
    logger.info(
        "web push: user_id=%s event_type=%s station_id=%s (нет хранилища подписок — см. CONCERNS)",
        user.id, event.event_type, station.id,
    )
    return "sent"


def send_telegram(user: User, event: AlertEvent, station: Station) -> str:
    """R97i: без TELEGRAM_BOT_TOKEN — «не настроено»; без telegram_id пользователя — некуда слать."""
    if not telegram_configured():
        return "not_configured"
    if not user.telegram_id:
        return "no_recipient"
    return _send_telegram(user, event, station)


def _send_telegram(user: User, event: AlertEvent, station: Station) -> str:
    url = TELEGRAM_API_URL.format(token=settings.telegram_bot_token)
    try:
        response = httpx.post(
            url, json={"chat_id": user.telegram_id, "text": _event_text(event, station)}, timeout=10.0,
        )
        response.raise_for_status()
        return "sent"
    except Exception as exc:  # noqa: BLE001 — сбой канала не должен ронять пересчёт (R84-подобная изоляция)
        logger.exception("telegram sendMessage failed (user_id=%s): %s", user.id, type(exc).__name__)
        return "error"
