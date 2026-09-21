"""Настройки приложения (R64): Telegram-дайджест — подписка на события по расписанию.

Пользователей нет, вход не нужен: настройки правит тот, кто запустил приложение.
Токен бота никогда не отдаётся наружу — только отпечаток, чтобы оператор понимал,
какой именно токен в работе (R68).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.session import get_db
from ..digest import service as digest
from .schemas import TelegramSettingsBody

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("/telegram")
def telegram_state(session: Session = Depends(get_db)) -> dict:
    """Текущее состояние канала: настроен ли, какой отпечаток токена, когда следующая отправка."""
    return digest.public_state(session)


@router.put("/telegram")
def telegram_update(body: TelegramSettingsBody, session: Session = Depends(get_db)) -> dict:
    """Сохранить токен/чат/интервал. Пустая строка очищает значение (возврат к .env)."""
    digest.save_telegram_settings(
        session,
        token=body.token,
        chat_id=body.chat_id,
        interval_minutes=body.interval_minutes,
    )
    return digest.public_state(session)


@router.post("/telegram/discover")
def telegram_discover(session: Session = Depends(get_db)) -> dict:
    """Определить chat_id по последним сообщениям бота (getUpdates) и сохранить его.

    Оператору достаточно написать боту любое сообщение — числовой id искать вручную
    не нужно. Нет сообщений/неверный токен — честная причина, а не выдуманный id.
    """
    current = digest.load_telegram_settings(session)
    if not current.token:
        raise HTTPException(status_code=400, detail="Сначала укажите токен бота")
    chat_id, reason = digest.fetch_chat_id(current.token)
    if chat_id is None:
        detail = {
            "no_updates": "Бот не получил ни одного сообщения — напишите ему в Telegram и повторите",
            "error": "Telegram не ответил — проверьте токен и доступ в сеть",
            "rejected": "Telegram отклонил запрос — проверьте токен бота",
        }.get(reason, "Не удалось определить чат")
        return {"ok": False, "reason": reason, "detail": detail, "state": digest.public_state(session)}
    digest.save_telegram_settings(session, chat_id=chat_id)
    return {"ok": True, "reason": "ok", "chat_id": chat_id, "state": digest.public_state(session)}


@router.post("/telegram/test")
def telegram_test(session: Session = Depends(get_db)) -> dict:
    """Отправить сводку прямо сейчас — ручная проверка канала."""
    ok, reason = digest.send_test_message(session)
    detail = {
        "no_token": "Токен бота не задан",
        "no_chat": "Чат не определён — напишите боту и нажмите «Определить чат»",
        "error": "Не удалось отправить: Telegram не ответил",
        "rejected": "Telegram отклонил сообщение: проверьте, что бот не заблокирован получателем",
    }.get(reason)
    return {"ok": ok, "reason": reason, "detail": detail, "state": digest.public_state(session)}
