"""Telegram-подписка: сводка доступности топлива по расписанию.

Пользователей в приложении нет — бот отправляет сводку в один чат, который задал
оператор (токен + chat_id в настройках приложения; `.env` даёт дефолты). Расписание
— интервал в минутах (``TELEGRAM_DIGEST_MINUTES`` или значение из UI); 0 выключает
рассылку. Токен наружу не отдаётся: API возвращает только маску-отпечаток (R68).

Доставка не дублируется: сводку берёт тот процесс, который первым захватил общий
лок воркера (``worker.locking.worker_lock``) — при запущенных api и worker
одновременно сообщение уйдёт один раз.

Чистые части (``build_digest_message``) и транспорт (``http_post``/``http_get``)
разделены, поэтому тесты идут без сети.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..core.config import settings
from ..db.models import AlertEvent, AppSetting, FuelType, Station, StationCurrentStatus

logger = logging.getLogger("fuelradar.digest")

TELEGRAM_SETTING_KEY = "telegram"
TELEGRAM_API = "https://api.telegram.org/bot{token}"
# В сообщении столько строк по топливу и столько названий станций без топлива.
MAX_FUEL_LINES = 8
MAX_DEFICIT_STATIONS = 5


@dataclass(slots=True)
class TelegramSettings:
    """Действующие параметры канала: UI переопределяет .env."""

    token: str
    chat_id: str
    interval_minutes: int

    @property
    def configured(self) -> bool:
        return bool(self.token and self.chat_id and self.interval_minutes > 0)


def token_fingerprint(token: str) -> str:
    """Короткий отпечаток токена — чтобы оператор узнавал, какой токен в работе."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:12] if token else ""


def _load_row(session: Session) -> dict[str, Any]:
    row = session.get(AppSetting, TELEGRAM_SETTING_KEY)
    return dict(row.value or {}) if row is not None else {}


def _store_row(session: Session, payload: dict[str, Any]) -> None:
    row = session.get(AppSetting, TELEGRAM_SETTING_KEY)
    if row is None:
        session.add(AppSetting(key=TELEGRAM_SETTING_KEY, value=payload))
    else:
        row.value = payload


def load_telegram_settings(session: Session) -> TelegramSettings:
    """Настройки канала: значения из UI, при отсутствии — из .env."""
    stored = _load_row(session)
    token = str(stored.get("token") or settings.telegram_bot_token or "").strip()
    chat_id = str(stored.get("chat_id") or settings.telegram_chat_id or "").strip()
    raw_interval = stored.get("interval_minutes", settings.telegram_digest_minutes)
    try:
        interval = int(raw_interval)
    except (TypeError, ValueError):
        interval = settings.telegram_digest_minutes
    return TelegramSettings(token=token, chat_id=chat_id, interval_minutes=max(0, interval))


def save_telegram_settings(
    session: Session,
    *,
    token: str | None = None,
    chat_id: str | None = None,
    interval_minutes: int | None = None,
) -> TelegramSettings:
    """Сохранить настройки канала. Пустая строка токена/чата — очистить значение."""
    stored = _load_row(session)
    if token is not None:
        if token.strip():
            stored["token"] = token.strip()
        else:
            stored.pop("token", None)
    if chat_id is not None:
        if chat_id.strip():
            stored["chat_id"] = chat_id.strip()
        else:
            stored.pop("chat_id", None)
    if interval_minutes is not None:
        stored["interval_minutes"] = max(0, int(interval_minutes))
    _store_row(session, stored)
    session.commit()
    return load_telegram_settings(session)


def public_state(session: Session, *, now: datetime | None = None) -> dict[str, Any]:
    """Состояние канала для API: без токена, но с отпечатком и расписанием."""
    current = load_telegram_settings(session)
    stored = _load_row(session)
    last_sent_at = stored.get("last_sent_at")
    next_send_at = None
    if current.configured and last_sent_at:
        try:
            sent = datetime.fromisoformat(str(last_sent_at))
            next_send_at = (sent + timedelta(minutes=current.interval_minutes)).isoformat()
        except ValueError:
            next_send_at = None
    return {
        "configured": current.configured,
        "has_token": bool(current.token),
        "token_fingerprint": token_fingerprint(current.token),
        "token_from_env": bool(not stored.get("token") and settings.telegram_bot_token),
        "chat_id": current.chat_id or None,
        "interval_minutes": current.interval_minutes,
        "last_sent_at": last_sent_at,
        "last_status": stored.get("last_status"),
        "next_send_at": next_send_at,
        "now": (now or _now()).isoformat(),
    }


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _default_http_post(url: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Реальный транспорт Telegram. В тестах заменяется фикстурой."""
    import httpx

    response = httpx.post(url, json=payload, timeout=15.0)
    response.raise_for_status()
    return response.json()


def _default_http_get(url: str) -> dict[str, Any]:
    import httpx

    response = httpx.get(url, timeout=15.0)
    response.raise_for_status()
    return response.json()


def send_telegram_message(
    token: str,
    chat_id: str,
    text: str,
    *,
    http_post: Callable[[str, dict[str, Any]], dict[str, Any]] | None = None,
) -> tuple[bool, str]:
    """Отправить текст в чат. Возвращает (успех, причина) — без исключений наружу."""
    if not token or not chat_id:
        return False, "not_configured"
    # Транспорт ищем в модуле и на момент вызова: так monkeypatch.setattr(digest,
    # "_default_http_post", ...) работает без передачи параметра в каждый вызов.
    post = http_post or globals()["_default_http_post"]
    url = f"{TELEGRAM_API.format(token=token)}/sendMessage"
    try:
        payload = post(url, {"chat_id": chat_id, "text": text[:4000], "disable_web_page_preview": True})
    except Exception as exc:  # noqa: BLE001 — сбой канала не должен ронять вызывающего
        logger.warning("telegram send failed: %s", type(exc).__name__)
        return False, "error"
    # Транспорт может вернуть и «голый» dict, и httpx-Response (с .json()) —
    # принимаем оба контракта, иначе тесты и альтернативные клиенты ложно «rejected».
    if payload is not None and not isinstance(payload, dict) and hasattr(payload, "json"):
        try:
            payload = payload.json()
        except Exception:  # noqa: BLE001 — не-JSON ответ трактуем как отказ
            payload = None
    if not isinstance(payload, dict) or not payload.get("ok"):
        description = ""
        if isinstance(payload, dict):
            description = str(payload.get("description") or "")[:200]
        logger.warning("telegram rejected message: %s", description)
        return False, "rejected"
    return True, "sent"


def fetch_chat_id(
    token: str,
    *,
    http_get: Callable[[str], dict[str, Any]] | None = None,
) -> tuple[str | None, str]:
    """Найти chat_id по последним сообщениям бота (getUpdates).

    Оператор пишет боту любое сообщение (например ``/start``), после чего приложение
    само определяет чат — не нужно вручную искать числовой id.
    """
    if not token:
        return None, "not_configured"
    get = http_get or globals()["_default_http_get"]
    try:
        payload = get(f"{TELEGRAM_API.format(token=token)}/getUpdates?limit=20")
    except Exception as exc:  # noqa: BLE001 — сеть/токен не роняют API
        logger.warning("telegram getUpdates failed: %s", type(exc).__name__)
        return None, "error"
    if not isinstance(payload, dict) or not payload.get("ok"):
        return None, "rejected"
    updates = payload.get("result") or []
    for update in reversed(list(updates)):
        message = (update or {}).get("message") or (update or {}).get("edited_message") or {}
        chat = message.get("chat") or {}
        chat_id = chat.get("id")
        if chat_id is not None:
            return str(chat_id), "ok"
    return None, "no_updates"


def build_digest_message(
    session: Session,
    *,
    now: datetime | None = None,
    since: datetime | None = None,
) -> str:
    """Сводка: сколько где доступно, что изменилось с прошлой отправки, где дефицит."""
    moment = now or _now()
    since_moment = since
    stored = _load_row(session)
    if since_moment is None and stored.get("last_sent_at"):
        try:
            since_moment = datetime.fromisoformat(str(stored["last_sent_at"]))
        except ValueError:
            since_moment = None

    station_total = session.scalar(select(func.count()).select_from(Station)) or 0
    lines = [f"FuelRadar — сводка {moment:%d.%m %H:%M}", f"Станции в каталоге: {station_total}"]

    rows = session.execute(
        select(FuelType.display_name_ru, StationCurrentStatus.status, func.count())
        .join(FuelType, FuelType.id == StationCurrentStatus.fuel_type_id)
        .group_by(FuelType.display_name_ru, StationCurrentStatus.status)
    ).all()
    by_fuel: dict[str, dict[str, int]] = {}
    for fuel_name, status, count in rows:
        by_fuel.setdefault(fuel_name, {})[status] = int(count)
    if by_fuel:
        lines.append("")
        for fuel_name, counts in sorted(by_fuel.items(), key=lambda item: -sum(item[1].values()))[:MAX_FUEL_LINES]:
            available = counts.get("AVAILABLE", 0)
            likely = counts.get("LIKELY_AVAILABLE", 0)
            unavailable = counts.get("UNAVAILABLE", 0)
            unknown = counts.get("UNKNOWN", 0)
            lines.append(
                f"{fuel_name}: есть {available}, вероятно есть {likely}, нет {unavailable}, нет данных {unknown}"
            )

    if since_moment is not None:
        changed = session.execute(
            select(AlertEvent.event_type, func.count())
            .where(AlertEvent.created_at >= since_moment)
            .group_by(AlertEvent.event_type)
        ).all()
        stats = {event_type: int(count) for event_type, count in changed}
        appeared = stats.get("FUEL_APPEARED", 0) + stats.get("STATION_NEW", 0)
        disappeared = stats.get("FUEL_DISAPPEARED", 0) + stats.get("FUEL_LOW", 0)
        if appeared or disappeared:
            lines.append("")
            lines.append(f"С прошлой сводки: появилось {appeared}, закончилось {disappeared}")

    deficit_rows = session.execute(
        select(Station.canonical_name, Station.id)
        .where(
            ~Station.id.in_(
                select(StationCurrentStatus.station_id).where(StationCurrentStatus.status == "AVAILABLE")
            )
        )
        .limit(MAX_DEFICIT_STATIONS + 1)
    ).all()
    deficit_total = session.scalar(
        select(func.count()).select_from(
            select(Station.id)
            .where(
                ~Station.id.in_(
                    select(StationCurrentStatus.station_id).where(StationCurrentStatus.status == "AVAILABLE")
                )
            )
            .subquery()
        )
    ) or 0
    if deficit_total:
        lines.append("")
        names = ", ".join(name or station_id for name, station_id in deficit_rows[:MAX_DEFICIT_STATIONS])
        tail = "" if deficit_total <= MAX_DEFICIT_STATIONS else " …"
        lines.append(f"Без подтверждённого топлива ({deficit_total}): {names}{tail}")

    if settings.public_app_url:
        lines.append("")
        lines.append(settings.public_app_url)
    return "\n".join(lines)


def send_test_message(
    session: Session,
    *,
    http_post: Callable[[str, dict[str, Any]], dict[str, Any]] | None = None,
    now: datetime | None = None,
) -> tuple[bool, str]:
    """Отправить сводку прямо сейчас (кнопка «Проверить» в настройках)."""
    current = load_telegram_settings(session)
    if not current.token:
        return False, "no_token"
    if not current.chat_id:
        return False, "no_chat"
    text = build_digest_message(session, now=now)
    ok, reason = send_telegram_message(current.token, current.chat_id, text, http_post=http_post)
    _record_send(session, ok, reason)
    return ok, reason


def _record_send(session: Session, ok: bool, reason: str, *, now: datetime | None = None) -> None:
    stored = _load_row(session)
    stored["last_status"] = reason
    if ok:
        stored["last_sent_at"] = (now or _now()).isoformat()
    _store_row(session, stored)
    session.commit()


def digest_due(settings_now: TelegramSettings, stored: dict[str, Any], now: datetime) -> bool:
    """Пора ли отправлять: интервал считается от последней успешной отправки."""
    if not settings_now.configured:
        return False
    last_sent_at = stored.get("last_sent_at")
    if not last_sent_at:
        return True
    try:
        sent = datetime.fromisoformat(str(last_sent_at))
    except ValueError:
        return True
    return now - sent >= timedelta(minutes=settings_now.interval_minutes)


def maybe_send_digest(
    session: Session,
    *,
    now: datetime | None = None,
    http_post: Callable[[str, dict[str, Any]], dict[str, Any]] | None = None,
) -> str:
    """Отправить сводку, если пришло время. Возвращает статус для логов/тестов."""
    moment = now or _now()
    current = load_telegram_settings(session)
    if not current.token or not current.chat_id:
        return "not_configured"
    if current.interval_minutes <= 0:
        return "disabled"
    if not digest_due(current, _load_row(session), moment):
        return "not_due"

    text = build_digest_message(session, now=moment)
    ok, reason = send_telegram_message(current.token, current.chat_id, text, http_post=http_post)
    _record_send(session, ok, reason, now=moment)
    if ok:
        logger.info("telegram digest sent to chat %s", current.chat_id)
    return "sent" if ok else reason


def parse_json(raw: str) -> dict[str, Any]:
    """Разбор ответа Telegram — вынесен для тестов."""
    try:
        payload = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}
