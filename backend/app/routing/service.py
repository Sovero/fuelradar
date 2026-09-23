"""Дорожный маршрут по улицам — с учётом односторонних и запретов поворотов (R22.1).

Провайдер — OSRM-совместимый HTTP-роутер; адрес и профиль берутся только из
конфигурации (``ROUTING_BASE_URL``/``ROUTING_PROFILE``), в коде ни регион, ни
провайдер не зашиты. По умолчанию — публичный демо-сервер OSRM без ключей, как
OSM-тайлы карты. Профиль по умолчанию ``driving``: маршрут идёт по дорогам и
улицам дорожной сети OSM, а односторонние улицы и запреты поворотов учитывает
сам граф провайдера — мы лишь передаём точки в порядке движения.

Недоступность роутера — честный отказ (R97i): вызывающий получает причину
(``not_configured``/``provider_unavailable``/``no_route``) и рисует прямую линию,
не выдавая её за дорожный маршрут.

Чистые функции без сети — ``build_route_url`` и ``parse_route_payload``: их
покрывают юнит-тесты, реальный транспорт подменяется (как в ``sources/*``).
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from ..core.config import settings

# OSRM с ``overview=full`` отдаёт геометрию по каждому узлу дороги: для длинного
# маршрута это тысячи координат. Прореживаем равномерно, сохраняя первую и
# последнюю точки — линия остаётся по улицам, но ответ не раздувается.
MAX_GEOMETRY_POINTS = 400
MAX_STEPS = 40

REASON_NOT_CONFIGURED = "not_configured"
REASON_PROVIDER_UNAVAILABLE = "provider_unavailable"
REASON_NO_ROUTE = "no_route"


class RoutingError(RuntimeError):
    """Транспортная ошибка роутера (сеть, HTTP-статус, лимит запросов)."""


@dataclass(slots=True)
class RouteStep:
    """Один шаг маршрута: машиночитаемый тип + улица + длина/время.

    ``lat``/``lon`` — точка самого маневра (``maneuver.location`` у OSRM):
    интерфейс перелетает к ней камерой, когда пользователь кликает по подписи
    расстояния и вкладка подсвечивает этот шаг. Если роутер её не отдал —
    координаты остаются пустыми, и фронт берёт точку из геометрии.
    """

    type: str
    modifier: str | None
    street: str | None
    distance_m: float
    duration_s: float
    lat: float | None = None
    lon: float | None = None


@dataclass(slots=True)
class RoadRoute:
    """Дорожный маршрут: реальная длина, время и геометрия по улицам."""

    distance_km: float
    duration_min: float
    geometry: list[dict[str, float]]
    steps: list[RouteStep]
    provider: str


def route_base_url() -> str:
    """Адрес роутера из конфигурации; пусто → маршрут по дорогам недоступен."""
    return (settings.routing_base_url or "").strip()


def build_route_url(
    points: Sequence[tuple[float, float]],
    *,
    base: str | None = None,
    profile: str | None = None,
) -> str:
    """URL запроса к OSRM-совместимому роутеру.

    Точки передаются парами ``(lat, lon)``, а в URL уходят в порядке ``lon,lat``
    (так требует OSRM) и разделяются ``;`` — порядок точек задаёт направление
    движения от начала к концу.
    """
    resolved_base = (base if base is not None else route_base_url()).rstrip("/")
    resolved_profile = (profile if profile is not None else settings.routing_profile) or "driving"
    coordinates = ";".join(f"{lon:.6f},{lat:.6f}" for lat, lon in points)
    return (
        f"{resolved_base}/route/v1/{resolved_profile}/{coordinates}"
        "?overview=full&geometries=geojson&steps=true"
    )


def _decimate(points: list[dict[str, float]], max_points: int = MAX_GEOMETRY_POINTS) -> list[dict[str, float]]:
    """Равномерно прореживает геометрию, сохраняя первую и последнюю точки."""
    if len(points) <= max_points or max_points < 2:
        return points
    step = (len(points) - 1) / (max_points - 1)
    kept = [points[round(index * step)] for index in range(max_points)]
    kept[-1] = points[-1]
    return kept


def _maneuver_point(maneuver: dict[str, Any]) -> tuple[float | None, float | None]:
    """``maneuver.location`` OSRM (``[lon, lat]``) → ``(lat, lon)``.

    Координаты вне допустимых диапазонов и любой мусор в поле — не ошибка
    маршрута: точка маневра просто остаётся неизвестной.
    """
    location = maneuver.get("location")
    if not isinstance(location, (list, tuple)) or len(location) < 2:
        return None, None
    try:
        lon = float(location[0])
        lat = float(location[1])
    except (TypeError, ValueError):
        return None, None
    if not -90.0 <= lat <= 90.0 or not -180.0 <= lon <= 180.0:
        return None, None
    return lat, lon


def _step_from_payload(payload: dict[str, Any]) -> RouteStep | None:
    """Шаг OSRM → ``RouteStep``; шаги без движения отбрасываются."""
    maneuver = payload.get("maneuver") or {}
    step_type = str(maneuver.get("type") or "").strip()
    if not step_type:
        return None
    modifier = maneuver.get("modifier")
    street = payload.get("name") or None
    lat, lon = _maneuver_point(maneuver)
    return RouteStep(
        type=step_type,
        modifier=str(modifier) if modifier else None,
        street=str(street).strip() or None if street else None,
        distance_m=round(float(payload.get("distance") or 0.0), 1),
        duration_s=round(float(payload.get("duration") or 0.0), 1),
        lat=lat,
        lon=lon,
    )


def parse_route_payload(payload: dict[str, Any]) -> RoadRoute | None:
    """Ответ OSRM → ``RoadRoute``; ``None``, если маршрут не построен.

    Чистая функция: ни сети, ни конфигурации — только разбор ответа. Geometry у
    OSRM в порядке ``[lon, lat]`` (GeoJSON), наружу отдаём ``{lat, lon}``.
    """
    if not isinstance(payload, dict) or payload.get("code") != "Ok":
        return None
    routes = payload.get("routes")
    if not isinstance(routes, list) or not routes:
        return None
    route = routes[0] if isinstance(routes[0], dict) else None
    if route is None:
        return None

    geometry_payload = (route.get("geometry") or {}).get("coordinates")
    geometry: list[dict[str, float]] = []
    if isinstance(geometry_payload, list):
        for coordinate in geometry_payload:
            if isinstance(coordinate, (list, tuple)) and len(coordinate) >= 2:
                geometry.append({"lat": float(coordinate[1]), "lon": float(coordinate[0])})
    if len(geometry) < 2:
        return None

    steps: list[RouteStep] = []
    legs = route.get("legs") if isinstance(route.get("legs"), list) else []
    for leg in legs:
        if not isinstance(leg, dict):
            continue
        for raw_step in leg.get("steps") or []:
            if not isinstance(raw_step, dict):
                continue
            step = _step_from_payload(raw_step)
            if step is not None:
                steps.append(step)

    return RoadRoute(
        distance_km=round(float(route.get("distance") or 0.0) / 1000.0, 2),
        duration_min=round(float(route.get("duration") or 0.0) / 60.0, 1),
        geometry=_decimate(geometry),
        steps=steps[:MAX_STEPS],
        provider="osrm",
    )


def _default_http_get(url: str) -> str:
    """Реальный транспорт. В тестах заменяется фикстурой (как в sources/*)."""
    import httpx

    try:
        response = httpx.get(url, timeout=settings.routing_timeout_seconds, follow_redirects=True)
    except httpx.HTTPError as exc:
        raise RoutingError(f"routing transport error: {exc}") from exc
    if response.status_code == 429:
        raise RoutingError("routing rate limited (429)")
    if response.status_code != 200:
        raise RoutingError(f"routing http {response.status_code}")
    return response.text


def plan_road_route(
    points: Sequence[tuple[float, float]],
    *,
    http_get: Callable[[str], str] | None = None,
) -> tuple[RoadRoute | None, str | None]:
    """Строит дорожный маршрут по точкам ``(lat, lon)`` в порядке движения.

    Возвращает ``(маршрут, причина отказа)``: при успехе причина ``None``, иначе
    маршрут ``None`` и одна из констант ``REASON_*`` — её фронтенд переводит в
    честное сообщение и рисует прямую линию.
    """
    import json

    if len(points) < 2:
        return None, REASON_NO_ROUTE
    if not route_base_url():
        return None, REASON_NOT_CONFIGURED

    transport = http_get or _default_http_get
    try:
        raw = transport(build_route_url(points))
    except Exception:  # noqa: BLE001 — недоступность роутера не должна ломать API
        return None, REASON_PROVIDER_UNAVAILABLE

    try:
        payload = json.loads(raw)
    except (TypeError, ValueError):
        return None, REASON_PROVIDER_UNAVAILABLE

    route = parse_route_payload(payload)
    if route is None:
        return None, REASON_NO_ROUTE
    return route, None
