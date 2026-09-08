"""Публичный API /api/v1 (T05). Продолжается тасками 07 (reports/notifications) и 08 (аналитика)."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from . import admin, login, meta, personal, stations
from .deps import rate_limit

api_router = APIRouter(prefix="/api/v1", dependencies=[Depends(rate_limit)])
api_router.include_router(login.router)
api_router.include_router(meta.router)
api_router.include_router(stations.router)
api_router.include_router(personal.router)
api_router.include_router(admin.router)


__all__ = ["api_router"]
