"""Route corridor geometry and station selection (R22)."""

from __future__ import annotations

import math

from sqlalchemy.orm import Session

from ..api.stations import _list_stations, _parse_preferred_brands
from .schemas import RoutePoint, RouteStation, RouteStationsRequest

EARTH_RADIUS_KM = 6371.0088


def _wrapped_longitude_delta(value: float) -> float:
    return (value + 180.0) % 360.0 - 180.0


def distance_to_segment_km(point: RoutePoint, start: RoutePoint, end: RoutePoint) -> float:
    """Distance to a geodesically short segment using a local projection."""
    reference_lat = math.radians((point.lat + start.lat + end.lat) / 3.0)

    def local(candidate: RoutePoint) -> tuple[float, float]:
        x = (
            math.radians(_wrapped_longitude_delta(candidate.lon - start.lon))
            * EARTH_RADIUS_KM
            * math.cos(reference_lat)
        )
        y = math.radians(candidate.lat - start.lat) * EARTH_RADIUS_KM
        return x, y

    px, py = local(point)
    ex, ey = local(end)
    length_squared = ex * ex + ey * ey
    if length_squared == 0:
        return math.hypot(px, py)
    position = max(0.0, min(1.0, (px * ex + py * ey) / length_squared))
    return math.hypot(px - position * ex, py - position * ey)


def distance_to_polyline_km(point: RoutePoint, polyline: list[RoutePoint]) -> float:
    """Minimum distance from a point to every consecutive route segment."""
    return min(
        distance_to_segment_km(point, start, end)
        for start, end in zip(polyline, polyline[1:], strict=False)
    )


def find_route_stations(session: Session, request: RouteStationsRequest) -> list[RouteStation]:
    """Apply standard fuel filters, then keep stations inside the corridor."""
    candidates = _list_stations(
        session,
        lat=None,
        lon=None,
        radius_km=None,
        bbox=None,
        city=request.city,
        brand=request.brand,
        fuel=request.fuel,
        status=request.status,
        confidence_min=request.confidence_min,
        queue_max=request.queue_max,
        sort=None,
        limit=10_000,
        offset=0,
        preferred_brands=_parse_preferred_brands(request.preferred_brands),
    )
    if request.fuel:
        candidates = [candidate for candidate in candidates if candidate.statuses]

    matches: list[RouteStation] = []
    for candidate in candidates:
        distance = distance_to_polyline_km(
            RoutePoint(lat=candidate.latitude, lon=candidate.longitude),
            request.polyline,
        )
        if distance <= request.corridor_km:
            rounded = round(distance, 3)
            payload = candidate.model_dump()
            payload["distance_km"] = rounded
            matches.append(RouteStation(**payload, distance_from_route_km=rounded))

    matches.sort(key=lambda station: station.distance_from_route_km)
    return matches[request.offset : request.offset + request.limit]
