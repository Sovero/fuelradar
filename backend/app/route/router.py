"""Public Route Mode API (R22): коридор станций и дорожный маршрут (R22.1)."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db.session import get_db
from ..routing import plan_road_route
from .schemas import (
    RoutePlanRequest,
    RoutePlanResponse,
    RoutePlanStep,
    RouteStation,
    RouteStationsRequest,
)
from .service import find_route_stations

router = APIRouter(prefix="/route", tags=["route"])


@router.post("/stations")
def route_stations(
    body: RouteStationsRequest,
    session: Session = Depends(get_db),
) -> list[RouteStation]:
    """Return active stations within the selected point-to-point corridor."""
    return find_route_stations(session, body)


@router.post("/plan")
def route_plan(body: RoutePlanRequest) -> RoutePlanResponse:
    """Дорожный маршрут по точкам в порядке движения (по улицам, с односторонними).

    Роутер (OSRM-совместимый) берётся из конфигурации; если он недоступен или не
    настроен, отвечаем ``is_road_route=False`` с причиной — фронтенд нарисует
    прямую линию и честно скажет, почему дорожного маршрута нет (R97i).
    """
    points = [(point.lat, point.lon) for point in body.polyline]
    route, reason = plan_road_route(points)
    if route is None:
        return RoutePlanResponse(is_road_route=False, reason=reason)

    return RoutePlanResponse(
        is_road_route=True,
        provider=route.provider,
        distance_km=route.distance_km,
        duration_min=route.duration_min,
        geometry=route.geometry,
        steps=[
            RoutePlanStep(
                type=step.type,
                modifier=step.modifier,
                street=step.street,
                distance_m=step.distance_m,
                duration_s=step.duration_s,
                lat=step.lat,
                lon=step.lon,
            )
            for step in route.steps
        ],
    )
