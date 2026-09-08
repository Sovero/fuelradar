"""`POST /reports` (R39/R40) + `GET /reports/mine` (история, R41.1)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..alerts.authz import current_active_user, current_user
from ..db.models import User, UserReport
from ..db.session import get_db
from .schemas import ReportBody, ReportOut
from .service import ReportError, submit_report

router = APIRouter(tags=["reports"])


@router.post("/reports", status_code=201)
def create_report(
    body: ReportBody, session: Session = Depends(get_db), user: User = Depends(current_active_user),
) -> ReportOut:
    """R39: топливо по видам + очередь. R41.1: заблокированный получает 403
    (обеспечено зависимостью `current_active_user`, не логикой этого хендлера)."""
    try:
        report, created = submit_report(session, user.id, body)
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


@router.get("/reports/mine")
def list_my_reports(session: Session = Depends(get_db), user: User = Depends(current_user)) -> list[dict]:
    """История отчётов видна и заблокированному пользователю (R41.1: «история
    остаётся видимой, но помечается») — `reporter_blocked` читается с `User`."""
    rows = session.scalars(
        select(UserReport).where(UserReport.user_id == user.id).order_by(UserReport.created_at.desc())
    )
    return [
        {
            "id": r.id,
            "station_id": r.station_id,
            "gps_confirmed": r.gps_confirmed,
            "distance_to_station_m": r.distance_to_station_m,
            "created_at": r.created_at.isoformat(),
            "reporter_blocked": user.is_blocked,
        }
        for r in rows
    ]
