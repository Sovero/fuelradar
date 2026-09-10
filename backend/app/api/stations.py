"""Эндпоинты станций (T05, §14, R63/R65/R82/R92).

Список с фильтрами (lat/lon/radius, bbox, city, brand, fuel, status,
confidence_min, queue_max), сортировки, пагинация; nearby — обёртка точка+радиус;
карточка со статусами, confidence, разбором «почему» (R92) и score_breakdown;
история наблюдений (R17). Анонимно (R65). Кэш списка/карты — R82.
"""

from __future__ import annotations

import math
from copy import deepcopy
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..analytics.models import AnalyticsSnapshot
from ..core.config import settings
from ..db.models import (
    FuelObservation,
    FuelType,
    QueueObservation,
    SourceProvider,
    Station,
    StationBrand,
    StationCurrentStatus,
    StationExternalId,
)
from ..db.session import get_db
from ..dedup.compare import distance_km
from ..fuel_status import FUEL_STATUSES, QUEUE_LEVELS, UNKNOWN
from ..normalization import normalize_brand, normalize_fuel
from ..ranking import (
    FUEL_STATUS_VALUE,
    ScoreInput,
    eta_minutes,
)
from ..ranking import (
    score as compute_score,
)
from . import cache
from .deps import optional_user
from .schemas import FuelStatusBrief, HistoryItem, QueueBrief, StationBrief, StationDetail

router = APIRouter(tags=["stations"])

QUEUE_SEVERITY = {"NONE": 0, "LOW": 1, "MEDIUM": 2, "HIGH": 3, "VERY_HIGH": 4}
SORTS = ("distance", "confidence", "availability", "queue", "travel_time", "score")


def _fail(message: str) -> None:
    raise HTTPException(status_code=422, detail=message)


def _parse_preferred_brands(raw: str | None) -> tuple[int, ...]:
    """R77: «предпочтения сетей» — ID брендов из `/meta`, через запятую (`?preferred_brands=3,7`)."""
    if not raw:
        return ()
    try:
        return tuple(sorted({int(part) for part in raw.split(",") if part.strip()}))
    except ValueError:
        _fail("preferred_brands должен быть списком числовых ID через запятую")


def _validate_geo(lat: float | None, lon: float | None, radius_km: float | None, bbox: str | None):
    """Валидация гео-параметров с русскими сообщениями (R67)."""
    if lat is not None and not -90 <= lat <= 90:
        _fail("широта lat должна быть в диапазоне от −90 до 90")
    if lon is not None and not -180 <= lon <= 180:
        _fail("долгота lon должна быть в диапазоне от −180 до 180")
    if (lat is None) != (lon is None):
        _fail("нужны оба параметра lat и lon вместе (или bbox)")
    if radius_km is not None and lat is None:
        _fail("Для радиуса нужны lat и lon")
    if radius_km is not None and not 0 < radius_km <= 500:
        _fail("радиус radius_km должен быть от 0 до 500 км")
    box = None
    if bbox:
        parts = [p.strip() for p in bbox.split(",")]
        if len(parts) != 4:
            _fail("bbox задаётся четырьмя числами через запятую: south,west,north,east")
        try:
            s, w, n, e = (float(p) for p in parts)
        except ValueError:
            _fail("bbox должен содержать числа: south,west,north,east")
        if not (-90 <= s <= 90 and -90 <= n <= 90 and -180 <= w <= 180 and -180 <= e <= 180):
            _fail("координаты bbox вне допустимых диапазонов широты/долготы")
        if s >= n or w >= e:
            _fail("bbox: south должен быть меньше north, west — меньше east")
        box = (s, w, n, e)
    return box


def _validate_filters(
    fuel: str | None,
    status: str | None,
    confidence_min: int | None,
    queue_max: str | None,
    price_max: float | None = None,
):
    fuel_code = None
    if fuel:
        fuel_code = normalize_fuel(fuel).base_code
        # «БЕНЗИН-Х» нормализуется в UNKNOWN, а UNKNOWN — это «нет данных», не фильтр (R15)
        if fuel_code not in _fuel_codes() or fuel_code in ("UNKNOWN", "OTHER"):
            _fail(f"неизвестный вид топлива: {fuel}")
    if status is not None and status not in FUEL_STATUSES:
        _fail(f"статус должен быть одним из {', '.join(FUEL_STATUSES)}")
    if confidence_min is not None and not 0 <= confidence_min <= 100:
        _fail("confidence_min должен быть от 0 до 100")
    if queue_max is not None and queue_max not in QUEUE_LEVELS:
        _fail(f"queue_max должен быть одним из {', '.join(QUEUE_LEVELS)}")
    if price_max is not None:
        # R78.1: «дешевле X» — валидируется (>0), применяется только с топливом.
        if not math.isfinite(price_max) or price_max <= 0:
            _fail("price_max должен быть положительным числом")
        if fuel is None:
            _fail("фильтр price_max требует указания вида топлива (fuel) — цена сравнивается по конкретному виду")
    return fuel_code


_fuel_codes_cache: set[str] | None = None


def _fuel_codes() -> set[str]:
    global _fuel_codes_cache
    if _fuel_codes_cache is None:
        from ..db.session import SessionLocal

        with SessionLocal() as session:
            _fuel_codes_cache = set(session.scalars(select(FuelType.code)))
    return _fuel_codes_cache


def _snapshot(session: Session, *, lat=None, lon=None, radius_km=None, bbox=None):
    """Станции + статусы + бренды одним заходом (масштаб MVP — норм)."""
    query = select(Station).where(Station.is_active.is_(True))
    if bbox:
        south, west, north, east = _validate_geo(None, None, None, bbox)
        query = query.where(Station.latitude.between(south, north), Station.longitude.between(west, east))
    if lat is not None and radius_km is not None:
        if session.get_bind().dialect.name == "postgresql":
            query = query.where(text("ST_DWithin(geog, ST_SetSRID(ST_MakePoint(:lon,:lat),4326)::geography,:meters)")).params(lon=lon, lat=lat, meters=radius_km * 1000)
        else:
            delta_lat = radius_km / 110.0
            query = query.where(Station.latitude.between(lat-delta_lat, lat+delta_lat))
            cosine = abs(math.cos(math.radians(lat)))
            if cosine > 0.01:
                delta_lon = radius_km / (110.0 * cosine)
                if -180 <= lon-delta_lon and lon+delta_lon <= 180:
                    query = query.where(Station.longitude.between(lon-delta_lon, lon+delta_lon))
    stations = list(session.scalars(query))
    brands = {b.id: b for b in session.scalars(select(StationBrand))}
    statuses: dict[str, list[tuple[StationCurrentStatus, str]]] = {}
    rows = session.execute(
        select(StationCurrentStatus, FuelType.code).join(FuelType, StationCurrentStatus.fuel_type_id == FuelType.id)
        .where(StationCurrentStatus.station_id.in_([station.id for station in stations]))
    ).all()
    for row, fuel_code in rows:
        statuses.setdefault(row.station_id, []).append((row, fuel_code))
    return stations, brands, statuses


def _station_brief(
    station: Station,
    brand: StationBrand | None,
    fuel_statuses: list[FuelStatusBrief],
    queue: QueueBrief | None,
    distance: float | None,
    priority: int | None,
) -> tuple[StationBrief, dict]:
    """Возвращает (карточка, score_breakdown) — единственное место, где считается
    Score, чтобы список и карточка станции никогда не могли разойтись (было:
    `station_detail` пересчитывал Score второй раз с похожим, но не тем же
    набором параметров, и терял разбор для станций без наблюдений)."""
    best = max(fuel_statuses, key=lambda s: FUEL_STATUS_VALUE.get(s.status, 0.0), default=None)
    age = None
    if best is not None and best.updated_at is not None:
        age = max(0, int((datetime.now(UTC).replace(tzinfo=None) - best.updated_at).total_seconds() // 60))
    distance = round(distance, 3) if distance is not None else None
    score_result = compute_score(
        ScoreInput(
            fuel_status=best.status if best else UNKNOWN,
            confidence=best.confidence if best else 0,
            observed_age_minutes=age,
            distance_km=distance,
            queue_level=queue.level if queue else UNKNOWN,
            network_priority=priority,
        )
    )
    wait = queue.estimated_wait_minutes if queue else None
    eta = eta_minutes(distance, wait) if distance is not None else None
    brief = StationBrief(
        id=station.id,
        name=station.canonical_name,
        brand=brand.name if brand else None,
        latitude=station.latitude,
        longitude=station.longitude,
        address=station.address,
        city=station.city,
        distance_km=distance,
        eta_minutes=eta,
        statuses=sorted(fuel_statuses, key=lambda s: s.fuel_code),
        queue=queue,
        score=score_result.score,
    )
    return brief, score_result.breakdown


def _list_stations(
    session: Session,
    *,
    lat: float | None,
    lon: float | None,
    radius_km: float | None,
    bbox: str | None,
    city: str | None,
    brand: str | None,
    fuel: str | None,
    status: str | None,
    confidence_min: int | None,
    queue_max: str | None,
    price_max: float | None = None,  # R78.1 — «дешевле X», только вместе с fuel
    sort: str | None,
    limit: int,
    offset: int,
    preferred_brands: tuple[int, ...] = (),
) -> list[StationBrief]:
    _validate_geo(lat, lon, radius_km, bbox)
    fuel_code = _validate_filters(fuel, status, confidence_min, queue_max, price_max)
    if sort is not None and sort not in SORTS:
        _fail(f"sort должен быть одним из {', '.join(SORTS)}")

    stations, brands, statuses = _snapshot(session, lat=lat, lon=lon, radius_km=radius_km, bbox=bbox)
    providers = {provider.id: provider.name for provider in session.scalars(select(SourceProvider))}
    brand_canon = normalize_brand(brand) if brand else None
    box = _validate_geo(None, None, None, bbox) if bbox else None

    items: list[StationBrief] = []
    for station in stations:
        if city and city.lower() not in (station.city or "").lower():
            continue
        brand_row = brands.get(station.brand_id) if station.brand_id else None
        if brand_canon:
            if brand_row is None or brand_row.name.lower() != brand_canon.lower():
                continue
        rows = statuses.get(station.id, [])
        briefs = [
            FuelStatusBrief(
                fuel_code=code,
                status=row.status,
                confidence=row.confidence,
                updated_at=row.updated_at,
                expires_at=row.expires_at,
                price=row.price,
                price_currency=row.price_currency,
                price_updated_at=row.price_updated_at,
                price_source_provider_id=row.price_source_provider_id,
                price_source=providers.get(row.price_source_provider_id) if row.price_source_provider_id else None,
            )
            for row, code in rows
        ]
        if fuel_code:
            briefs = [b for b in briefs if b.fuel_code == fuel_code]
        if status is not None and not any(b.status == status for b in briefs):
            continue
        if price_max is not None:
            # R78.1: станция без цены на выбранное топливо — не «дешёвая», она исключается.
            if not any(b.fuel_code == fuel_code and b.price is not None and b.price <= price_max for b in briefs):
                continue
        if confidence_min is not None:
            confs = [b.confidence for b in briefs if (fuel_code is None or b.fuel_code == fuel_code)]
            if not confs or max(confs, default=0) < confidence_min:
                continue
        queue_row = max(rows, key=lambda r: r[0].confidence, default=None)
        queue = None
        if queue_row is not None:
            r = queue_row[0]
            queue = QueueBrief(level=r.queue_level, vehicles=r.queue_vehicles, estimated_wait_minutes=r.estimated_wait_minutes)
        if queue_max is not None:
            sev = QUEUE_SEVERITY.get(queue.level if queue else UNKNOWN)
            if (queue_max == UNKNOWN and sev is not None) or (queue_max != UNKNOWN and sev is not None and sev > QUEUE_SEVERITY[queue_max]):
                continue

        distance = None
        if lat is not None and lon is not None:
            distance = distance_km(lat, lon, station.latitude, station.longitude)
            if radius_km is not None and distance > radius_km:
                continue
        if box is not None:
            s, w, n, e = box
            if not (s <= station.latitude <= n and w <= station.longitude <= e):
                continue

        priority = brand_row.priority if brand_row else None
        if preferred_brands and brand_row is not None and brand_row.id in preferred_brands:
            priority = 1  # R77: личное предпочтение сети — как высший приоритет для этого запроса
        brief, _ = _station_brief(station, brand_row, briefs, queue, distance, priority)
        items.append(brief)

    sort_key = sort or ("distance" if lat is not None and lon is not None else "score")
    if sort_key in ("distance", "travel_time"):
        items.sort(key=lambda i: (i.distance_km is None, i.distance_km if i.distance_km is not None else 0.0))
    elif sort_key == "confidence":
        items.sort(key=lambda i: max((s.confidence for s in i.statuses), default=0), reverse=True)
    elif sort_key == "availability":
        items.sort(key=lambda i: max((FUEL_STATUS_VALUE.get(s.status, 0.0) for s in i.statuses), default=0.0), reverse=True)
    elif sort_key == "queue":
        items.sort(key=lambda i: QUEUE_SEVERITY.get(i.queue.level if i.queue else UNKNOWN, 5))
    else:  # score
        items.sort(key=lambda i: i.score if i.score is not None else -1, reverse=True)

    return items[offset : offset + limit]


def _cached_list(request: Request, response: Response, session: Session, **params) -> list[StationBrief]:
    key = cache.cache_key(request.url.path, params, cache.data_revision(session))
    ttl = settings.api_cache_ttl_seconds
    hit, value = cache.get_cached(key, ttl)
    if hit and not any(status.expires_at and status.expires_at.replace(tzinfo=None) <= datetime.now(UTC).replace(tzinfo=None) and status.status != UNKNOWN for station in value for status in station.statuses):
        response.headers["X-Cache"] = "HIT"
        return value  # type: ignore[return-value]
    result = _list_stations(session, **params)
    cache.store(key, result, ttl)
    response.headers["X-Cache"] = "MISS"
    return result


@router.get("/stations/nearby")
def nearby(
    request: Request,
    response: Response,
    lat: float | None = None,
    lon: float | None = None,
    bbox: str | None = None,
    radius: float | None = None,
    radius_km: float | None = Query(None),
    city: str | None = None,
    brand: str | None = None,
    fuel: str | None = None,
    status: str | None = None,
    confidence_min: int | None = None,
    queue_max: str | None = None,
    price_max: float | None = None,
    sort: str | None = None,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    preferred_brands: str | None = None,
    session: Session = Depends(get_db),
    _: object = Depends(optional_user),
) -> list[StationBrief]:
    """Станции вокруг точки (R63); радиус по умолчанию — из региона (§18)."""
    if lat is None and bbox is None:
        _fail("Укажите lat и lon или bbox")
    selected_radius = radius_km if radius_km is not None else radius
    if selected_radius is None and lat is not None:
        selected_radius = settings.default_region_radius_km
    return _cached_list(
        request, response, session,
        lat=lat, lon=lon, radius_km=selected_radius, bbox=bbox,
        city=city, brand=brand, fuel=fuel, status=status, confidence_min=confidence_min,
        queue_max=queue_max, price_max=price_max, sort=sort, limit=limit, offset=offset,
        preferred_brands=_parse_preferred_brands(preferred_brands),
    )


@router.get("/stations")
def list_stations(
    request: Request,
    response: Response,
    lat: float | None = None,
    lon: float | None = None,
    radius_km: float | None = None,
    radius: float | None = None,
    bbox: str | None = None,
    city: str | None = None,
    brand: str | None = None,
    fuel: str | None = None,
    status: str | None = None,
    confidence_min: int | None = None,
    queue_max: str | None = None,
    price_max: float | None = None,
    sort: str | None = None,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    preferred_brands: str | None = None,
    session: Session = Depends(get_db),
    _: object = Depends(optional_user),
) -> list[StationBrief]:
    return _cached_list(
        request, response, session,
        lat=lat, lon=lon, radius_km=radius_km if radius_km is not None else radius, bbox=bbox,
        city=city, brand=brand, fuel=fuel, status=status, confidence_min=confidence_min,
        queue_max=queue_max, price_max=price_max, sort=sort, limit=limit, offset=offset,
        preferred_brands=_parse_preferred_brands(preferred_brands),
    )


@router.get("/stations/{station_id}")
def station_detail(
    station_id: str,
    lat: float | None = None,
    lon: float | None = None,
    fuel: str | None = None,
    preferred_brands: str | None = None,
    session: Session = Depends(get_db),
    _: object = Depends(optional_user),
) -> StationDetail:
    """Карточка: статусы, «почему» с источниками (R92), score_breakdown, ETA (R45)."""
    if lat is not None and not -90 <= lat <= 90:
        _fail("широта lat должна быть в диапазоне от −90 до 90")
    if lon is not None and not -180 <= lon <= 180:
        _fail("долгота lon должна быть в диапазоне от −180 до 180")
    if (lat is None) != (lon is None):
        _fail("нужны оба параметра lat и lon вместе")

    station = session.get(Station, station_id)
    if station is None or not station.is_active:
        raise HTTPException(status_code=404, detail="Станция не найдена")
    brand = session.get(StationBrand, station.brand_id) if station.brand_id else None
    providers = {provider.id: provider.name for provider in session.scalars(select(SourceProvider))}
    rows = session.execute(
        select(StationCurrentStatus, FuelType.code).join(FuelType, StationCurrentStatus.fuel_type_id == FuelType.id)
        .where(StationCurrentStatus.station_id == station_id)
    ).all()
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
        for r, code in rows
    ]
    selected_fuel = _validate_filters(fuel, None, None, None) if fuel else None
    explanation_rows = [row for row in rows if selected_fuel is None or row[1] == selected_fuel]
    top = max(explanation_rows, key=lambda r: r[0].confidence, default=None)
    queue = None
    if top is not None:
        r = top[0]
        queue = QueueBrief(level=r.queue_level, vehicles=r.queue_vehicles, estimated_wait_minutes=r.estimated_wait_minutes)

    distance = distance_km(lat, lon, station.latitude, station.longitude) if lat is not None and lon is not None else None
    priority = brand.priority if brand else None
    preferred = _parse_preferred_brands(preferred_brands)
    if preferred and brand is not None and brand.id in preferred:
        priority = 1  # R77: см. то же правило в _list_stations
    brief, breakdown = _station_brief(station, brand, briefs, queue, distance, priority)

    explanation: dict = {}
    if top is not None:
        explanation = deepcopy(top[0].status_explanation or {})
        for c in explanation.get("contributions", []):
            provider = session.get(SourceProvider, c.get("source_provider_id"))
            if provider is not None:
                c["source"] = provider.name
                c["label"] = f"{provider.name} — {c.get('age_minutes', 0)} минут назад"
        if top[0].expires_at <= datetime.now(UTC).replace(tzinfo=None):
            explanation = {"status": UNKNOWN, "reason": "Наблюдения устарели", "contributions": []}
        if top[0].status_explanation:
            explanation.setdefault("status", top[0].status)
            explanation.setdefault("note", "разбор вкладов источников (R71/R92)")

    ext_ids = session.execute(
        select(SourceProvider.code, StationExternalId.external_id)
        .join(StationExternalId, StationExternalId.source_provider_id == SourceProvider.id)
        .where(StationExternalId.station_id == station_id)
    ).all()

    return StationDetail(
        **brief.model_dump(),
        phone=station.phone,
        opening_hours=station.opening_hours,
        external_ids={code: ext for code, ext in ext_ids},
        score_breakdown=breakdown,
        status_explanation=explanation,
    )


@router.get("/stations/{station_id}/history")
def station_history(
    station_id: str,
    fuel: str | None = None,
    limit: int = Query(100, ge=1, le=500),
    session: Session = Depends(get_db),
    _: object = Depends(optional_user),
) -> list[HistoryItem]:
    """История наблюдений (R17): серия статусов для графика."""
    station = session.get(Station, station_id)
    if station is None:
        raise HTTPException(status_code=404, detail="Станция не найдена")
    fuel_code = None
    if fuel:
        fuel_code = normalize_fuel(fuel).base_code
        if fuel_code not in _fuel_codes():
            _fail(f"неизвестный вид топлива: {fuel}")
    query = (
        select(FuelObservation, FuelType.code, SourceProvider.name)
        .join(FuelType, FuelObservation.fuel_type_id == FuelType.id)
        .join(SourceProvider, FuelObservation.source_provider_id == SourceProvider.id)
        .where(FuelObservation.station_id == station_id)
        .order_by(FuelObservation.observed_at.desc(), FuelObservation.id.desc())
        .limit(limit)
    )
    if fuel_code:
        query = query.where(FuelType.code == fuel_code)
    return [
        HistoryItem(
            fuel_code=code,
            status=row.status,
            source=name,
            observed_at=row.observed_at,
            received_at=row.received_at,
            confidence_raw=row.confidence_raw,
            price=row.price,
            price_currency=row.currency,
        )
        for row, code, name in session.execute(query).all()
    ]

@router.get("/stations/{station_id}/fuel")
def station_fuel(station_id: str, session: Session = Depends(get_db)) -> list[FuelStatusBrief]:
    """Current fuel statuses for a station."""
    return station_detail(station_id, session=session).statuses


@router.get("/stations/{station_id}/queue-history")
def queue_history(station_id: str, limit: int = Query(100, ge=1, le=500), session: Session = Depends(get_db)) -> list[dict]:
    """Original queue observations in reverse chronological order."""
    if session.get(Station, station_id) is None:
        raise HTTPException(status_code=404, detail="Станция не найдена")
    rows = session.execute(select(QueueObservation, SourceProvider.name).join(SourceProvider, QueueObservation.source_provider_id == SourceProvider.id).where(QueueObservation.station_id == station_id).order_by(QueueObservation.observed_at.desc()).limit(limit))
    return [{"level": row.queue_level, "vehicles": row.queue_vehicles, "source": source, "observed_at": row.observed_at} for row, source in rows]


@router.get("/stations/{station_id}/forecast")
def station_forecast(
    station_id: str,
    session: Session = Depends(get_db),
) -> dict:
    """Прогноз появления/исчезновения топлива (R49, §23): только снэпшот.

    Прозрачная эвристика по истории (не ML, R49.1); при малой истории —
    probability/ETA = null и русская причина (R49.2). is_forecast=true — всегда.
    """
    station = session.get(Station, station_id)
    if station is None or not station.is_active:
        raise HTTPException(status_code=404, detail="Станция не найдена")
    snapshot = session.get(AnalyticsSnapshot, 1)
    if snapshot is None:
        raise HTTPException(status_code=503, detail="Аналитика ещё не посчитана — фоновый пересчёт не запускался")
    from ..analytics.forecast import forecast_for_station

    return forecast_for_station(snapshot.payload, station_id)
