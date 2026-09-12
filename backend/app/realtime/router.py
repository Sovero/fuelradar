"""Realtime (T14, R64, §25): SSE-поток изменений данных для карты.

Бриф: «клиент может получать изменения посредством WebSocket или Server-Sent
Events». Выбран SSE — однонаправленный сервер→клиент поток идеально ложится на
задачу «сообщить клиенту, что данные изменились», не требует двустороннего
протокола, автоматически переподключается средствами EventSource и работает
через тот же HTTP-стек (прокси, Caddy, Electron-оболочка), что и остальной API.

Механика: каждое новое наблюдение/станция меняет `data_revision` (три max-id,
append-only R17) — генератор раз в `sse_poll_seconds` сравнивает revision и при
изменении шлёт событие `revision` (не дублируя весь список станций). Клиент по
`revision` переподтягивает `/stations` обычным кэшируемым GET (R82) — SSE не
дублирует отдачу данных, только сигнал. Браузер сам переподключается при обрыве;
при переподключении клиент приносит `Last-Event-ID`, сервер отвечает `revision`
сразу (не заставляя ждать следующий тик).

Heartbeat — комментарий `: ping` каждые ~15 с: прокси не режут idle-соединения,
а EventSource знает, что соединение живо.

Соединения ограничены `sse_max_clients` (предохранитель от исчерпания сокетов;
сверх лимита — 503 с честным сообщением).
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select

from ..core.config import settings
from ..db.models import FuelObservation, QueueObservation, Station
from ..db.session import SessionLocal

logger = logging.getLogger("fuelradar.realtime")

router = APIRouter(prefix="/realtime", tags=["realtime"])

# Подсчёт активных SSE — на уровне процесса (как core/metrics, R70: в проде
# api-процесс один за Caddy, соединения не делятся между процессами).
_active_sse = 0


def _revision_sync() -> tuple[str, str, str]:
    """Тот же расчёт, что `api.cache.data_revision`, но с короткоживущей сессией
    (держать транзакцию открытой минутами — неправильно; наблюдения append-only,
    поэтому max-id достаточен и автокоммит-чтение честно)."""
    with SessionLocal() as session:
        row = session.execute(
            select(
                select(func.max(Station.id)).scalar_subquery(),
                select(func.max(FuelObservation.id)).scalar_subquery(),
                select(func.max(QueueObservation.id)).scalar_subquery(),
            )
        ).one()
        return tuple(str(value) for value in row)


async def _sse_generator(request: Request, last_event_id: str | None):
    global _active_sse
    _active_sse += 1
    try:
        # 1. Начальное событие — сразу (не ждать первого тика): клиент после
        #    переподключения (Last-Event-ID) или первого входа получает revision.
        try:
            revision = await asyncio.to_thread(_revision_sync)
        except Exception:
            logger.exception("realtime: initial revision failed")
            revision = ("0", "0", "0")
        yield f"id: {last_event_id or '-'}\nevent: revision\ndata: {revision[0]}|{revision[1]}|{revision[2]}\n\n"

        poll = max(0.2, settings.sse_poll_seconds)
        max_seconds = max(30, settings.sse_max_seconds)
        heartbeat_every = max(1, int(15 / poll))
        started = asyncio.get_running_loop().time()
        ticks = 0
        while True:
            if await request.is_disconnected():
                return
            await asyncio.sleep(poll)
            ticks += 1
            elapsed = asyncio.get_running_loop().time() - started
            if elapsed >= max_seconds:
                # Честное завершение: EventSource переподключится сам (R64).
                yield "event: bye\ndata: rotate\n\n"
                return
            try:
                current = await asyncio.to_thread(_revision_sync)
            except Exception:
                logger.exception("realtime: revision poll failed")
                await asyncio.sleep(poll)
                continue
            if current != revision:
                revision = current
                yield f"id: {revision[0]}|{revision[1]}|{revision[2]}\nevent: revision\ndata: {revision[0]}|{revision[1]}|{revision[2]}\n\n"
            elif ticks % heartbeat_every == 0:
                yield ": ping\n\n"
    finally:
        _active_sse -= 1


@router.get("/stream")
async def stream(request: Request) -> StreamingResponse:
    global _active_sse
    if _active_sse >= max(1, settings.sse_max_clients):
        # Честный отказ вместо исчерпания сокетов; EventSource получит ошибку и
        # переподключится с backoff (браузерный алгоритм повторных попыток).
        raise HTTPException(status_code=503, detail="Слишком много активных realtime-подключений, попробуйте позже")
    last_event_id = request.headers.get("last-event-id")
    return StreamingResponse(
        _sse_generator(request, last_event_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # nginx/Caddy: не буферизовать поток
            "Connection": "keep-alive",
        },
    )
