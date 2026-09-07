"""Конфигурация приложения.

Секреты — только переменные окружения (R68). Регион — данные из .env, не код (R04/R81).
Значения по умолчанию — из спецификации (TTL §18, интервалы §12, пороги/веса §7–§8/§10).
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- приложение ---
    app_name: str = "FuelRadar"
    debug: bool = False
    database_url: str = "sqlite:///./fuelradar.db"

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


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()