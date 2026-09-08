"""Админ-API (T05, §15, R95i/R67): источники, refresh, merge/split, очередь дедупликации.

Доступ — только по заголовку X-Admin-Token (R95i). Все действия журналируются
в admin_action_log (R67). Refresh ставит задание воркеру (T06) — без синхронного
сбора (R83).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db.models import (
    AdminActionLog,
    SourceHealth,
    SourceProvider,
    SourceStationRecord,
    Station,
)
from ..db.session import get_db
from ..dedup import DedupService
from .deps import require_admin
from .schemas import AdminMergeBody, DedupQueueAction

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])


def _journal(session: Session, action: str, target_id: str, payload: dict) -> None:
    session.add(AdminActionLog(actor="admin", action=action, target_type="station" if action != "refresh_source" else "source", target_id=target_id, payload=payload))


def _provider_or_404(session: Session, provider_id: int) -> SourceProvider:
    provider = session.get(SourceProvider, provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="Источник не найден")
    return provider


@router.get("/sources")
def list_sources(session: Session = Depends(get_db)) -> list[dict]:
    """Список источников: статус (ACTIVE/RESEARCH_REQUIRED), health, доверие (R57/R95i)."""
    health = {h.source_provider_id: h for h in session.scalars(select(SourceHealth))}
    return [
        {
            "id": p.id,
            "code": p.code,
            "name": p.name,
            "status": p.status,
            "trust": p.trust,
            "capabilities": p.capabilities,
            "attribution": p.attribution,
            "min_interval_minutes": p.min_interval_minutes,
            "health": {
                "state": health[p.id].health if p.id in health else "UNKNOWN",
                "last_check_at": health[p.id].last_check_at if p.id in health else None,
                "last_success_at": health[p.id].last_success_at if p.id in health else None,
                "consecutive_failures": health[p.id].consecutive_failures if p.id in health else 0,
                "last_error": health[p.id].last_error if p.id in health else "",
            },
        }
        for p in session.scalars(select(SourceProvider).order_by(SourceProvider.code))
    ]


@router.get("/sources/{provider_id}/health")
def source_health(provider_id: int, session: Session = Depends(get_db)) -> dict:
    provider = _provider_or_404(session, provider_id)
    health = session.scalar(select(SourceHealth).where(SourceHealth.source_provider_id == provider.id))
    if health is None:
        return {"provider": provider.code, "health": "UNKNOWN", "consecutive_failures": 0, "last_error": ""}
    return {
        "provider": provider.code,
        "health": health.health,
        "last_check_at": health.last_check_at,
        "last_success_at": health.last_success_at,
        "consecutive_failures": health.consecutive_failures,
        "last_error": health.last_error,
    }


@router.post("/sources/{provider_id}/refresh")
def refresh_source(provider_id: int, session: Session = Depends(get_db)) -> dict:
    """R83: не собирает синхронно — ставит задание в очередь воркера (T06, приоритет P2)."""
    provider = _provider_or_404(session, provider_id)
    from ..worker import schedule_priority_job

    if provider.status != "ACTIVE":
        raise HTTPException(status_code=409, detail="Источник не активен: требуется исследование")
    job = schedule_priority_job(session, provider.id, priority="P1", trigger="manual")
    _journal(session, "refresh_source", provider.code, {"job_id": job.id})
    session.commit()
    return {"job_id": job.id, "provider": provider.code, "status": job.status, "priority": job.priority}


def _station_or_404(session: Session, station_id: str) -> Station:
    station = session.get(Station, station_id)
    if station is None:
        raise HTTPException(status_code=404, detail="Станция не найдена")
    return station


@router.post("/stations/{station_id}/merge")
def merge_station(station_id: str, body: AdminMergeBody, session: Session = Depends(get_db)) -> dict:
    """Объединить запись (и её станцию, если есть) со станцией {station_id} (R09.1/R10)."""
    _station_or_404(session, station_id)
    service = DedupService(session)
    representative = session.scalar(
        select(SourceStationRecord).where(SourceStationRecord.station_id == station_id).limit(1)
    )
    if representative is None:
        raise HTTPException(status_code=404, detail="У станции нет записей источников для объединения")
    try:
        target = service.admin_merge(representative.id, body.record_id, actor="admin")
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    _journal(session, "merge", target, {"record_id": body.record_id, "into": station_id})
    session.commit()
    return {"station_id": target, "merged_record_id": body.record_id}


@router.post("/stations/{station_id}/split")
def split_station(station_id: str, body: AdminMergeBody, session: Session = Depends(get_db)) -> dict:
    """Выделить запись в отдельную станцию (R09.1): прежние внешние ID сохраняются."""
    _station_or_404(session, station_id)
    record = session.get(SourceStationRecord, body.record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Запись источника не найдена")
    if record.station_id != station_id:
        raise HTTPException(status_code=400, detail="Запись не принадлежит этой станции")
    service = DedupService(session)
    new_id = service.admin_split(body.record_id, actor="admin")
    _journal(session, "split", station_id, {"record_id": body.record_id, "new_station_id": new_id})
    session.commit()
    return {"new_station_id": new_id, "record_id": body.record_id}


@router.get("/dedup-queue")
def dedup_queue(session: Session = Depends(get_db)) -> list[dict]:
    """Кандидаты «на подтверждение» (R10): запись + предложение + разбор по весам."""
    service = DedupService(session)
    result = []
    for candidate in service.review_candidates():
        provider = session.get(SourceProvider, candidate["source"])
        candidate = dict(candidate)
        candidate["source_name"] = provider.name if provider else None
        result.append(candidate)
    return result


@router.post("/dedup-queue")
def dedup_queue_action(body: DedupQueueAction, session: Session = Depends(get_db)) -> dict:
    """Подтвердить слияние (merge) или выделить запись в отдельную станцию (new_station)."""
    service = DedupService(session)
    try:
        if body.action == "merge":
            if body.target_record_id is None:
                raise HTTPException(status_code=422, detail="Для action=merge нужен target_record_id")
            station_id = service.admin_merge(body.target_record_id, body.record_id, actor="admin")
        else:
            station_id = service.admin_assign_new_station(body.record_id, actor="admin")
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    _journal(session, f"dedup_{body.action}", station_id, {"record_id": body.record_id})
    session.commit()
    return {"station_id": station_id, "action": body.action, "record_id": body.record_id}
