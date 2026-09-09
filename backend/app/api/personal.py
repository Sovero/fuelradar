"""Персонализация (T05, §15, R21/R23/R26): избранное, зоны, правила — только с профилем.

Оценка правил и события — таск 07; здесь CRUD с валидацией и лимитом правил.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..core.config import settings
from ..db.models import AlertRule, Favorite, FuelType, MonitoringZone, Station, User
from ..db.session import get_db
from .deps import require_user
from .schemas import AlertRuleBody, AlertRuleOut, ZoneBody, ZoneOut
from .stations import _snapshot, _station_brief

router = APIRouter(tags=["personal"])


def _station_or_404(session: Session, station_id: str) -> Station:
    station = session.get(Station, station_id)
    if station is None:
        raise HTTPException(status_code=404, detail="Станция не найдена")
    return station


# ---------- избранное (R21) ----------


@router.get("/favorites")
def list_favorites(session: Session = Depends(get_db), user: User = Depends(require_user)) -> list:
    rows = session.execute(
        select(Station).join(Favorite, Favorite.station_id == Station.id).where(Favorite.user_id == user.id)
    ).scalars().all()
    if not rows:
        return []
    stations, brands, statuses = _snapshot(session)
    result = []
    for station in rows:
        brand = brands.get(station.brand_id) if station.brand_id else None
        rows_s = statuses.get(station.id, [])
        from .schemas import FuelStatusBrief, QueueBrief

        briefs = [
            FuelStatusBrief(fuel_code=code, status=r.status, confidence=r.confidence, updated_at=r.updated_at, expires_at=r.expires_at)
            for r, code in rows_s
        ]
        top = max(rows_s, key=lambda r: r[0].confidence, default=None)
        queue = None
        if top is not None:
            queue = QueueBrief(level=top[0].queue_level, vehicles=top[0].queue_vehicles, estimated_wait_minutes=top[0].estimated_wait_minutes)
        brief, _ = _station_brief(station, brand, briefs, queue, None, brand.priority if brand else None)
        result.append(brief)
    return result


@router.post("/favorites/{station_id}", status_code=201)
def add_favorite(station_id: str, session: Session = Depends(get_db), user: User = Depends(require_user)) -> dict:
    _station_or_404(session, station_id)
    existing = session.scalar(select(Favorite).where(Favorite.user_id == user.id, Favorite.station_id == station_id))
    if existing is None:
        session.add(Favorite(user_id=user.id, station_id=station_id))
        session.commit()
        return {"station_id": station_id, "added": True}
    return {"station_id": station_id, "added": False}


@router.delete("/favorites/{station_id}", status_code=204)
def remove_favorite(station_id: str, session: Session = Depends(get_db), user: User = Depends(require_user)) -> Response:
    row = session.scalar(select(Favorite).where(Favorite.user_id == user.id, Favorite.station_id == station_id))
    if row is None:
        raise HTTPException(status_code=404, detail="Станции нет в избранном")
    session.delete(row)
    session.commit()
    return Response(status_code=204)


# ---------- зоны мониторинга (R23) ----------


@router.get("/monitoring-zones")
def list_zones(session: Session = Depends(get_db), user: User = Depends(require_user)) -> list[ZoneOut]:
    return [ZoneOut(id=z.id, name=z.name, zone_type=z.zone_type, params=z.params)
            for z in session.scalars(select(MonitoringZone).where(MonitoringZone.user_id == user.id))]


@router.post("/monitoring-zones", status_code=201)
def create_zone(body: ZoneBody, session: Session = Depends(get_db), user: User = Depends(require_user)) -> ZoneOut:
    zone = MonitoringZone(user_id=user.id, name=body.name, zone_type=body.zone_type, params=body.params)
    session.add(zone)
    session.commit()
    return ZoneOut(id=zone.id, name=zone.name, zone_type=zone.zone_type, params=zone.params)


@router.put("/monitoring-zones/{zone_id}")
def update_zone(zone_id: int, body: ZoneBody, session: Session = Depends(get_db), user: User = Depends(require_user)) -> ZoneOut:
    zone = session.get(MonitoringZone, zone_id)
    if zone is None or zone.user_id != user.id:
        raise HTTPException(status_code=404, detail="Зона не найдена")
    zone.name, zone.zone_type, zone.params = body.name, body.zone_type, body.params
    session.commit()
    return ZoneOut(id=zone.id, name=zone.name, zone_type=zone.zone_type, params=zone.params)


@router.delete("/monitoring-zones/{zone_id}", status_code=204)
def delete_zone(zone_id: int, session: Session = Depends(get_db), user: User = Depends(require_user)) -> Response:
    zone = session.get(MonitoringZone, zone_id)
    if zone is None or zone.user_id != user.id:
        raise HTTPException(status_code=404, detail="Зона не найдена")
    session.delete(zone)
    session.commit()
    return Response(status_code=204)


# ---------- правила уведомлений (R26; оценка — T07) ----------


@router.get("/alerts")
def list_alerts(session: Session = Depends(get_db), user: User = Depends(require_user)) -> list[AlertRuleOut]:
    return [AlertRuleOut(id=r.id, name=r.name, fuel_code=session.get(FuelType, r.fuel_type_id).code if r.fuel_type_id else None, distance_km=r.distance_km,
                         status_filter=r.status_filter, confidence_min=r.confidence_min,
                         queue_max=r.queue_max, scope=r.scope, is_active=r.is_active,
                         trigger_count=r.trigger_count, last_event_at=r.last_event_at)
            for r in session.scalars(select(AlertRule).where(AlertRule.user_id == user.id))]


@router.post("/alerts", status_code=201)
def create_alert(body: AlertRuleBody, session: Session = Depends(get_db), user: User = Depends(require_user)) -> AlertRuleOut:
    count = session.scalar(select(func.count()).select_from(AlertRule).where(AlertRule.user_id == user.id))
    if (count or 0) >= settings.max_rules_per_user:
        raise HTTPException(status_code=400, detail=f"Достигнут лимит правил ({settings.max_rules_per_user})")
    rule = AlertRule(
        user_id=user.id, name=body.name, distance_km=body.distance_km,
        status_filter=body.status_filter, confidence_min=body.confidence_min,
        queue_max=body.queue_max, scope=body.scope, is_active=body.is_active,
    )
    if body.fuel_code:
        from ..db.models import FuelType

        fuel = session.scalar(select(FuelType).where(FuelType.code == body.fuel_code))
        if fuel is None:
            raise HTTPException(status_code=422, detail=f"Неизвестный вид топлива: {body.fuel_code}")
        rule.fuel_type_id = fuel.id
    session.add(rule)
    session.commit()
    return AlertRuleOut(id=rule.id, name=rule.name, fuel_code=body.fuel_code, distance_km=rule.distance_km,
                        status_filter=rule.status_filter, confidence_min=rule.confidence_min,
                        queue_max=rule.queue_max, scope=rule.scope, is_active=rule.is_active)


@router.put("/alerts/{rule_id}")
def update_alert(rule_id: int, body: AlertRuleBody, session: Session = Depends(get_db), user: User = Depends(require_user)) -> AlertRuleOut:
    rule = session.get(AlertRule, rule_id)
    if rule is None or rule.user_id != user.id:
        raise HTTPException(status_code=404, detail="Правило не найдено")
    rule.name, rule.distance_km = body.name, body.distance_km
    rule.status_filter, rule.confidence_min = body.status_filter, body.confidence_min
    rule.queue_max, rule.scope, rule.is_active = body.queue_max, body.scope, body.is_active
    rule.fuel_type_id = None
    if body.fuel_code:
        from ..db.models import FuelType

        fuel = session.scalar(select(FuelType).where(FuelType.code == body.fuel_code))
        if fuel is None:
            raise HTTPException(status_code=422, detail=f"Неизвестный вид топлива: {body.fuel_code}")
        rule.fuel_type_id = fuel.id
    session.commit()
    return AlertRuleOut(id=rule.id, name=rule.name, fuel_code=body.fuel_code, distance_km=rule.distance_km,
                        status_filter=rule.status_filter, confidence_min=rule.confidence_min,
                        queue_max=rule.queue_max, scope=rule.scope, is_active=rule.is_active)


@router.delete("/alerts/{rule_id}", status_code=204)
def delete_alert(rule_id: int, session: Session = Depends(get_db), user: User = Depends(require_user)) -> Response:
    rule = session.get(AlertRule, rule_id)
    if rule is None or rule.user_id != user.id:
        raise HTTPException(status_code=404, detail="Правило не найдено")
    session.delete(rule)
    session.commit()
    return Response(status_code=204)
