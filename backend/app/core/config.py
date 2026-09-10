"""Конфигурация приложения.

Секреты — только переменные окружения (R68). Регион — данные из .env, не код (R04/R81).
Значения по умолчанию — из спецификации (TTL §18, интервалы §12, пороги/веса §7–§8/§10).
"""

import os
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Абсолютный путь до .env в корне репозитория (не backend/.env — .env.example
# и вся документация подразумевают единый .env в корне). Раньше здесь стояло
# просто ".env", которое pydantic-settings резолвит относительно CWD процесса,
# а не расположения этого файла — при обычном запуске (`cd backend && uvicorn
# ...`, ровно так делает Makefile/setup.ps1) CWD оказывается backend/, где
# .env нет, и весь файл в корне молча игнорировался: DEBUG/CORS_ORIGINS/
# ADMIN_TOKEN и всё остальное откатывались на дефолты без единого предупреждения.
#
# Тесты обязаны быть герметичными: реальный .env разработчика (например,
# DEFAULT_REGION_CITY=Краснодар от setup.ps1) не должен влиять на то, что
# видят тесты — иначе один и тот же прогон даёт разный результат в зависимости
# от того, у кого на машине что лежит в .env. conftest.py выставляет
# FUELRADAR_NO_ENV_FILE=1 до первого импорта приложения именно поэтому.
_ROOT_ENV_FILE = None if os.environ.get("FUELRADAR_NO_ENV_FILE") else Path(__file__).resolve().parents[3] / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_ROOT_ENV_FILE, env_file_encoding="utf-8", extra="ignore")

    # --- приложение ---
    app_name: str = "FuelRadar"
    debug: bool = False
    database_url: str = "sqlite:///./fuelradar.db"
    redis_url: str = ""  # пусто -> метрики in-memory на процесс (R70); задать для общих метрик api+worker

    # --- регион (R04/R81): город по умолчанию — данные, не код ---
    default_region_city: str = ""  # пример значения — в .env.example: Краснодар
    default_region_radius_km: float = 10.0

    # --- TTL по категориям (R72, §18) ---
    ttl_fuel_minutes: int = 120            # топливо: 2 часа
    ttl_queue_minutes: int = 30            # очередь: 30 минут
    ttl_address_days: int = 30             # адрес: 30 дней
    ttl_opening_hours_days: int = 7        # режим работы: 7 дней
    ttl_raw_days: int = 30                 # raw-ответы источников: 7–30 дней

    # --- интервалы сбора (R54, §12) ---
    collect_default_minutes: int = 60
    collect_favorite_minutes: int = 30
    collect_deficit_minutes: int = 30
    collect_stable_minutes: int = 120

    # --- пороги и веса ---
    dedup_auto_merge: float = 0.85         # §7: автослияние
    dedup_needs_review: float = 0.60       # §7: очередь администратору
    dedup_weights: dict = {                # §11 брифа
        "coordinates": 0.50,
        "brand": 0.20,
        "address": 0.15,
        "name": 0.10,
        "phone": 0.05,
    }
    gps_proximity_m: float = 300.0         # R40
    alert_dedup_window_minutes: int = 5    # R38
    max_rules_per_user: int = 20           # §13 №14
    score_weights: dict = {                # §10 (R43) — базовые веса
        "fuel_available": 0.30,
        "confidence": 0.20,
        "freshness": 0.10,
        "distance": 0.15,
        "travel_time": 0.10,
        "queue": 0.10,
        "user_preferences": 0.05,
    }
    source_trust_default: float = 0.5      # §8 — вес источника по умолчанию

    # --- confidence (T04, §8/§9/§18) ---
    confidence_share_strong: float = 0.80  # доля лучшего статуса → прямой статус
    confidence_share_likely: float = 0.60  # доля для LIKELY_AVAILABLE (иначе UNCERTAIN)
    confidence_min_weight: float = 0.30    # R19.1 — мин. вес для смены статуса, иначе «под вопросом»
    gps_boost: float = 1.20                # R40 — отчёт с GPS < 300 м
    gps_penalty: float = 0.60              # R40.1 — отчёт «издалека»
    reliability_base: float = 0.50         # R41 — стартовый счёт пользователя

    # --- очередь и ETA (T04, §10) ---
    queue_seconds_per_vehicle: int = 80    # R20 — ~80 с/машина
    avg_speed_kmh: float = 30.0            # ASSUMPTION: средняя городская скорость (без routing API)
    score_distance_max_km: float = 15.0    # нормализация distance в Score
    score_travel_max_minutes: float = 20.0  # нормализация travel_time в Score

    # --- источники (T02) ---
    overpass_endpoint: str = "https://overpass-api.de/api/interpreter"
    overpass_timeout_seconds: int = 30
    network_import_path: str = ""  # файл CSV/JSON со списками сетей (иначе DEGRADED)

    # --- секреты (R68): только имена в .env.example, значения никогда в код ---
    telegram_bot_token: str = ""
    vapid_public_key: str = ""
    vapid_private_key: str = ""
    admin_token: str = ""
    smtp_url: str = ""

    # --- API и безопасность (T05, §14/§15) ---
    jwt_secret: str = ""                   # R68: секрет JWT из .env; пусто → эфемерный на процесс (dev)
    cookie_secure: bool = False            # secure-cookie — включать за HTTPS (prod)
    cors_origins: str = ""                 # белый список CORS через запятую (R66); пусто → same-origin
    rate_limit_per_minute: int = 120       # R66: простой per-IP лимит; 0 — выключить
    worker_tick_seconds: int = 10
    worker_backoff_max_minutes: int = 120
    smtp_from: str = "noreply@localhost"
    public_app_url: str = "http://localhost:3000"
    api_cache_ttl_seconds: int = 30        # R82: кэш списка/карты (bbox/radius)

    # --- прогноз/heatmap/BI (T12, §23) ---
    forecast_horizon_minutes: int = 180    # R49 — «ближайшие 3 часа»
    forecast_min_episodes: int = 2         # R49.2 — мин. эпизодов для вероятности/ETA (бриф: «пара эпизодов»)
    forecast_min_streams: int = 1          # R49.2 — мин. потоков наблюдений (0 → всегда «мало данных»)
    heat_high_min: float = 0.67            # R50 — доля доступных DEFINITIVE-статусов → высокий уровень
    heat_low_min: float = 0.34             # R50 — ниже порога дефицита, между порогами — снижение


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()