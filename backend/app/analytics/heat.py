"""Публичные маршруты heatmap (R50, §23): только снэпшот, русская валидация.

HTTP-запрос никогда не сканирует историю наблюдений — heat_cells читает
готовый AnalyticsSnapshot, как и все admin-эндпоинты T08. Пустой кэш → 503
со структурированным сообщением, UI при этом не ломается (основной список живёт).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..core.config import settings
from ..db.session import get_db
from .models import AnalyticsSnapshot
from .service import heat_cells

router = APIRouter(prefix="/heat", tags=["heat"])


def heat_scope(
    fuels: str | None = Query(default=None, max_length=256),
    city: str | None = Query(default=None, max_length=128),
    region: str | None = Query(default=None, max_length=128),
    bbox: str | None = Query(default=None, max_length=128),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Валидация скоупа с русскими 422 + чтение единственной строки кэша."""
    fuel_list: list[str] | None = None
    if fuels:
        fuel_list = [part.strip() for part in fuels.split(",") if part.strip()]
    bounds: tuple[float, float, float, float] | None = None
    if bbox:
        try:
            coords = tuple(float(value) for value in bbox.split(","))
            if (len(coords) != 4 or not -180 <= coords[0] <= coords[2] <= 180
                    or not -90 <= coords[1] <= coords[3] <= 90):
                raise ValueError
        except ValueError:
            raise HTTPException(422, "bbox must be west,south,east,north") from None
        bounds = (coords[0], coords[1], coords[2], coords[3])
    snapshot = db.get(AnalyticsSnapshot, 1)
    if snapshot is None:
        raise HTTPException(503, "Аналитика ещё не посчитана — фоновый пересчёт не запускался")
    age = (datetime.now(UTC).replace(tzinfo=None) - snapshot.computed_at).total_seconds()
    return {"fuels": fuel_list, "city": city, "region": region,
            "bbox": bounds, "snapshot": snapshot, "age": age}


@router.get("/cells")
def heat_list(scope: dict[str, Any] = Depends(heat_scope)) -> dict[str, Any]:
    """Точки heatmap + пороги уровней легенды (текстовая альтернатива цвету)."""
    snapshot = scope["snapshot"]
    return {
        "computed_at": snapshot.computed_at.isoformat() + "Z",
        "stale": scope["age"] > settings.collect_default_minutes * 60,
        "levels": [
            {"level": "high", "min_availability": settings.heat_high_min},
            {"level": "medium", "min_availability": settings.heat_low_min},
            {"level": "low", "min_availability": 0.0},
        ],
        "cells": heat_cells(
            snapshot.payload, fuels=scope["fuels"], city=scope["city"],
            region=scope["region"], bbox=scope["bbox"],
        ),
    }
