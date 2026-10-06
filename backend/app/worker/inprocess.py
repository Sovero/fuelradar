"""Сбор по расписанию внутри процесса API (встроенный backend десктоп-сборки).

Зачем: в установленном приложении оболочка запускает ровно один процесс —
встроенный backend, отдельного `python -m app.worker` там нет. Без сбора каталог
«остывает»: TTL статусов истекает (R72), и через пару часов все АЗС стали бы
UNKNOWN, а кнопка «Обновить источник» в админке ставила бы `CollectionJob`,
который никто не исполняет.

Поэтому тот же процесс раз в `WORKER_TICK_SECONDS` выполняет один цикл сбора
(`Worker.run_once`: план → задания → сбор → пересчёт статусов → дайджест). Лок —
общий (`worker.locking.worker_lock`): если рядом всё-таки работает настоящий
воркер, тик просто не получит лок и ничего не сделает — дублей нет.

R83 не нарушается: расписание фоновое, HTTP-запрос никогда не запускает сбор
синхронно (как и `POST /admin/sources/{id}/refresh`). Включается настройкой
`COLLECT_IN_PROCESS` (по умолчанию выключено: в серверных развёртываниях сбор
ведёт `python -m app.worker`) — её выставляет backend/desktop_server.py.

Разбор «запускать ли сбор и по какому региону» и один тик вынесены в чистые
функции (`collector_plan`, `run_collector_tick`) — их проверяют юнит-тесты без
сети и без запуска сервера.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from cli.regions import resolve_region

logger = logging.getLogger("fuelradar.worker")

# Статусы тика — то, что попадает в журнал приложения (и в тесты).
TICK_IDLE = "idle"          # работы нет (или цикл занят другим процессом-сборщиком)
TICK_ERROR = "error"        # цикл упал: сбор не состоялся, процесс жив

# Наблюдаемое состояние цикла для админского журнала («следующий тик»): цикл
# пишет сюда исход каждого тика, `GET /admin/collection-cycles` читает. Живёт
# в памяти процесса: у отдельного воркера своего ответа нет — там такт виден по
# `next_run_at` заданий (админка так и пишет, честно).
_tick_state: dict[str, Any] = {"last_tick_at": None, "last_status": None, "next_tick_at": None}


def ticker_state() -> dict[str, Any]:
    """Снимок последнего и следующего тика сборщика (пусто, если цикл не стартовал)."""
    return dict(_tick_state)


def record_tick(status: str, at: datetime, next_at: datetime | None) -> None:
    """Зафиксировать исход одного тика — единственная точка записи состояния цикла."""
    _tick_state["last_tick_at"] = at
    _tick_state["last_status"] = status
    _tick_state["next_tick_at"] = next_at


def collector_plan(settings: Any) -> tuple[dict | None, str]:
    """Регион сбора для процесса API — или честная причина, почему сбора не будет.

    Возвращает `(регион, "")`, если сбор включать есть чем, и `(None, причина)`
    в противном случае. Причина попадает в журнал как есть: «выключено» и «не
    задан регион» — разные состояния, и оператор должен видеть, какое из них.
    """
    if not getattr(settings, "collect_in_process", False):
        return None, "выключено настройкой COLLECT_IN_PROCESS (сбор ведёт отдельный воркер)"
    try:
        region = resolve_region(
            default_city=settings.default_region_city,
            radius_km=settings.default_region_radius_km,
        )
    except ValueError as exc:
        return None, f"не задан регион сбора (DEFAULT_REGION_CITY): {exc}"
    return region, ""


def run_collector_tick(worker: Any) -> str:
    """Один цикл сбора; наружу отдаёт короткий статус и никогда не бросает.

    Фоновый тик не имеет права уронить API: ошибка сети/БД в сборе — это
    состояние источника (в журнале сборки останутся CollectionLog/source_health),
    а не отказ приложения.
    """
    try:
        completed = worker.run_once()
    except Exception as exc:  # noqa: BLE001 — фоновая задача не роняет процесс
        logger.warning("цикл сбора не удался: %s", type(exc).__name__)
        return f"{TICK_ERROR}:{type(exc).__name__}"
    if not completed:
        return TICK_IDLE
    return f"collected:{len(completed)}"


async def collector_ticker(worker: Any, interval_seconds: float) -> None:
    """Цикл «тик → пауза» в отдельном потоке (сбор синхронный и сетевой).

    Первый тик выполняется сразу: после первого запуска приложения каталог
    наполняется демо-данными, и обновлять его логично не через час, а на старте.
    Тики не накладываются друг на друга: следующий начинается только после
    завершения предыдущего (в воркере это же даёт `max_instances=1`).

    После каждого тика пишется наблюдаемое состояние (`record_tick`) — по нему
    админка показывает последний и следующий тик сбора.
    """
    interval = max(1.0, float(interval_seconds))
    while True:
        status = await asyncio.to_thread(run_collector_tick, worker)
        finished = datetime.now(UTC).replace(tzinfo=None)
        record_tick(status, finished, finished + timedelta(seconds=interval))
        if status != TICK_IDLE:
            logger.info("сбор по расписанию: %s", status)
        await asyncio.sleep(interval)
