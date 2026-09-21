"""`POST /reports` (R39/R40) — анонимный отчёт с устройства.

Пользователей в приложении нет: отчёт просто наблюдение, которое отправил тот,
кто запустил FuelRadar. История конкретного «профиля» больше не нужна, поэтому
`GET /reports/mine` удалён — общую историю показывает админка (`GET /admin/reports`).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.session import get_db
from .schemas import ReportBody, ReportOut
from .service import ReportError, submit_report

router = APIRouter(tags=["reports"])


@router.post("/reports", status_code=201)
def create_report(body: ReportBody, session: Session = Depends(get_db)) -> ReportOut:
    """R39: топливо по видам + очередь; идемпотентно по idempotency_key (R39.1)."""
    try:
        report, created = submit_report(session, body)
    except ReportError as exc:
        if str(exc) == "station_not_found":
            raise HTTPException(status_code=404, detail="Станция не найдена") from exc
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return ReportOut(
        id=report.id,
        station_id=report.station_id,
        gps_confirmed=report.gps_confirmed,
        distance_to_station_m=report.distance_to_station_m,
        created=created,
        created_at=report.created_at.isoformat(),
    )
