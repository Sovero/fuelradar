"""Оценка правил и создание событий (R34–R38, R76).

Точка входа — `evaluate_rules(session, station_id, fuel_type_id)`, вызывается
ОДНОЙ строкой из `confidence.service.StatusService` после пересчёта агрегата
(`recompute_station_fuel`/`recompute_station_queue` — общие точки для записи
наблюдений и прямого пути воркера, см. `interfaces.md`). Никогда не поднимает
исключение наружу — это общий хук на самом горячем пути пересчёта статусов,
использующемся во ВСЕХ остальных тасках; сбой оценки правил не должен ронять
пересчёт confidence (см. try/except на верхнем уровне).

Правила и их CRUD — `backend/app/api/personal.py` (T05); эта зона только читает
`AlertRule`/создаёт `AlertEvent`. Соглашение о `scope` (JSON) — то же, что уже
использует планировщик приоритетов T06 (`worker.service.station_priority`):
  - {"station_id": "<id>"}                 — конкретная станция;
  - {"type": "favorites"} / {"favorites": true} — избранное пользователя;
  - {"type": "zone", "zone_id": <id>}      — зона мониторинга (CITY/CIRCLE/POLYGON);
  - {"brand_id": <id>} / {"network_id": <id>} — вся сеть;
  - {"lat": .., "lon": .., + rule.distance_km} — радиус вокруг точки (R76:
    «следить» из текущих фильтров без сохранённой зоны);
  - пусто/нераспознано                     — вся сеть (глобальное правило).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..core.config import settings
from ..db.models import (
    AlertEvent,
    AlertRule,
    Favorite,
    MonitoringZone,
    Station,
    StationCurrentStatus,
    User,
)
from ..dedup.compare import distance_km
from . import channels
from .events import FUEL_SCOPED_EVENTS, EventState, diff_event, queue_rank
from .models import AlertStateSnapshot

logger = logging.getLogger("fuelradar.alerts")


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def evaluate_rules(session: Session, station_id: str, fuel_type_id: int) -> list[AlertEvent]:
    """Диспетчер (см. docstring модуля) — не должен ронять вызывающую сторону."""
    try:
        return _evaluate_rules(session, station_id, fuel_type_id)
    except Exception as exc:  # noqa: BLE001 — общий хук в горячем пути пересчёта, не наш модуль не должен его ронять
        logger.exception(
            "evaluate_rules failed station_id=%s fuel_type_id=%s: %s", station_id, fuel_type_id, type(exc).__name__
        )
        return []


def _evaluate_rules(session: Session, station_id: str, fuel_type_id: int) -> list[AlertEvent]:
    row = session.scalar(
        select(StationCurrentStatus).where(
            StationCurrentStatus.station_id == station_id,
            StationCurrentStatus.fuel_type_id == fuel_type_id,
        )
    )
    if row is None:
        return []

    snapshot = session.scalar(
        select(AlertStateSnapshot).where(
            AlertStateSnapshot.station_id == station_id,
            AlertStateSnapshot.fuel_type_id == fuel_type_id,
        )
    )
    old_state = EventState(snapshot.status, snapshot.confidence, snapshot.queue_level) if snapshot else None
    new_state = EventState(row.status, row.confidence, row.queue_level)

    if snapshot is None:
        snapshot = AlertStateSnapshot(station_id=station_id, fuel_type_id=fuel_type_id)
        session.add(snapshot)
    snapshot.status = new_state.status
    snapshot.confidence = new_state.confidence
    snapshot.queue_level = new_state.queue_level
    snapshot.updated_at = _now()
    session.flush()

    event_type = diff_event(old_state, new_state)
    if event_type is None:
        return []  # R37 — состояние не изменилось значимо, уведомление не шлём

    station = session.get(Station, station_id)
    if station is None:
        return []

    now = _now()
    bucket = int(now.timestamp() // (max(1, settings.alert_dedup_window_minutes) * 60))
    # QUEUE_*/иные не-fuel-специфичные события — общий ключ по станции (не по
    # топливу), чтобы несколько строк топлива одной станции не дали 2-3 письма
    # на одно и то же изменение очереди в одном пересчёте.
    scope_key = fuel_type_id if event_type in FUEL_SCOPED_EVENTS else "ALL"

    created: list[AlertEvent] = []
    for rule in session.scalars(select(AlertRule).where(AlertRule.is_active.is_(True))):
        try:
            user = session.get(User, rule.user_id)
            if user is None:
                continue  # правило без живого пользователя — не наш случай в проде, защита от мусора в тестах
            if not _rule_matches(session, rule, station, new_state, fuel_type_id):
                continue
            dedup_key = f"{rule.id}:{station_id}:{scope_key}:{event_type}:{bucket}"
            event = AlertEvent(
                rule_id=rule.id, user_id=rule.user_id, station_id=station_id, event_type=event_type,
                dedup_key=dedup_key, delivered=False,
                payload={
                    "fuel_type_id": fuel_type_id,
                    "status": new_state.status,
                    "confidence": new_state.confidence,
                    "queue_level": new_state.queue_level,
                    "previous_status": old_state.status if old_state else None,
                },
            )
            try:
                with session.begin_nested():
                    session.add(event)
                    session.flush()
            except IntegrityError:
                continue  # R38 — то же событие для этого правила уже отправлено в окне
            rule.trigger_count = (rule.trigger_count or 0) + 1
            rule.last_event_at = now
            _deliver(user, event, station)
            created.append(event)
        except Exception as exc:  # noqa: BLE001 — одно кривое правило не должно рушить оценку остальных
            logger.exception("evaluate_rules: rule %s failed: %s", rule.id, type(exc).__name__)
            continue
    return created


def _rule_matches(session: Session, rule: AlertRule, station: Station, new_state: EventState, fuel_type_id: int) -> bool:
    if rule.fuel_type_id is not None and rule.fuel_type_id != fuel_type_id:
        return False
    if rule.status_filter is not None and rule.status_filter != new_state.status:
        return False
    if rule.confidence_min is not None and new_state.confidence < rule.confidence_min:
        return False
    if rule.queue_max is not None:
        max_rank, cur_rank = queue_rank(rule.queue_max), queue_rank(new_state.queue_level)
        if max_rank is None or cur_rank is None or cur_rank > max_rank:
            return False
    return _scope_matches(session, rule, station)


def _scope_matches(session: Session, rule: AlertRule, station: Station) -> bool:
    scope = rule.scope or {}
    if scope.get("station_id") == station.id:
        return True
    kind = scope.get("type", "")
    if kind == "favorites" or scope.get("favorites"):
        return session.scalar(
            select(Favorite.id).where(Favorite.user_id == rule.user_id, Favorite.station_id == station.id)
        ) is not None
    zone_id = scope.get("zone_id")
    if zone_id is not None:
        zone = session.get(MonitoringZone, zone_id)
        return zone is not None and zone.user_id == rule.user_id and _in_zone(station, zone)
    brand_id = scope.get("brand_id", scope.get("network_id"))
    if brand_id is not None:
        return station.brand_id == brand_id
    lat, lon = scope.get("lat"), scope.get("lon")
    if lat is not None and lon is not None and rule.distance_km:
        try:
            return distance_km(float(lat), float(lon), station.latitude, station.longitude) <= rule.distance_km
        except (TypeError, ValueError):
            return False
    # Пустой/нераспознанный scope — правило «по всей сети» (R77: сеть — только
    # сортировка приоритета сбора, для уведомлений это честный глобальный охват).
    if not scope or kind in ("", "network", "all"):
        return True
    return False


def _in_zone(station: Station, zone: MonitoringZone) -> bool:
    """Локальная копия семантики `worker.service.in_zone` (см. модуль там же,
    T06) — не импортируем оттуда, чтобы не тянуть зависимость alerts→worker."""
    params = zone.params or {}
    kind = (zone.zone_type or "").upper()
    if kind == "CITY":
        return station.city.casefold() == str(params.get("city", "")).casefold()
    if kind == "CIRCLE":
        lat, lon = params.get("lat"), params.get("lon")
        if lat is None or lon is None:
            return False
        radius = params.get("radius_km", params.get("radius", 0))
        try:
            return distance_km(station.latitude, station.longitude, float(lat), float(lon)) <= float(radius)
        except (TypeError, ValueError):
            return False
    points = params.get("polygon", params.get("points", params.get("coordinates", [])))
    if isinstance(points, dict):
        points = points.get("coordinates", [])
    if points and isinstance(points[0][0], list):
        points = points[0]
    if len(points) < 3:
        return False
    x, y = station.longitude, station.latitude
    inside = False
    for i, (x1, y1) in enumerate(points):
        x2, y2 = points[i - 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-12) + x1:
            inside = not inside
    return inside


def _deliver(user: User, event: AlertEvent, station: Station) -> None:
    """In-app — сам факт строки AlertEvent (R36/A03); push/TG — best-effort."""
    try:
        channels.send_web_push(user, event, station)
    except Exception as exc:  # noqa: BLE001 — доставка не должна ронять оценку правил
        logger.exception("web push delivery failed rule=%s event=%s: %s", event.rule_id, event.id, type(exc).__name__)
    try:
        channels.send_telegram(user, event, station)
    except Exception as exc:  # noqa: BLE001 — доставка не должна ронять оценку правил
        logger.exception("telegram delivery failed rule=%s event=%s: %s", event.rule_id, event.id, type(exc).__name__)


__all__ = ["evaluate_rules"]
