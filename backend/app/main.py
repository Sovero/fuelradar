"""Точка входа API (T01). Роутеры /api/v1 добавляются таском 05.

Здесь только каркас: /health, /ready, структурированное логирование (R69).
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from fastapi import FastAPI
from sqlalchemy import text

from .core.config import settings
from .db.session import SessionLocal, init_db

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("fuelradar")

_STARTED_AT = time.time()


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    logger.info("DB initialized: %s", settings.database_url)
    yield


app = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)


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