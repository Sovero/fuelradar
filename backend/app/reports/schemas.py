"""Схемы `POST /reports` (R39) — своя зона, не расширяет `api/schemas.py`."""

from __future__ import annotations

import math

from pydantic import BaseModel, Field, field_validator, model_validator

from ..core.config import settings

# R39: «есть/нет/заканчивается/не знаю» — статусы, которые реально сообщает
# человек. LIKELY_AVAILABLE/UNCERTAIN — только вычисляемые системой (R14/R19),
# пользователь их не выбирает.
REPORTABLE_FUEL_STATUSES: tuple[str, ...] = ("AVAILABLE", "UNAVAILABLE", "LOW_STOCK", "UNKNOWN")
REPORTABLE_QUEUE_LEVELS: tuple[str, ...] = ("NONE", "LOW", "MEDIUM", "HIGH", "VERY_HIGH")


class ReportBody(BaseModel):
    station_id: str = Field(min_length=1)
    fuel: dict[str, str] = Field(default_factory=dict)  # {"AI_95": "AVAILABLE", ...}
    prices: dict[str, float] = Field(default_factory=dict)  # R78: {"AI_95": 62.4} — цена вместе со статусом
    queue: str | None = None
    idempotency_key: str = Field(min_length=1, max_length=100)  # запас под суффикс ":FUEL_CODE" (R39.1)
    lat: float | None = None
    lon: float | None = None

    @field_validator("prices")
    @classmethod
    def prices_valid(cls, v: dict[str, float]) -> dict[str, float]:
        """R78.4: NaN/≤0/чрезмерная цена → 422 с понятной ошибкой (не портит отчёт)."""
        ceiling = settings.price_max_reasonable
        for fuel_code, price in v.items():
            if not math.isfinite(price):
                raise ValueError(f"цена для {fuel_code} должна быть конечным числом")
            if price <= 0:
                raise ValueError(f"цена для {fuel_code} должна быть больше нуля")
            if price > ceiling:
                raise ValueError(f"цена для {fuel_code} не может превышать {ceiling}")
        return v

    @model_validator(mode="after")
    def prices_have_status(self):
        """Цена имеет смысл только вместе со статусом этого же топлива — иначе
        наблюдение статуса не создаётся и цене не с чем храниться."""
        unknown = set(self.prices) - set(self.fuel)
        if unknown:
            raise ValueError(
                f"цена передана без статуса топлива: {', '.join(sorted(unknown))} — добавьте статус в поле fuel"
            )
        return self


    @field_validator("fuel")
    @classmethod
    def fuel_values_valid(cls, v: dict[str, str]) -> dict[str, str]:
        for fuel_code, status in v.items():
            if status not in REPORTABLE_FUEL_STATUSES:
                raise ValueError(
                    f"статус топлива {fuel_code} должен быть одним из {', '.join(REPORTABLE_FUEL_STATUSES)}"
                )
        return v

    @field_validator("queue")
    @classmethod
    def queue_valid(cls, v: str | None) -> str | None:
        if v is not None and v not in REPORTABLE_QUEUE_LEVELS:
            raise ValueError(f"очередь должна быть одной из {', '.join(REPORTABLE_QUEUE_LEVELS)} или null")
        return v

    @field_validator("lat")
    @classmethod
    def lat_valid(cls, v: float | None) -> float | None:
        if v is not None and (not math.isfinite(v) or not -90 <= v <= 90):
            raise ValueError("широта должна быть в диапазоне [-90, 90]")
        return v

    @field_validator("lon")
    @classmethod
    def lon_valid(cls, v: float | None) -> float | None:
        if v is not None and (not math.isfinite(v) or not -180 <= v <= 180):
            raise ValueError("долгота должна быть в диапазоне [-180, 180]")
        return v


class ReportOut(BaseModel):
    id: int
    station_id: str
    gps_confirmed: bool
    distance_to_station_m: float | None = None
    created: bool  # False — идемпотентный повтор, новых наблюдений не было (R39.1)
    created_at: str
