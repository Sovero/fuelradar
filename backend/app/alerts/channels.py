"""Каналы доставки (R36/R97i): in-app — всегда; Web Push — по ключам .env.

Telegram здесь не доставляется: с уходом пользователей это канал-подписка
одного чата по расписанию (см. app/digest/service.py), а не адресная доставка
события конкретному профилю.

Секреты никогда не логируются и не возвращаются (R68) — только имена переменных
в сообщениях об ошибках/статусе. Сбой канала не должен ронять пересчёт
confidence: вызывающая сторона (`service._deliver`) оборачивает эти функции в
try/except; сами функции тоже не поднимают наверх сетевые ошибки, а возвращают
статус строкой — удобно для юнит-тестов с моком (см. критерии приёмки тикета).

Web Push (T14): реальная доставка через pywebpush (Web Push Protocol, VAPID).
Подписки живут в push_subscriptions (T14); каждая отправка изолирована — ошибка
одной подписки не отменяет остальные. Push-сервис отвечает 404/410 на протухшую
подписку — она деактивируется (источник честного «почистить»), 4xx/5xx —
записываются в last_error без выставления is_active=False (может быть
временной: rate limit push-сервиса).
"""

from __future__ import annotations

import json
import logging

from ..core.config import settings
from ..db.models import AlertEvent, Station

logger = logging.getLogger("fuelradar.alerts.channels")

# pywebpush — заявленная зависимость (requirements.txt); на случай окружения без
# неё канал честно вернёт "error", а не уронит импорт всего alerts.
try:
    from pywebpush import WebPushException
    from pywebpush import webpush as _webpush_call
except ImportError:  # pragma: no cover — окружение без зависимости
    _webpush_call = None
    WebPushException = Exception

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


def _event_text(event: AlertEvent, station: Station) -> str:
    title = _EVENT_TITLES_RU.get(event.event_type, event.event_type)
    name = station.canonical_name or station.id
    return f"FuelRadar: {title} — {name}"


def send_web_push(event: AlertEvent, station: Station) -> str:
    """R97i: без VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY — «не настроено»."""
    if not web_push_configured():
        return "not_configured"
    return _send_web_push(event, station)


def _push_payload(event: AlertEvent, station: Station) -> dict:
    """Полезная нагрузка push-уведомления (показывается в SW-уведомлении)."""
    return {
        "title": _EVENT_TITLES_RU.get(event.event_type, event.event_type),
        "body": station.canonical_name or station.id,
        "station_id": station.id,
        "event_type": event.event_type,
    }


def _send_web_push(event: AlertEvent, station: Station) -> str:
    """Отправка всем активным подпискам приложения (T14).

    Возвращает агрегированный статус: not_configured | sent | partial | error.
    Ошибка одной подписки не отменяет остальные (R84-подобная изоляция).
    Сессия открывается локально: channels вызывается из горячего пути
    evaluate_rules, где родительская сессия в незакоммиченной транзакции.
    """
    from sqlalchemy import select

    from ..db.models import PushSubscription
    from ..db.session import SessionLocal

    with SessionLocal() as session:
        subscriptions = session.scalars(
            select(PushSubscription).where(PushSubscription.is_active.is_(True))
        ).all()
        if not subscriptions:
            return "no_subscriptions"

        payload = json.dumps(_push_payload(event, station), ensure_ascii=False)
        results = [_send_one_web_push(session, row, payload) for row in subscriptions]
        session.commit()
        # Честно: уведомление доставлено, если дошла хотя бы одна подписка;
        # ошибки отдельных подписок изолированы и видны в push_subscriptions.last_error.
        return "sent" if any(status == "sent" for status in results) else "error"


def _send_one_web_push(session, row, payload: str) -> str:
    """Одна отправка (Web Push Protocol, RFC 8291/8292, aes128gcm).

    404/410 → подписка протухла (браузер её удалил/ротировал), деактивируем —
    источник честной очистки; прочие ошибки — last_error, is_active не трогаем
    (может быть временной: rate limit push-сервиса, сеть).
    """
    from datetime import UTC, datetime

    if _webpush_call is None:  # pragma: no cover — окружение без зависимости
        row.last_error = "pywebpush-missing"
        return "error"
    now = datetime.now(UTC).replace(tzinfo=None)
    try:
        _webpush_call(
            subscription_info={
                "endpoint": row.endpoint,
                "keys": {"p256dh": row.p256dh, "auth": row.auth},
            },
            data=payload,
            vapid_private_key=settings.vapid_private_key,
            # VAPID-заявки: sub обязателен (mailto), aud/ exp pywebpush ставит сам
            # из endpoint. Публичные данные — не секрет (R68).
            vapid_claims={"sub": f"mailto:{settings.smtp_from}"},
            ttl=3600,
            timeout=10.0,
        )
    except WebPushException as error:
        response = getattr(error, "response", None)
        code = getattr(response, "status_code", None)
        if code in (404, 410):
            row.is_active = False
            row.last_error = f"gone:{code}"
            logger.info("web push: subscription %s gone (%s) — деактивирована", row.id, code)
        else:
            row.last_error = f"{type(error).__name__}:{code or ''}"[:256]
            logger.warning("web push: subscription %s failed: %s", row.id, type(error).__name__)
        return "error"
    except Exception as error:  # noqa: BLE001 — сеть/сбой не роняет остальные подписки
        row.last_error = f"{type(error).__name__}"[:256]
        logger.warning("web push: subscription %s unexpected: %s", row.id, type(error).__name__)
        return "error"
    row.last_success_at = now
    row.last_error = ""
    return "sent"



