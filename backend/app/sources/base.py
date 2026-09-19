"""Адаптерная архитектура источников (T02).

Интерфейс `SourceAdapter` — единственная точка входа для любого внешнего источника
(R12). Все адаптеры реализуют одинаковый контракт; конкретика (сеть, парсинг,
лицензии) живёт внутри класса. Тесты работают через фикстуры и инъекцию
транспорта — никакой сети в тестах.

Health-статусы — из брифа R57:
    ONLINE | DEGRADED | OFFLINE | RATE_LIMITED | AUTH_ERROR
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

HEALTH_ONLINE = "ONLINE"
HEALTH_DEGRADED = "DEGRADED"
HEALTH_OFFLINE = "OFFLINE"
HEALTH_RATE_LIMITED = "RATE_LIMITED"
HEALTH_AUTH_ERROR = "AUTH_ERROR"
HEALTH_UNKNOWN = "UNKNOWN"

HEALTH_VALUES = frozenset(
    {HEALTH_ONLINE, HEALTH_DEGRADED, HEALTH_OFFLINE, HEALTH_RATE_LIMITED, HEALTH_AUTH_ERROR, HEALTH_UNKNOWN}
)


class AdapterError(Exception):
    """Базовая ошибка адаптера — изолируется в ингесте (R84)."""


class RateLimitedError(AdapterError):
    """Источник ответил 429 / сообщил о превышении лимита (R57)."""


class AuthError(AdapterError):
    """Некорректные/просроченные учётные данные источника (R57)."""


class ResearchRequiredError(AdapterError):
    """Источник не реализован: статус RESEARCH_REQUIRED (R12/R89)."""


@dataclass
class SourceRecord:
    """Нормализованная запись о физической АЗС от источника (R01/R08).

    Хранится в source_station_records как есть (raw не выбрасывается, R84),
    дедупликация и привязка к stations — таск 03.
    """

    external_id: str  # node/789456, lukoil-145, …
    latitude: float
    longitude: float
    brand_raw: str = ""
    name_raw: str = ""
    address_raw: str = ""
    payload: str = ""  # сырой ответ источника (диагностика, TTL)
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class HealthResult:
    health: str = HEALTH_UNKNOWN
    message: str = ""
    last_success_at: str = ""


class SourceAdapter(ABC):
    """Контракт адаптера (R12). Один экземпляр — один источник."""

    provider_code: str = ""
    provider_name: str = ""
    attribution: str = ""  # обязательная атрибуция (R81: ODbL и т.п.)
    research_required: bool = False  # RESEARCH_REQUIRED-заглушки (R89)
    # Возможности источника; совпадает с SourceProvider.capabilities (R01/R94i).
    capabilities: dict[str, bool] = {"discovery": False, "availability": False, "queue": False}

    @abstractmethod
    def discover_stations(self, region: dict[str, Any]) -> list[SourceRecord]:
        """Discovery: физический перечень АЗС региона (R01)."""

    def get_station_details(self, external_id: str) -> dict[str, Any]:
        """Детали станции (адрес, часы, телефон…). Необязательно — базово пусто."""
        return {}

    def get_fuel_availability(self, external_id: str) -> list[dict[str, Any]]:
        """Availability: статусы топлива сейчас. Discovery-источники возвращают []."""
        return []

    def get_queue_status(self, external_id: str) -> dict[str, Any] | None:
        """Очередь. Источники без данных об очереди возвращают None."""
        return None

    def file_state(self) -> dict[str, Any] | None:
        """R58: состояние файла-входа источника — путь, наличие, время последней правки.

        None — источник не читает локальный файл (сетевые адаптеры). Файловые
        адаптеры переопределяют: админка показывает оператору, какой именно файл
        читает источник и когда он обновлялся, вместо того чтобы он выяснял это
        из `.env`.
        """
        return None

    @abstractmethod
    def health_check(self) -> HealthResult:
        """R57: ONLINE | DEGRADED | OFFLINE | RATE_LIMITED | AUTH_ERROR."""