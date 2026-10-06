"""Честный сигнал о простое сбора (R58/R97i) — один источник для /ready и главного экрана.

Зачем: «данные обновляются» — это свойство, о котором приложение обязано
говорить вслух. Раньше состояние планировщика было видно только в админке
(«Циклы сбора»), а главный экран показывал старые статусы как нормальные. Здесь
собираются наблюдаемые факты (последний успешный сбор, план, очередь, режим
планировщика) и превращаются в структурированный сигнал:

    state:        ok | disabled | overdue | stalled | unplanned
    warning:      булев признак — показывать ли предупреждение
    reason:       машинный ключ причины (schedule_off/plan_overdue/no_success/nothing_planned)
    age_minutes:  сколько минут назад был последний успешный сбор (None — не было)
    overdue_minutes: насколько просрочен план (None — не просрочен)

Почему именно так (R97i — не изображать работу):
- «свежий успех» важнее режима: если успешный сбор был только что, всё в порядке
  независимо от того, чей это процесс (встроенный тикер или `python -m app.worker`);
- «расписание выключено» (disabled) — это ровно случай «сбор в этом процессе
  выключен и успехов давно нет»; при живом внешнем воркере состояние будет ok;
- «план просрочен» (overdue) отделено от «сбор молчит» (stalled): просроченный
  план — это задание, которое обязано было выполниться и не выполнилось;
- идущее задание (RUNNING) считается работой, только пока оно свежее: зависший
  процесс не должен выглядеть как «сбор идёт».

Пороги — данные, а не код: `COLLECTION_STALE_MINUTES` (нет успеха) и
`COLLECTION_OVERDUE_MINUTES` (план просрочен) в core/config.py.

Чистая функция — `collection_signal` (её проверяют юнит-тесты без БД);
`collection_facts`/`collection_report` — тонкая обвязка над БД.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..core.config import settings
from ..db.models import CollectionJob, SourceHealth

STATE_OK = "ok"
STATE_DISABLED = "disabled"
STATE_OVERDUE = "overdue"
STATE_STALLED = "stalled"
STATE_UNPLANNED = "unplanned"

REASON_SCHEDULE_OFF = "schedule_off"
REASON_PLAN_OVERDUE = "plan_overdue"
REASON_NO_SUCCESS = "no_success"
REASON_NOTHING_PLANNED = "nothing_planned"

WARNING_STATES = (STATE_DISABLED, STATE_OVERDUE, STATE_STALLED, STATE_UNPLANNED)


def utcnow() -> datetime:
    """Наивное UTC — как в остальных модулях (SQLite/Postgres без timezone)."""
    return datetime.now(UTC).replace(tzinfo=None)


def minutes_since(now: datetime, moment: datetime | None) -> float | None:
    """Сколько минут назад был момент (None — момента не было)."""
    if moment is None:
        return None
    return round((now - moment).total_seconds() / 60.0, 1)


def collection_signal(
    now: datetime,
    facts: dict,
    *,
    stale_after_minutes: int,
    overdue_after_minutes: int,
) -> dict:
    """Состояние сбора из наблюдаемых фактов — чистая функция (тесты без БД).

    `facts` (см. `collection_facts`): mode, mode_reason (почему режим такой),
    tick_seconds, last_tick_at, next_tick_at, planned_at, pending_jobs,
    running_jobs, running_since, last_success_at.
    """
    stale_after = max(1, int(stale_after_minutes))
    overdue_after = max(1, int(overdue_after_minutes))
    age_minutes = minutes_since(now, facts.get("last_success_at"))
    running_since_minutes = minutes_since(now, facts.get("running_since"))
    running = int(facts.get("running_jobs") or 0) > 0 and (
        running_since_minutes is None or running_since_minutes <= stale_after
    )

    plans = [moment for moment in (facts.get("planned_at"), facts.get("next_tick_at")) if moment is not None]
    plan = min(plans) if plans else None
    overdue_minutes = None
    if plan is not None and now > plan:
        overdue_minutes = round((now - plan).total_seconds() / 60.0, 1)

    if age_minutes is not None and age_minutes <= stale_after:
        state, reason = STATE_OK, None
    elif running:
        # Сбор идёт прямо сейчас: свежего успеха может не быть ещё (идёт первый
        # или долгий цикл) — это не простой.
        state, reason = STATE_OK, None
    elif facts.get("mode") == "off":
        state, reason = STATE_DISABLED, REASON_SCHEDULE_OFF
    elif overdue_minutes is not None and overdue_minutes > overdue_after:
        state, reason = STATE_OVERDUE, REASON_PLAN_OVERDUE
    elif plan is None and int(facts.get("pending_jobs") or 0) == 0:
        state, reason = STATE_UNPLANNED, REASON_NOTHING_PLANNED
    else:
        state, reason = STATE_STALLED, REASON_NO_SUCCESS

    return {
        "state": state,
        "warning": state in WARNING_STATES,
        "reason": reason,
        "mode": facts.get("mode"),
        "mode_reason": facts.get("mode_reason") or None,
        "tick_seconds": int(facts.get("tick_seconds") or 0),
        "last_success_at": facts.get("last_success_at"),
        "age_minutes": age_minutes,
        "planned_at": plan,
        "overdue_minutes": overdue_minutes,
        "next_run_at": facts.get("planned_at"),
        "next_tick_at": facts.get("next_tick_at"),
        "pending_jobs": int(facts.get("pending_jobs") or 0),
        "running_jobs": int(facts.get("running_jobs") or 0),
        "stale_after_minutes": stale_after,
        "overdue_after_minutes": overdue_after,
    }


def scheduler_mode() -> tuple[str, str]:
    """Режим планировщика: in_process / external / off + честная причина (как в админке).

    Состояние встроенного тикера видно только этому процессу; при `external`
    (сбор ведёт отдельный воркер) сигнал опирается на успехи и очередь заданий —
    иначе админка и главный экран начнут выдумывать чужое состояние.
    """
    from .inprocess import collector_plan

    if not settings.collect_in_process:
        return "external", ""
    region, reason = collector_plan(settings)
    return ("in_process", "") if region is not None else ("off", reason)


def collection_facts(session: Session) -> dict:
    """Наблюдаемые факты о сборе: успех, план, очередь, режим (один проход по индексам)."""
    from .inprocess import ticker_state

    last_success_at = session.scalar(select(func.max(SourceHealth.last_success_at)))
    pending = int(session.scalar(select(func.count()).select_from(CollectionJob).where(CollectionJob.status == "PENDING")) or 0)
    running = int(session.scalar(select(func.count()).select_from(CollectionJob).where(CollectionJob.status == "RUNNING")) or 0)
    running_since = session.scalar(
        select(func.min(CollectionJob.started_at)).where(
            CollectionJob.status == "RUNNING", CollectionJob.started_at.is_not(None)
        )
    )
    # План — та же семантика, что в админском журнале: ближайшее активное задание,
    # иначе план последнего завершённого (его выставляет воркер по интервалу/backoff).
    active_plan = session.scalar(
        select(func.min(CollectionJob.next_run_at)).where(
            CollectionJob.status.in_(["PENDING", "RUNNING"]), CollectionJob.next_run_at.is_not(None)
        )
    )
    last_done_plan = session.scalar(
        select(CollectionJob.next_run_at)
        .where(CollectionJob.status.in_(["DONE", "FAILED"]), CollectionJob.next_run_at.is_not(None))
        .order_by(CollectionJob.id.desc())
    )
    mode, reason = scheduler_mode()
    tick = ticker_state()
    return {
        "mode": mode,
        "mode_reason": reason,
        "tick_seconds": int(settings.worker_tick_seconds),
        "last_tick_at": tick.get("last_tick_at"),
        "next_tick_at": tick.get("next_tick_at"),
        "planned_at": active_plan if active_plan is not None else last_done_plan,
        "pending_jobs": pending,
        "running_jobs": running,
        "running_since": running_since,
        "last_success_at": last_success_at,
    }


def collection_report(
    session: Session | None,
    *,
    now: datetime | None = None,
    stale_after_minutes: int | None = None,
    overdue_after_minutes: int | None = None,
) -> dict:
    """Сигнал о сборе для API: факты из БД → состояние (пороги — из конфига).

    `session=None` — БД недоступна: честно `state: unknown`, а не «всё хорошо».
    """
    if session is None:
        return {"state": "unknown", "warning": False, "reason": None, "mode": None}
    facts = collection_facts(session)
    return collection_signal(
        now or utcnow(),
        facts,
        stale_after_minutes=stale_after_minutes if stale_after_minutes is not None else settings.collection_stale_minutes,
        overdue_after_minutes=(
            overdue_after_minutes if overdue_after_minutes is not None else settings.collection_overdue_minutes
        ),
    )
