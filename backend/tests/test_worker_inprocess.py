"""Тесты сбора по расписанию внутри процесса API (app/worker/inprocess.py).

Проверяются чистые решения: включать ли сбор и по какому региону, что делает один
тик и что цикл вообще тикает. Настоящий Worker/сеть/БД здесь не участвуют —
встроенный backend проверяется smoke-прогонами оболочки.
"""

from __future__ import annotations

import asyncio
import contextlib
from types import SimpleNamespace

from app.worker.inprocess import (
    TICK_ERROR,
    TICK_IDLE,
    collector_plan,
    collector_ticker,
    run_collector_tick,
    ticker_state,
)


def settings(**overrides) -> SimpleNamespace:
    base = {
        "collect_in_process": False,
        "default_region_city": "",
        "default_region_radius_km": 10.0,
    }
    base.update(overrides)
    return SimpleNamespace(**base)


class StubWorker:
    """Заменяет Worker: считает вызовы и умеет «падать», как настоящий сбор."""

    def __init__(self, result: list[int] | None = None, error: Exception | None = None) -> None:
        self.result = result or []
        self.error = error
        self.calls = 0

    def run_once(self) -> list[int]:
        self.calls += 1
        if self.error is not None:
            raise self.error
        return self.result


def test_collector_plan_is_off_by_default() -> None:
    region, reason = collector_plan(settings())
    assert region is None
    # Причина называет саму настройку: оператор должен видеть, что именно её
    # выключило сбор, а не догадываться по молчанию журнала.
    assert "COLLECT_IN_PROCESS" in reason


def test_collector_plan_needs_a_region() -> None:
    # Сбор без региона невозможен (R04/R81: регион — данные, а не код), но и
    # падать из-за этого процесс API не должен.
    region, reason = collector_plan(settings(collect_in_process=True))
    assert region is None
    assert "DEFAULT_REGION_CITY" in reason


def test_collector_plan_uses_configured_city_and_radius() -> None:
    region, reason = collector_plan(
        settings(collect_in_process=True, default_region_city="Краснодар", default_region_radius_km=7.5)
    )
    assert reason == ""
    assert region is not None
    assert region["city"] == "Краснодар"
    assert region["radius_km"] == 7.5


def test_tick_reports_idle_and_counts_collected() -> None:
    assert run_collector_tick(StubWorker([])) == TICK_IDLE
    assert run_collector_tick(StubWorker([7, 8])) == "collected:2"


def test_tick_swallows_failures_instead_of_killing_the_api() -> None:
    status = run_collector_tick(StubWorker(error=RuntimeError("сеть недоступна")))
    assert status == f"{TICK_ERROR}:RuntimeError"


def test_ticker_ticks_immediately_and_can_be_stopped() -> None:
    async def scenario() -> int:
        worker = StubWorker([1])
        task = asyncio.create_task(collector_ticker(worker, 60))
        # Первый тик — сразу после старта приложения: наполненный каталог не
        # должен ждать первого интервала.
        await asyncio.sleep(0.05)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        return worker.calls

    assert asyncio.run(scenario()) >= 1


def test_ticker_records_state_visible_to_the_admin_journal() -> None:
    """Цикл пишет наблюдаемое состояние: админка показывает последний и следующий тик."""

    async def scenario() -> None:
        task = asyncio.create_task(collector_ticker(StubWorker([1, 2]), 30))
        await asyncio.sleep(0.05)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    state = ticker_state()
    assert set(state) == {"last_tick_at", "last_status", "next_tick_at"}
    assert state["last_status"] == "collected:2"
    assert state["last_tick_at"] is not None
    # «следующий тик» = конец тика + такт, а не выдуманное время
    assert state["next_tick_at"] is not None
    assert state["next_tick_at"] >= state["last_tick_at"]
