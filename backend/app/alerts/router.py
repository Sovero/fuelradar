"""Лента уведомлений (A03): `GET /notifications` + `POST /notifications/read`.

CRUD правил (`/alerts`) — уже реализован в `backend/app/api/personal.py` (T05);
не дублируется здесь. R76 («следить» из пустого состояния) не заводит отдельный
endpoint — фронтенд (T09) шлёт текущие фильтры как тело в уже существующий
`POST /api/v1/alerts` (см. CONCERNS/INTERFACES в отчёте таска).
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db.models import AlertEvent, FuelType, Station, User
from ..db.session import get_db
from .authz import current_user

router = APIRouter(tags=["notifications"])


class NotificationOut(BaseModel):
    id: int
    event_type: str
    station_id: str
    station_name: str
    fuel_code: str | None = None
    payload: dict
    delivered: bool
    delivered_at: datetime | None = None
    created_at: datetime


class NotificationsPage(BaseModel):
    items: list[NotificationOut]
    unread_count: int


@router.get("/notifications", response_model=NotificationsPage)
def list_notifications(
    limit: int = 50, session: Session = Depends(get_db), user: User = Depends(current_user),
) -> NotificationsPage:
    """Лента AlertEvent пользователя, новые сверху; `delivered=False` — непрочитано."""
    rows = list(
        session.scalars(
            select(AlertEvent)
            .where(AlertEvent.user_id == user.id)
            .order_by(AlertEvent.created_at.desc(), AlertEvent.id.desc())
            .limit(max(1, min(limit, 200)))
        )
    )
    unread = session.scalar(
        select(func.count()).select_from(AlertEvent).where(AlertEvent.user_id == user.id, AlertEvent.delivered.is_(False))
    ) or 0
    fuel_codes = {f.id: f.code for f in session.scalars(select(FuelType))}
    station_ids = {r.station_id for r in rows}
    names = {s.id: (s.canonical_name or s.id) for s in session.scalars(select(Station).where(Station.id.in_(station_ids)))} if station_ids else {}
    items = [
        NotificationOut(
            id=r.id,
            event_type=r.event_type,
            station_id=r.station_id,
            station_name=names.get(r.station_id, r.station_id),
            fuel_code=fuel_codes.get(r.payload.get("fuel_type_id")) if isinstance(r.payload, dict) else None,
            payload=r.payload if isinstance(r.payload, dict) else {},
            delivered=r.delivered,
            delivered_at=r.delivered_at,
            created_at=r.created_at,
        )
        for r in rows
    ]
    return NotificationsPage(items=items, unread_count=unread)


@router.post("/notifications/read")
async def mark_notifications_read(
    request: Request, session: Session = Depends(get_db), user: User = Depends(current_user),
) -> dict:
    """A03: сброс счётчика непрочитанных. Тело `{"ids": [..]}` — опционально;
    без тела/`ids` — помечаются прочитанными все текущие непрочитанные."""
    ids: list[int] | None = None
    raw = await request.body()
    if raw:
        try:
            data = json.loads(raw)
            if isinstance(data, dict) and isinstance(data.get("ids"), list):
                ids = [int(i) for i in data["ids"]]
        except (ValueError, TypeError):
            ids = None

    query = select(AlertEvent).where(AlertEvent.user_id == user.id, AlertEvent.delivered.is_(False))
    if ids is not None:
        query = query.where(AlertEvent.id.in_(ids))
    now = datetime.now(UTC).replace(tzinfo=None)
    updated = 0
    for event in session.scalars(query):
        event.delivered = True
        event.delivered_at = now
        updated += 1
    session.commit()
    unread = session.scalar(
        select(func.count()).select_from(AlertEvent).where(AlertEvent.user_id == user.id, AlertEvent.delivered.is_(False))
    ) or 0
    return {"marked": updated, "unread_count": unread}
