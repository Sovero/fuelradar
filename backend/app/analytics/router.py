"""Admin analytics routes read only the durable background snapshot."""

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..api.deps import require_operator
from ..core.config import settings
from ..db.session import get_db
from .models import AnalyticsSnapshot
from .service import deficit_by_region, summarize

router = APIRouter(prefix="/admin", tags=["analytics"], dependencies=[Depends(require_operator)])


def cached_analytics(
    city: str | None = Query(default=None, max_length=128),
    region: str | None = Query(default=None, max_length=128),
    bbox: str | None = None,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Validate scope, then read one cache row without calculating history."""
    bounds = None
    if bbox:
        try:
            coords = tuple(float(value) for value in bbox.split(","))
            if (len(coords) != 4 or not -180 <= coords[0] <= coords[2] <= 180
                    or not -90 <= coords[1] <= coords[3] <= 90):
                raise ValueError
            bounds = (coords[0], coords[1], coords[2], coords[3])
        except ValueError as error:
            raise HTTPException(422, "bbox must be west,south,east,north") from error
    snapshot = db.get(AnalyticsSnapshot, 1)
    if snapshot is None:
        raise HTTPException(503, "Analytics are awaiting the first background refresh")
    age = (datetime.now(UTC).replace(tzinfo=None) - snapshot.computed_at).total_seconds()
    return {
        "computed_at": snapshot.computed_at.isoformat() + "Z",
        "stale": age > settings.collect_default_minutes * 60,
        "_payload": snapshot.payload,
        **summarize(snapshot.payload, city=city, region=region, bbox=bounds),
    }


@router.get("/coverage")
def coverage(data: dict[str, Any] = Depends(cached_analytics)) -> dict[str, Any]:
    """Return station coverage in the requested region."""
    return {"computed_at": data["computed_at"], "stale": data["stale"], **data["coverage"]}


@router.get("/coverage-by-source")
def coverage_by_source(data: dict[str, Any] = Depends(cached_analytics)) -> dict[str, Any]:
    """Return source catalog counts before and after deduplication."""
    return {"computed_at": data["computed_at"], "stale": data["stale"], **data["coverage_by_source"]}


@router.get("/fuel-index")
def fuel_index(data: dict[str, Any] = Depends(cached_analytics)) -> dict[str, Any]:
    """Return fuel availability indices together with denominators and coverage."""
    return {"computed_at": data["computed_at"], "stale": data["stale"], **data["fuel_index"]}


@router.get("/deficit-stats")
def deficit_stats(data: dict[str, Any] = Depends(cached_analytics)) -> dict[str, Any]:
    """Return source-reported fuel outage aggregates by network."""
    return {"computed_at": data["computed_at"], "stale": data["stale"], **data["deficit_stats"]}


@router.get("/deficit-by-region")
def deficit_by_region_view(
    dimension: str = Query(default="city", pattern="^(city|region)$"),
    data: dict[str, Any] = Depends(cached_analytics),
) -> dict[str, Any]:
    """R79: районы дефицита — те же TTL-censored агрегаты по city/region.

    Размер выборки (`stations_observed`/`observed_source_streams`) и честное
    предупреждение о пилотном объёме данных — часть ответа (R79.1).
    """
    result = deficit_by_region(data["_payload"], dimension=dimension)
    return {"computed_at": data["computed_at"], "stale": data["stale"], **result}
