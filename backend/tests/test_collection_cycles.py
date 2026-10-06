"""GET /admin/collection-cycles: журнал циклов сбора.

Отвечает на три вопроса оператора по каждому источнику: когда сбор последний раз
завершился успешно, когда ждать следующий запуск и почему были сбои. Задания
создаются под одноразовыми источниками: БД общая на весь прогон (session-scope),
а активное задание по osm_overpass/network_import задело бы партиционный
uq_collection_active в других файлах теста.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.core.config import settings
from app.db.models import CollectionJob, SourceHealth, SourceProvider


def _ago(minutes: float) -> datetime:
    return datetime.now(UTC).replace(tzinfo=None) - timedelta(minutes=minutes)


def _provider(db_session, code: str) -> SourceProvider:
    """Одноразовый TEST-провайдер: такой код не попадает в выборку seed/воркера
    (`CatalogIngest` берёт только ACTIVE), а значит не ломает чужие тесты на
    общей session-scope БД."""
    provider = db_session.scalar(select(SourceProvider).where(SourceProvider.code == code))
    if provider is None:
        provider = SourceProvider(
            code=code, name=f"Тест {code}", capabilities={"discovery": True},
            status="TEST", min_interval_minutes=60, trust=0.5,
        )
        db_session.add(provider)
        db_session.flush()
    return provider


def _source(body: dict, code: str) -> dict:
    return next(item for item in body["sources"] if item["code"] == code)


def test_collection_cycles_never_collected_source_is_honest(client, db_session) -> None:
    """Источник, который ещё не собирался: нет ни успеха, ни плана, health UNKNOWN."""
    _provider(db_session, "cycles_never")
    db_session.commit()

    r = client.get("/api/v1/admin/collection-cycles")
    assert r.status_code == 200
    body = r.json()
    assert "now" in body

    src = _source(body, "cycles_never")
    assert src["health"] == "UNKNOWN"
    assert src["last_success_at"] is None
    assert src["last_attempt_at"] is None
    assert src["next_run_at"] is None
    assert src["queued_job_id"] is None
    assert src["active_job_status"] is None
    # цикла сейчас нет — живой журнал админки не должен подсвечивать источник
    assert src["running_jobs"] == 0
    assert src["running_job_id"] is None
    assert src["running_since"] is None
    assert src["last_job"] is None
    assert src["consecutive_failures"] == 0
    assert src["last_error"] == ""
    # TEST-статус: планировщик такой источник не опрашивает (и режим честно пуст)
    assert src["collectable"] is False


def test_collection_cycles_reports_last_success_next_run_and_failure(client, db_session) -> None:
    """Успешный цикл: время последнего успеха, план следующего запуска и последний прогон."""
    provider = _provider(db_session, "cycles_done")
    started, finished = _ago(70), _ago(65)
    planned = _ago(5) + timedelta(minutes=60)
    db_session.add(
        CollectionJob(
            source_provider_id=provider.id, job_type="catalog", trigger="schedule", priority="P4",
            status="DONE", records_count=12, error_count=0, started_at=started,
            finished_at=finished, next_run_at=planned,
        )
    )
    db_session.add(
        SourceHealth(
            source_provider_id=provider.id, health="ONLINE", last_check_at=finished,
            last_success_at=finished, consecutive_failures=0, last_error="",
        )
    )
    db_session.commit()

    src = _source(client.get("/api/v1/admin/collection-cycles").json(), "cycles_done")
    assert src["health"] == "ONLINE"
    assert src["last_success_at"] == finished.isoformat()
    assert src["next_run_at"] == planned.isoformat()
    assert src["queued_job_id"] is None  # активного задания нет — план из последнего DONE
    assert src["last_job"]["status"] == "DONE"
    assert src["last_job"]["records_count"] == 12
    assert src["last_job"]["trigger"] == "schedule"


def test_collection_cycles_surfaces_failure_reason_and_backoff(client, db_session) -> None:
    """Сбой: причина (класс ошибки), число подряд неудач и время следующей попытки."""
    provider = _provider(db_session, "cycles_failed")
    failed_at = _ago(30)
    retry_at = failed_at + timedelta(minutes=120)
    db_session.add(
        CollectionJob(
            source_provider_id=provider.id, job_type="catalog", trigger="schedule", priority="P4",
            status="FAILED", records_count=0, error_count=1, error_message="AdapterError",
            started_at=_ago(31), finished_at=failed_at, next_run_at=retry_at,
        )
    )
    db_session.add(
        SourceHealth(
            source_provider_id=provider.id, health="OFFLINE", last_check_at=failed_at,
            last_success_at=None, consecutive_failures=3, last_error="AdapterError",
        )
    )
    db_session.commit()

    src = _source(client.get("/api/v1/admin/collection-cycles").json(), "cycles_failed")
    assert src["health"] == "OFFLINE"
    assert src["last_success_at"] is None
    assert src["consecutive_failures"] == 3
    assert src["last_error"] == "AdapterError"
    assert src["next_run_at"] == retry_at.isoformat()
    assert src["last_job"]["status"] == "FAILED"
    assert src["last_job"]["error_message"] == "AdapterError"
    assert src["last_job"]["error_count"] == 1


def test_collection_cycles_queued_job_wins_next_run(client, db_session) -> None:
    """Активное задание важнее плана последнего завершённого: следующий запуск — его время."""
    provider = _provider(db_session, "cycles_queued")
    db_session.add(
        CollectionJob(
            source_provider_id=provider.id, job_type="catalog", trigger="schedule", priority="P4",
            status="DONE", records_count=1, finished_at=_ago(120), next_run_at=_ago(60),
        )
    )
    queued = CollectionJob(
        source_provider_id=provider.id, job_type="catalog", trigger="manual", priority="P1",
        status="PENDING", next_run_at=_ago(1),
    )
    db_session.add(queued)
    db_session.commit()

    src = _source(client.get("/api/v1/admin/collection-cycles").json(), "cycles_queued")
    assert src["queued_job_id"] == queued.id
    assert src["next_run_at"] == queued.next_run_at.isoformat()
    # PENDING — это «ждёт тика», а не «цикл идёт»: подсвечивать источник нечем
    assert src["active_job_status"] == "PENDING"
    assert src["running_jobs"] == 0
    assert src["running_since"] is None

    # Довести задание до терминального статуса: PENDING переживёт файл теста и
    # задел бы uq_collection_active в другом прогоне на той же session-scope БД.
    queued.status = "DONE"
    db_session.commit()


def test_collection_cycles_running_job_is_a_fact_not_a_plan(client, db_session) -> None:
    """Идущий цикл: RUNNING-задание видно как факт (running_jobs/running_since)."""
    provider = _provider(db_session, "cycles_running")
    started = _ago(3)
    running = CollectionJob(
        source_provider_id=provider.id, job_type="catalog", trigger="schedule", priority="P4",
        status="RUNNING", started_at=started, next_run_at=_ago(1),
    )
    db_session.add(running)
    db_session.commit()

    src = _source(client.get("/api/v1/admin/collection-cycles").json(), "cycles_running")
    assert src["queued_job_id"] == running.id
    assert src["active_job_status"] == "RUNNING"
    assert src["running_jobs"] == 1
    assert src["running_job_id"] == running.id
    assert src["running_since"] == started.isoformat()
    # последний *завершённый* цикл этим не подменяется
    assert src["last_job"] is None

    running.status = "DONE"
    running.finished_at = _ago(0)
    db_session.commit()


def test_collection_cycles_scheduler_state_and_non_polled_source(client, db_session) -> None:
    """Планировщик: режим, такт и очередь заданий; user_reports в цикле сбора нет."""
    body = client.get("/api/v1/admin/collection-cycles").json()
    scheduler = body["scheduler"]
    assert scheduler["tick_seconds"] == settings.worker_tick_seconds
    assert scheduler["collect_in_process"] is False
    assert scheduler["mode"] == "external"  # в тестах сбор в процессе API выключен
    assert scheduler["pending_jobs"] >= 0 and scheduler["running_jobs"] >= 0
    # Цикл в этом процессе не запускался — «следующего тика» честно нет.
    assert scheduler["last_tick_at"] is None
    assert scheduler["next_tick_at"] is None

    reports = _source(body, "user_reports")
    assert reports["collectable"] is False
    assert reports["next_run_at"] is None
    # Активные источники каталога в цикле сбора есть — режим не вырожденный.
    assert any(src["collectable"] for src in body["sources"])
