"""Единственная точка подключения к БД и сиды словарей (R62, R13, R94i)."""

from __future__ import annotations

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from ..core.config import settings
from .base import Base
from .migrations import upgrade_spatial_index, upgrade_worker_jobs
from .models import FuelBrand, FuelType, SourceProvider

_engine = create_engine(
    settings.database_url,
    connect_args={"check_same_thread": False} if settings.database_url.startswith("sqlite") else {},
)
SessionLocal = sessionmaker(bind=_engine, autocommit=False, autoflush=False)

# Справочник топлива — из брифа §15 (R13).
FUEL_TYPES: list[tuple[str, str]] = [
    ("AI_92", "АИ-92"),
    ("AI_95", "АИ-95"),
    ("AI_95_PREMIUM", "АИ-95 Премиум"),
    ("AI_98", "АИ-98"),
    ("AI_100", "АИ-100"),
    ("DIESEL", "ДТ"),
    ("DIESEL_PREMIUM", "ДТ Премиум"),
    ("LPG", "Газ (пропан)"),
    ("CNG", "Метан"),
    ("UNKNOWN", "Неизвестно"),
    ("OTHER", "Другое"),
]

# Коммерческие названия по умолчанию (R13.4); расширяется админом без кода.
FUEL_BRANDS: list[tuple[str, str]] = [
    ("AI_95", "ЭКТО"),
    ("AI_95", "G-Drive"),
    ("AI_95", "Pulsar"),
]

# Источники: статусы — из research-sources.md (R12/R89). Активные MVP (R94i) —
# osm_overpass, network_import, user_reports; остальные — RESEARCH_REQUIRED без сетевого кода.
SOURCE_PROVIDERS: list[dict] = [
    {"code": "osm_overpass", "name": "OpenStreetMap (Overpass)", "capabilities": {"discovery": True, "availability": False, "queue": False},
     "status": "ACTIVE", "min_interval_minutes": 1440, "attribution": "© OpenStreetMap contributors", "trust": 0.6},
    {"code": "network_import", "name": "Импорт списков сетей (CSV/JSON)", "capabilities": {"discovery": True, "availability": False, "queue": False},
     "status": "ACTIVE", "min_interval_minutes": 1440, "attribution": "", "trust": 0.7},
    {"code": "user_reports", "name": "Пользовательские отчёты", "capabilities": {"discovery": False, "availability": True, "queue": True},
     "status": "ACTIVE", "min_interval_minutes": 5, "attribution": "", "trust": 0.4},
    {"code": "yandex", "name": "Яндекс Карты", "capabilities": {}, "status": "RESEARCH_REQUIRED", "min_interval_minutes": 60, "attribution": "", "trust": 0.0},
    {"code": "twogis", "name": "2ГИС", "capabilities": {}, "status": "RESEARCH_REQUIRED", "min_interval_minutes": 60, "attribution": "", "trust": 0.0},
    {"code": "lukoil", "name": "Лукойл", "capabilities": {}, "status": "RESEARCH_REQUIRED", "min_interval_minutes": 60, "attribution": "", "trust": 0.0},
    {"code": "rosneft", "name": "Роснефть", "capabilities": {}, "status": "RESEARCH_REQUIRED", "min_interval_minutes": 60, "attribution": "", "trust": 0.0},
    {"code": "gazprom", "name": "Газпром", "capabilities": {}, "status": "RESEARCH_REQUIRED", "min_interval_minutes": 60, "attribution": "", "trust": 0.0},
    {"code": "gazpromneft", "name": "Газпромнефть", "capabilities": {}, "status": "RESEARCH_REQUIRED", "min_interval_minutes": 60, "attribution": "", "trust": 0.0},
    {"code": "tbank", "name": "Т-Банк", "capabilities": {}, "status": "RESEARCH_REQUIRED", "min_interval_minutes": 60, "attribution": "", "trust": 0.0},
    {"code": "telegram", "name": "Telegram-каналы", "capabilities": {}, "status": "RESEARCH_REQUIRED", "min_interval_minutes": 60, "attribution": "", "trust": 0.0},
]


def init_db() -> None:
    """Создаёт таблицы и сидит словари (идемпотентно)."""
    Base.metadata.create_all(_engine)
    upgrade_worker_jobs(_engine)
    upgrade_spatial_index(_engine)
    with Session(_engine) as session:
        for code, name in FUEL_TYPES:
            if session.scalar(select(FuelType).where(FuelType.code == code)) is None:
                session.add(FuelType(code=code, display_name_ru=name))
        fuel_by_code = {ft.code: ft for ft in session.scalars(select(FuelType))}
        for fuel_code, brand_name in FUEL_BRANDS:
            fuel = fuel_by_code.get(fuel_code)
            if fuel is None:
                continue
            exists = session.scalar(
                select(FuelBrand).where(FuelBrand.fuel_type_id == fuel.id, FuelBrand.name == brand_name)
            )
            if exists is None:
                session.add(FuelBrand(fuel_type_id=fuel.id, name=brand_name))
        for spec in SOURCE_PROVIDERS:
            if session.scalar(select(SourceProvider).where(SourceProvider.code == spec["code"])) is None:
                session.add(SourceProvider(**spec))
        session.commit()


def get_db():
    """FastAPI-зависимость сессии."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
