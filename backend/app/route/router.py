"""Public Route Mode API (R22)."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db.session import get_db
from .schemas import RouteStation, RouteStationsRequest
from .service import find_route_stations

router = APIRouter(prefix="/route", tags=["route"])


@router.post("/stations")
def route_stations(
    body: RouteStationsRequest,
    session: Session = Depends(get_db),
) -> list[RouteStation]:
    """Return active stations within the selected point-to-point corridor."""
    return find_route_stations(session, body)
