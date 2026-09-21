"""Дорожный маршрут (R22.1): OSRM-совместимый роутер, геометрия по улицам."""

from .service import (
    MAX_GEOMETRY_POINTS,
    MAX_STEPS,
    REASON_NO_ROUTE,
    REASON_NOT_CONFIGURED,
    REASON_PROVIDER_UNAVAILABLE,
    RoadRoute,
    RouteStep,
    RoutingError,
    build_route_url,
    parse_route_payload,
    plan_road_route,
    route_base_url,
)

__all__ = [
    "MAX_GEOMETRY_POINTS",
    "MAX_STEPS",
    "REASON_NOT_CONFIGURED",
    "REASON_NO_ROUTE",
    "REASON_PROVIDER_UNAVAILABLE",
    "RoadRoute",
    "RouteStep",
    "RoutingError",
    "build_route_url",
    "parse_route_payload",
    "plan_road_route",
    "route_base_url",
]
