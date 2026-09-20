"""Справочники и переводы (T05, A02/R98i/R100): единственный источник переводов статусов."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..alerts.channels import web_push_configured
from ..core.config import settings
from ..db.models import FuelBrand, FuelType, SourceProvider, StationBrand
from ..db.session import get_db
from ..fuel_status import FUEL_STATUSES, QUEUE_LEVELS

router = APIRouter(tags=["meta"])

FUEL_STATUS_RU: dict[str, str] = {
    "AVAILABLE": "Есть",
    "LIKELY_AVAILABLE": "Вероятно есть",
    "LOW_STOCK": "Заканчивается",
    "UNCERTAIN": "Под вопросом",
    "UNAVAILABLE": "Нет",
    "UNKNOWN": "Нет данных",
}

QUEUE_LEVEL_RU: dict[str, str] = {
    "NONE": "Нет",
    "LOW": "Небольшая",
    "MEDIUM": "Средняя",
    "HIGH": "Большая",
    "VERY_HIGH": "Очень большая",
    "UNKNOWN": "Нет данных",
}

# R100: переключение языка интерфейса (RU/EN, добавлено пользователем в ходе сборки).
FUEL_STATUS_EN: dict[str, str] = {
    "AVAILABLE": "Available",
    "LIKELY_AVAILABLE": "Likely available",
    "LOW_STOCK": "Running low",
    "UNCERTAIN": "Uncertain",
    "UNAVAILABLE": "Unavailable",
    "UNKNOWN": "No data",
}

QUEUE_LEVEL_EN: dict[str, str] = {
    "NONE": "None",
    "LOW": "Short",
    "MEDIUM": "Medium",
    "HIGH": "Long",
    "VERY_HIGH": "Very long",
    "UNKNOWN": "No data",
}

FUEL_TYPE_EN: dict[str, str] = {
    "AI_92": "AI-92",
    "AI_95": "AI-95",
    "AI_95_PREMIUM": "AI-95 Premium",
    "AI_98": "AI-98",
    "AI_100": "AI-100",
    "DIESEL": "Diesel",
    "DIESEL_PREMIUM": "Diesel Premium",
    "LPG": "LPG (propane)",
    "CNG": "CNG (methane)",
    "UNKNOWN": "Unknown",
    "OTHER": "Other",
}


@router.get("/meta")
def meta(session: Session = Depends(get_db)) -> dict:
    """Справочники: топливо (база + коммерческие), сети, статусы с переводами (A02)."""
    fuels = []
    for ft in session.scalars(select(FuelType).order_by(FuelType.id)):
        commercials = session.scalars(
            select(FuelBrand.name).where(FuelBrand.fuel_type_id == ft.id).order_by(FuelBrand.sort_order)
        ).all()
        fuels.append({
            "code": ft.code,
            "name_ru": ft.display_name_ru,
            "name_en": FUEL_TYPE_EN.get(ft.code, ft.code),
            "commercial": list(commercials),
        })

    brands = [
        {"id": b.id, "name": b.name, "priority": b.priority}
        for b in session.scalars(select(StationBrand).order_by(StationBrand.priority))
    ]
    sources = [
        {"code": s.code, "name": s.name, "status": s.status, "attribution": s.attribution}
        for s in session.scalars(select(SourceProvider).order_by(SourceProvider.code))
    ]

    return {
        "fuel_types": fuels,
        "station_brands": brands,
        "sources": sources,
        "fuel_statuses": [
            {"code": code, "name_ru": FUEL_STATUS_RU[code], "name_en": FUEL_STATUS_EN[code]} for code in FUEL_STATUSES
        ],
        "queue_levels": [
            {"code": code, "name_ru": QUEUE_LEVEL_RU[code], "name_en": QUEUE_LEVEL_EN[code]} for code in QUEUE_LEVELS
        ],
        # ETA на линии маршрута (R92): та же средняя скорость, что и в Score —
        # единственный источник значения — конфиг, фронт не дублирует константу.
        "avg_speed_kmh": settings.avg_speed_kmh,
        # T14 (R64/R97i): публичный VAPID-ключ — это не секрет (идентифицирует
        # сервер для push-сервиса); приватный ключ остаётся только в .env (R68).
        "push": {
            "enabled": web_push_configured(),
            "vapid_public_key": settings.vapid_public_key if web_push_configured() else None,
        },
        # Вход через Telegram (R97i): имя бота — не секрет, но отдаём его только
        # при настроенном токене: иначе фронт показал бы виджет, а backend
        # отклонил бы вход. Один источник правды для видимости канала.
        "telegram_login": {
            "enabled": bool(settings.telegram_bot_token and settings.telegram_bot_username),
            "bot_username": settings.telegram_bot_username if settings.telegram_bot_token else None,
        },
    }
