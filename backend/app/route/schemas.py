"""Request and response contracts for Route Mode (R22) and road routing (R22.1)."""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator

from ..api.schemas import StationBrief


class RoutePoint(BaseModel):
    """One user-selected point; latitude/longitude are WGS84 degrees."""

    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class PolylineRequest(BaseModel):
    """Точки в порядке движения; компактный формат ``[[lat, lon], ...]`` тоже принимается."""

    polyline: list[RoutePoint] = Field(min_length=2, max_length=100)

    @field_validator("polyline", mode="before")
    @classmethod
    def coordinate_pairs(cls, value: object) -> object:
        """Also accept compact ``[[lat, lon], ...]`` coordinates."""
        if not isinstance(value, list):
            return value
        converted: list[object] = []
        for point in value:
            if isinstance(point, (list, tuple)) and len(point) == 2:
                converted.append({"lat": point[0], "lon": point[1]})
            else:
                converted.append(point)
        return converted


class RoutePlanRequest(PolylineRequest):
    """Точки в том же порядке, что и у коридора: начало → промежуточные → конец.

    Профиль движения клиентом не выбирается — он берётся из конфигурации (R22.1).
    """


class RoutePlanStep(BaseModel):
    """Шаг маршрута: машиночитаемый тип + улица + длина/время (перевод — на фронте).

    ``lat``/``lon`` — координаты маневра; клиент перелетает к ним камерой, когда
    пользователь кликает по подписи маршрута. Может отсутствовать, если роутер
    точку не отдал — тогда клиент берёт её из геометрии.
    """

    type: str
    modifier: str | None = None
    street: str | None = None
    distance_m: float
    duration_s: float
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)


class RoutePlanResponse(BaseModel):
    """Дорожный маршрут либо честный отказ с причиной (R97i).

    При ``is_road_route = False`` фронтенд рисует прямую линию и объясняет, почему
    дорожный маршрут не построен: ``reason`` — машинный код, а не готовый текст.
    """

    is_road_route: bool
    provider: str | None = None
    distance_km: float | None = None
    duration_min: float | None = None
    geometry: list[RoutePoint] | None = None
    steps: list[RoutePlanStep] = Field(default_factory=list)
    reason: str | None = None


class RouteStationsRequest(PolylineRequest):
    """Polyline corridor and the standard station fuel filters."""

    corridor_km: float = Field(default=5, ge=0.5, le=50)
    city: str | None = None
    brand: str | None = None
    fuel: str | None = None
    status: str | None = None
    confidence_min: int | None = None
    queue_max: str | None = None
    price_max: float | None = Field(default=None, gt=0)  # R78.1 — «дешевле X» вдоль коридора
    preferred_brands: str | None = None
    limit: int = Field(default=100, ge=1, le=100)
    offset: int = Field(default=0, ge=0)


class RouteStation(StationBrief):
    """Station card enriched with its closest distance to the polyline."""

    distance_from_route_km: float
