"""Общие данные приложения: избранное, зоны мониторинга, правила, push (R21/R23/R26).

Пользователей нет — всё, что раньше было персональным, стало одним общим набором:
кто запустил приложение, тот и видит/меняет его. Оценка правил и события — T07.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..core.config import settings
from ..db.models import (
    AlertRule,
    Favorite,
    FuelType,
    MonitoringZone,
    PushSubscription,
    SourceProvider,
    Station,
)
from ..db.session import get_db
from .schemas import (
    AlertRuleBody,
    AlertRuleOut,
    FuelStatusBrief,
    PushSubscriptionBody,
    PushSubscriptionOut,
    QueueBrief,
    ZoneBody,
    ZoneOut,
)
from .stations import _snapshot, _station_brief

router = APIRouter(tags=["personal"])


def _station_or_404(session: Session, station_id: str) -> Station:
    station = session.get(Station, station_id)
    if station is None:
        raise HTTPException(status_code=404, detail="Станция не найдена")
    return station


# ---------- избранное (R21) ----------


@router.get("/favorites")
def list_favorites(session: Session = Depends(get_db)) -> list:
    rows = session.execute(
        select(Station).join(Favorite, Favorite.station_id == Station.id)
    ).scalars().all()
    if not rows:
        return []
    stations, brands, statuses = _snapshot(session)
    providers = {provider.id: provider.name for provider in session.scalars(select(SourceProvider))}
    result = []
    for station in rows:
        brand = brands.get(station.brand_id) if station.brand_id else None
        rows_s = statuses.get(station.id, [])
        briefs = [
            FuelStatusBrief(
                fuel_code=code,
                status=r.status,
                confidence=r.confidence,
                updated_at=r.updated_at,
                expires_at=r.expires_at,
                price=r.price,
                price_currency=r.price_currency,
                price_updated_at=r.price_updated_at,
                price_source_provider_id=r.price_source_provider_id,
                price_source=providers.get(r.price_source_provider_id) if r.price_source_provider_id else None,
            )
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
def add_favorite(station_id: str, session: Session = Depends(get_db)) -> dict:
    _station_or_404(session, station_id)
    existing = session.scalar(select(Favorite).where(Favorite.station_id == station_id))
    if existing is None:
        session.add(Favorite(station_id=station_id))
        session.commit()
        return {"station_id": station_id, "added": True}
    return {"station_id": station_id, "added": False}


@router.delete("/favorites/{station_id}", status_code=204)
def remove_favorite(station_id: str, session: Session = Depends(get_db)) -> Response:
    row = session.scalar(select(Favorite).where(Favorite.station_id == station_id))
    if row is None:
        raise HTTPException(status_code=404, detail="Станции нет в избранном")
    session.delete(row)
    session.commit()
    return Response(status_code=204)


# ---------- зоны мониторинга (R23) ----------


@router.get("/monitoring-zones")
def list_zones(session: Session = Depends(get_db)) -> list[ZoneOut]:
    return [ZoneOut(id=z.id, name=z.name, zone_type=z.zone_type, params=z.params)
            for z in session.scalars(select(MonitoringZone))]


@router.post("/monitoring-zones", status_code=201)
def create_zone(body: ZoneBody, session: Session = Depends(get_db)) -> ZoneOut:
    zone = MonitoringZone(name=body.name, zone_type=body.zone_type, params=body.params)
    session.add(zone)
    session.commit()
    return ZoneOut(id=zone.id, name=zone.name, zone_type=zone.zone_type, params=zone.params)


@router.put("/monitoring-zones/{zone_id}")
def update_zone(zone_id: int, body: ZoneBody, session: Session = Depends(get_db)) -> ZoneOut:
    zone = session.get(MonitoringZone, zone_id)
    if zone is None:
        raise HTTPException(status_code=404, detail="Зона не найдена")
    zone.name, zone.zone_type, zone.params = body.name, body.zone_type, body.params
    session.commit()
    return ZoneOut(id=zone.id, name=zone.name, zone_type=zone.zone_type, params=zone.params)


@router.delete("/monitoring-zones/{zone_id}", status_code=204)
def delete_zone(zone_id: int, session: Session = Depends(get_db)) -> Response:
    zone = session.get(MonitoringZone, zone_id)
    if zone is None:
        raise HTTPException(status_code=404, detail="Зона не найдена")
    session.delete(zone)
    session.commit()
    return Response(status_code=204)


# ---------- правила уведомлений (R26; оценка — T07) ----------


def _rule_out(session: Session, rule: AlertRule, fuel_code: str | None = None) -> AlertRuleOut:
    code = fuel_code
    if code is None and rule.fuel_type_id:
        fuel = session.get(FuelType, rule.fuel_type_id)
        code = fuel.code if fuel else None
    return AlertRuleOut(
        id=rule.id,
        name=rule.name,
        fuel_code=code,
        distance_km=rule.distance_km,
        status_filter=rule.status_filter,
        confidence_min=rule.confidence_min,
        queue_max=rule.queue_max,
        scope=rule.scope,
        is_active=rule.is_active,
        trigger_count=rule.trigger_count,
        last_event_at=rule.last_event_at,
    )


def _resolve_fuel(session: Session, fuel_code: str | None) -> int | None:
    if not fuel_code:
        return None
    fuel = session.scalar(select(FuelType).where(FuelType.code == fuel_code))
    if fuel is None:
        raise HTTPException(status_code=422, detail=f"Неизвестный вид топлива: {fuel_code}")
    return fuel.id


@router.get("/alerts")
def list_alerts(session: Session = Depends(get_db)) -> list[AlertRuleOut]:
    return [_rule_out(session, rule) for rule in session.scalars(select(AlertRule))]


@router.post("/alerts", status_code=201)
def create_alert(body: AlertRuleBody, session: Session = Depends(get_db)) -> AlertRuleOut:
    count = session.scalar(select(func.count()).select_from(AlertRule))
    if (count or 0) >= settings.max_alert_rules:
        raise HTTPException(status_code=400, detail=f"Достигнут лимит правил ({settings.max_alert_rules})")
    rule = AlertRule(
        name=body.name, distance_km=body.distance_km,
        status_filter=body.status_filter, confidence_min=body.confidence_min,
        queue_max=body.queue_max, scope=body.scope, is_active=body.is_active,
    )
    rule.fuel_type_id = _resolve_fuel(session, body.fuel_code)
    session.add(rule)
    session.commit()
    return _rule_out(session, rule, body.fuel_code)


@router.put("/alerts/{rule_id}")
def update_alert(rule_id: int, body: AlertRuleBody, session: Session = Depends(get_db)) -> AlertRuleOut:
    rule = session.get(AlertRule, rule_id)
    if rule is None:
        raise HTTPException(status_code=404, detail="Правило не найдено")
    rule.name, rule.distance_km = body.name, body.distance_km
    rule.status_filter, rule.confidence_min = body.status_filter, body.confidence_min
    rule.queue_max, rule.scope, rule.is_active = body.queue_max, body.scope, body.is_active
    rule.fuel_type_id = _resolve_fuel(session, body.fuel_code)
    session.commit()
    return _rule_out(session, rule, body.fuel_code)


@router.delete("/alerts/{rule_id}", status_code=204)
def delete_alert(rule_id: int, session: Session = Depends(get_db)) -> Response:
    rule = session.get(AlertRule, rule_id)
    if rule is None:
        raise HTTPException(status_code=404, detail="Правило не найдено")
    session.delete(rule)
    session.commit()
    return Response(status_code=204)


# ---------- push-подписки браузера (T14, R64/R97i) ----------


MAX_PUSH_SUBSCRIPTIONS = 20  # устройства/браузеры, которые получают push приложения


def _push_out(row: PushSubscription) -> PushSubscriptionOut:
    from urllib.parse import urlparse

    host = urlparse(row.endpoint).hostname or ""
    return PushSubscriptionOut(
        id=row.id,
        endpoint=row.endpoint,
        endpoint_host=host,
        is_active=row.is_active,
        created_at=row.created_at,
        last_success_at=row.last_success_at,
    )


@router.get("/push/subscriptions")
def list_push_subscriptions(session: Session = Depends(get_db)) -> list[PushSubscriptionOut]:
    return [
        _push_out(row)
        for row in session.scalars(select(PushSubscription).order_by(PushSubscription.id))
    ]


@router.post("/push/subscriptions", status_code=201)
def create_push_subscription(
    body: PushSubscriptionBody,
    request: Request,
    session: Session = Depends(get_db),
) -> PushSubscriptionOut:
    # Идемпотентность: тот же endpoint → обновляем ключи (браузер их ротирует), не плодим строки.
    # Лимит считаем только для НОВЫХ endpoint — иначе на пределе нельзя переподписать
    # уже существующий браузер (ротация ключей = тот же endpoint).
    row = session.scalar(select(PushSubscription).where(PushSubscription.endpoint == body.endpoint))
    if row is None:
        count = session.scalar(select(func.count()).select_from(PushSubscription))
        if (count or 0) >= MAX_PUSH_SUBSCRIPTIONS:
            raise HTTPException(status_code=400, detail=f"Достигнут лимит push-подписок ({MAX_PUSH_SUBSCRIPTIONS})")
        row = PushSubscription(endpoint=body.endpoint)
        session.add(row)
    row.p256dh = body.keys["p256dh"]
    row.auth = body.keys["auth"]
    row.user_agent = (request.headers.get("user-agent") or "")[:256]
    row.is_active = True
    row.last_error = ""
    session.commit()
    return _push_out(row)


@router.delete("/push/subscriptions/{subscription_id}", status_code=204)
def delete_push_subscription(
    subscription_id: int,
    session: Session = Depends(get_db),
) -> Response:
    row = session.get(PushSubscription, subscription_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Подписка не найдена")
    session.delete(row)
    session.commit()
    return Response(status_code=204)
