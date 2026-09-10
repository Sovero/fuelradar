"""Точка входа API (T01/T05): /health, /ready, /metrics и роутеры /api/v1.

CORS — белый список из .env (R66); сбор источников никогда не синхронный (R83).
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from .alerts.router import router as alerts_router
from .analytics.heat import router as heat_router
from .analytics.router import router as analytics_router
from .api import api_router
from .api.deps import rate_limit
from .core.config import settings
from .db.session import SessionLocal, init_db
from .reports.router import router as reports_router
from .route import router as route_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("fuelradar")

_STARTED_AT = time.time()


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    logger.info("DB initialized")
    yield


app = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)

# R66: CORS — только origins из конфигурации; пусто → без CORS-заголовков (same-origin).
if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Content-Type", "X-Admin-Token"],
    )

@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    errors = [{"loc": list(error["loc"]), "msg": "Ошибка валидации: " + error["msg"], "type": error["type"]} for error in exc.errors()]
    return JSONResponse(status_code=422, content={"detail": errors})


app.include_router(api_router)
app.include_router(analytics_router, prefix="/api/v1", dependencies=[Depends(rate_limit)])
app.include_router(heat_router, prefix="/api/v1", dependencies=[Depends(rate_limit)])
app.include_router(alerts_router, prefix="/api/v1", dependencies=[Depends(rate_limit)])
app.include_router(reports_router, prefix="/api/v1", dependencies=[Depends(rate_limit)])
app.include_router(route_router, prefix="/api/v1", dependencies=[Depends(rate_limit)])


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "uptime_seconds": round(time.time() - _STARTED_AT, 1)}


@app.get("/metrics")
def metrics() -> dict:
    """Снимок in-memory метрик (R70); наполняются воркером T06."""
    from .core.metrics import snapshot

    return snapshot()


@app.get("/ready")
def ready() -> dict:
    try:
        with SessionLocal() as session:
            session.execute(text("SELECT 1"))
        db_ok = True
    except Exception as exc:  # noqa: BLE001 — /ready обязан отвечать при любой поломке
        logger.error("ready check failed: %s", exc)
        db_ok = False
    return {"status": "ready" if db_ok else "not_ready", "db": "ok" if db_ok else "error", "time": datetime.now(UTC).replace(tzinfo=None).isoformat()}
