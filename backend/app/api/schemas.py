"""Pydantic-схемы API (T05, R67): валидация входа, русские сообщения об ошибках."""

from __future__ import annotations

import math
from datetime import datetime

from pydantic import BaseModel, Field, field_validator, model_validator

from ..fuel_status import FUEL_STATUSES, QUEUE_LEVELS

ZONE_TYPES = ("CITY", "CIRCLE", "POLYGON")


class FuelStatusBrief(BaseModel):
    fuel_code: str
    status: str
    confidence: int
    updated_at: datetime | None = None
    expires_at: datetime | None = None

    @model_validator(mode="after")
    def expire_status(self):
        from datetime import UTC
        if self.expires_at and self.expires_at.replace(tzinfo=None) <= datetime.now(UTC).replace(tzinfo=None):
            self.status, self.confidence = "UNKNOWN", 0
        return self


class QueueBrief(BaseModel):
    level: str
    vehicles: int | None = None
    estimated_wait_minutes: int | None = None


class StationBrief(BaseModel):
    id: str
    name: str
    brand: str | None = None
    latitude: float
    longitude: float
    address: str = ""
    city: str = ""
    distance_km: float | None = None
    eta_minutes: float | None = None
    statuses: list[FuelStatusBrief] = Field(default_factory=list)
    queue: QueueBrief | None = None
    score: float | None = None


class StationDetail(StationBrief):
    phone: str = ""
    opening_hours: str = ""
    external_ids: dict[str, str] = Field(default_factory=dict)
    score_breakdown: dict = Field(default_factory=dict)
    status_explanation: dict = Field(default_factory=dict)


class HistoryItem(BaseModel):
    confidence_raw: float = 0.0
    fuel_code: str
    status: str
    source: str
    observed_at: datetime
    received_at: datetime | None = None


class DevLoginBody(BaseModel):
    telegram_id: str | None = None
    email: str | None = None


class MagicLinkBody(BaseModel):
    email: str

    @field_validator("email")
    @classmethod
    def email_format(cls, v: str) -> str:
        v = (v or "").strip()
        if "@" not in v or "." not in v.split("@")[-1]:
            raise ValueError("укажите корректный email")
        return v.lower()


class MagicVerifyBody(BaseModel):
    token: str


class ZoneBody(BaseModel):
    name: str = ""
    zone_type: str
    params: dict = Field(default_factory=dict)

    @field_validator("zone_type")
    @classmethod
    def zone_type_valid(cls, v: str) -> str:
        v = v.upper()
        if v not in ZONE_TYPES:
            raise ValueError(f"тип зоны должен быть одним из {', '.join(ZONE_TYPES)}")
        return v

    @field_validator("params")
    @classmethod
    def params_match_type(cls, v: dict, info) -> dict:
        zone_type = info.data.get("zone_type")
        if zone_type == "CIRCLE":
            for key in ("lat", "lon", "radius_km"):
                if key not in v:
                    raise ValueError(f"для зоны CIRCLE нужны параметры lat, lon, radius_km (нет {key})")
        elif zone_type == "POLYGON":
            points = v.get("points")
            if not isinstance(points, list) or len(points) < 3:
                raise ValueError("для зоны POLYGON нужен параметр points — минимум 3 точки [lat, lon]")
        elif zone_type == "CITY" and not v.get("city"):
            raise ValueError("для зоны CITY нужен параметр city")
        def coordinate(value: object, bound: int) -> bool:
            return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and -bound <= value <= bound
        if zone_type == "CIRCLE":
            if not coordinate(v["lat"], 90) or not coordinate(v["lon"], 180):
                raise ValueError("Недопустимые координаты зоны")
            radius = v["radius_km"]
            if not isinstance(radius, (int, float)) or isinstance(radius, bool) or not 0 < radius <= 500:
                raise ValueError("Радиус зоны должен быть от 0 до 500 км")
        if zone_type == "POLYGON":
            if any(not isinstance(p, list) or len(p) != 2 or not coordinate(p[0], 90) or not coordinate(p[1], 180) for p in v["points"]):
                raise ValueError("Точки зоны должны быть координатами [lat, lon]")
        return v


class ZoneOut(ZoneBody):
    id: int


class AlertRuleBody(BaseModel):
    name: str = ""
    fuel_code: str | None = None
    distance_km: float | None = Field(default=None, gt=0)
    status_filter: str | None = None
    confidence_min: int | None = Field(default=None, ge=0, le=100)
    queue_max: str | None = None
    scope: dict = Field(default_factory=dict)
    is_active: bool = True

    @field_validator("status_filter")
    @classmethod
    def status_valid(cls, v: str | None) -> str | None:
        if v is not None and v not in FUEL_STATUSES:
            raise ValueError(f"статус должен быть одним из {', '.join(FUEL_STATUSES)}")
        return v

    @field_validator("queue_max")
    @classmethod
    def queue_valid(cls, v: str | None) -> str | None:
        if v is not None and v not in QUEUE_LEVELS:
            raise ValueError(f"уровень очереди должен быть одним из {', '.join(QUEUE_LEVELS)}")
        return v


class AlertRuleOut(AlertRuleBody):
    id: int


class AdminMergeBody(BaseModel):
    record_id: int


class DedupQueueAction(BaseModel):
    record_id: int
    action: str = "merge"  # merge | new_station
    target_record_id: int | None = None

    @field_validator("action")
    @classmethod
    def action_valid(cls, v: str) -> str:
        if v not in ("merge", "new_station"):
            raise ValueError("action должен быть merge или new_station")
        return v
