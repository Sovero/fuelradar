"""Публичный сигнал о состоянии сбора (R58/R97i).

Зачем отдельный endpoint: главный экран обязан честно сказать «данные могут быть
устаревшими», если сбор стоит — а не показывать старые статусы АЗС как свежие.
Админский журнал (`/admin/collection-cycles`) для этого не годится: он про
каждый источник и открыт только тому, кто запустил приложение, а предупреждение
нужно на обычном экране.

Здесь только агрегат: последний успешный сбор, план, очередь и режим
планировщика. Никаких секретов и текстов ошибок источников — класс ошибки и
счётчики остаются в админке (R68).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db.session import get_db
from ..worker.health import collection_report

router = APIRouter(tags=["collection"])


@router.get("/collection/health")
def collection_health(session: Session = Depends(get_db)) -> dict:
    """Состояние сбора: ok / disabled / overdue / stalled / unplanned (см. worker/health.py)."""
    return collection_report(session)
