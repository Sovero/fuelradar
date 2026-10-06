"""Сигнал о простое сбора (worker/health.py) и публичный GET /api/v1/collection/health.

Правила проверяются на чистой функции `collection_signal` — с явным `now` и без
БД, поэтому каждый случай («расписание выключено», «план просрочен надолго»,
«идёт сбор», «плана нет») детерминирован. Endpoint проверяется на контракт:
состояние из закрытого набора, `warning` согласован с состоянием, секретов нет.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from app.worker.health import (
    REASON_NO_SUCCESS,
    REASON_NOTHING_PLANNED,
    REASON_PLAN_OVERDUE,
    REASON_SCHEDULE_OFF,
    STATE_DISABLED,
    STATE_OK,
    STATE_OVERDUE,
    STATE_STALLED,
    STATE_UNPLANNED,
    collection_signal,
    minutes_since,
)

NOW = datetime(2026, 10, 6, 12, 0, 0)


def facts(**overrides) -> dict:
    """Наблюдаемые факты «всё в порядке»: успех 5 минут назад, план впереди."""
    base = {
        "mode": "in_process",
        "mode_reason": "",
        "tick_seconds": 10,
        "last_tick_at": NOW - timedelta(seconds=10),
        "next_tick_at": NOW + timedelta(seconds=10),
        "planned_at": NOW + timedelta(minutes=30),
        "pending_jobs": 1,
        "running_jobs": 0,
        "running_since": None,
        "last_success_at": NOW - timedelta(minutes=5),
    }
    base.update(overrides)
    return base


def signal(**overrides) -> dict:
    return collection_signal(NOW, facts(**overrides), stale_after_minutes=180, overdue_after_minutes=30)


def test_fresh_success_is_ok_regardless_of_mode() -> None:
    # Успех был только что — значит, сбор работает, чей бы процесс его ни сделал.
    for mode in ("in_process", "external", "off"):
        result = signal(mode=mode)
        assert result["state"] == STATE_OK
        assert result["warning"] is False
        assert result["reason"] is None
        assert result["age_minutes"] == 5.0


def test_no_success_with_schedule_off_is_disabled() -> None:
    result = signal(mode="off", mode_reason="выключено настройкой COLLECT_IN_PROCESS", last_success_at=None)
    assert result["state"] == STATE_DISABLED
    assert result["warning"] is True
    assert result["reason"] == REASON_SCHEDULE_OFF
    assert result["age_minutes"] is None
    # Причина режима доезжает до интерфейса как есть (её формулирует collector_plan).
    assert "COLLECT_IN_PROCESS" in result["mode_reason"]


def test_long_overdue_plan_is_overdue() -> None:
    result = signal(last_success_at=NOW - timedelta(hours=5), planned_at=NOW - timedelta(hours=2))
    assert result["state"] == STATE_OVERDUE
    assert result["reason"] == REASON_PLAN_OVERDUE
    assert result["overdue_minutes"] == 120.0
    assert result["warning"] is True


def test_slightly_overdue_plan_is_not_a_warning_when_collection_is_alive() -> None:
    # План разошёлся с тактом на 10 минут, но успех свежий — это не простой.
    result = signal(planned_at=NOW - timedelta(minutes=10))
    assert result["state"] == STATE_OK
    assert result["overdue_minutes"] == 10.0


def test_slightly_overdue_plan_without_success_is_stalled_not_overdue() -> None:
    result = signal(last_success_at=NOW - timedelta(hours=5), planned_at=NOW - timedelta(minutes=10))
    assert result["state"] == STATE_STALLED
    assert result["reason"] == REASON_NO_SUCCESS
    assert result["overdue_minutes"] == 10.0


def test_running_job_is_work_in_progress_not_idle() -> None:
    result = signal(
        mode="external",
        last_success_at=None,
        running_jobs=1,
        running_since=NOW - timedelta(minutes=2),
        planned_at=NOW - timedelta(hours=2),
    )
    assert result["state"] == STATE_OK
    assert result["warning"] is False


def test_stale_running_job_does_not_hide_the_stall() -> None:
    # Зависший процесс не должен выглядеть как «сбор идёт»: задание RUNNING слишком давно.
    result = signal(
        mode="external",
        last_success_at=None,
        running_jobs=1,
        running_since=NOW - timedelta(hours=4),
        planned_at=NOW - timedelta(hours=2),
    )
    assert result["state"] == STATE_OVERDUE
    assert result["running_jobs"] == 1


def test_nothing_planned_is_reported_honestly() -> None:
    result = signal(mode="external", last_success_at=None, planned_at=None, next_tick_at=None, pending_jobs=0)
    assert result["state"] == STATE_UNPLANNED
    assert result["reason"] == REASON_NOTHING_PLANNED
    assert result["planned_at"] is None


def test_pending_job_without_plan_is_stalled() -> None:
    # Задания в очереди есть, но плана нет и успехов нет — это «сбор молчит», а не «не запланирован».
    result = signal(last_success_at=None, planned_at=None, next_tick_at=None, pending_jobs=3)
    assert result["state"] == STATE_STALLED
    assert result["pending_jobs"] == 3


def test_tick_plan_is_taken_when_no_job_plan_exists() -> None:
    # Встроенный тикер: плана заданий нет, но следующий тик известен — он и есть план.
    result = signal(last_success_at=None, planned_at=None, next_tick_at=NOW + timedelta(seconds=5))
    assert result["state"] == STATE_STALLED  # тик идёт, но успехов не было
    assert result["planned_at"] == NOW + timedelta(seconds=5)
    assert result["overdue_minutes"] is None


def test_thresholds_are_arguments_not_constants() -> None:
    # Долгий успех при большом пороге — ещё не простой (порог задаётся конфигом).
    lenient = collection_signal(NOW, facts(last_success_at=NOW - timedelta(hours=8)), stale_after_minutes=720, overdue_after_minutes=60)
    assert lenient["state"] == STATE_OK
    strict = collection_signal(NOW, facts(last_success_at=NOW - timedelta(hours=8)), stale_after_minutes=60, overdue_after_minutes=60)
    assert strict["state"] == STATE_STALLED
    # Порог просрочки тоже аргумент: 45 минут просрочки проходят при пороге 60.
    result = collection_signal(
        NOW,
        facts(last_success_at=NOW - timedelta(hours=8), planned_at=NOW - timedelta(minutes=45)),
        stale_after_minutes=60,
        overdue_after_minutes=60,
    )
    assert result["state"] == STATE_STALLED
    assert result["overdue_minutes"] == 45.0


def test_minutes_since_handles_missing_moment() -> None:
    assert minutes_since(NOW, None) is None
    assert minutes_since(NOW, NOW - timedelta(seconds=90)) == 1.5


def test_public_endpoint_reports_a_consistent_state(client) -> None:
    r = client.get("/api/v1/collection/health")
    assert r.status_code == 200
    body = r.json()
    assert body["state"] in {STATE_OK, STATE_DISABLED, STATE_OVERDUE, STATE_STALLED, STATE_UNPLANNED}
    assert body["warning"] == (body["state"] != STATE_OK)
    assert body["mode"] in {"in_process", "external", "off"}
    assert isinstance(body["pending_jobs"], int) and body["pending_jobs"] >= 0
    assert body["stale_after_minutes"] >= 1 and body["overdue_after_minutes"] >= 1
    # Наружу не уходят тексты ошибок источников и секреты (R68) — только сигнал.
    assert set(body) == {
        "state", "warning", "reason", "mode", "mode_reason", "tick_seconds", "last_success_at",
        "age_minutes", "planned_at", "overdue_minutes", "next_run_at", "next_tick_at",
        "pending_jobs", "running_jobs", "stale_after_minutes", "overdue_after_minutes",
    }
