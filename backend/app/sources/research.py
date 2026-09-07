"""RESEARCH_REQUIRED-заглушки (R12/R89).

Яндекс, 2ГИС, сети, Т-Банк, Telegram: исследование — research-sources.md, статус
RESEARCH_REQUIRED. Эти адаптеры не выполняют ни одного сетевого вызова и не
возвращают вымышленных данных: discover/availability бросают ResearchRequiredError,
health_check честно сообщает OFFLINE («не реализован»). Активация — только после
строки «Проверено: …» в research-sources.md и смены статуса в сидах (session.py).
"""

from __future__ import annotations

from typing import Any

from .base import (
    HEALTH_OFFLINE,
    HealthResult,
    ResearchRequiredError,
    SourceAdapter,
    SourceRecord,
)

_MESSAGE = "RESEARCH_REQUIRED — адаптер не реализован (см. research-sources.md)"


class ResearchRequiredAdapter(SourceAdapter):
    """База для всех источников без подтверждённого API/лицензии."""

    research_required = True

    def discover_stations(self, region: dict[str, Any]) -> list[SourceRecord]:
        raise ResearchRequiredError(_MESSAGE)

    def get_station_details(self, external_id: str) -> dict[str, Any]:
        raise ResearchRequiredError(_MESSAGE)

    def get_fuel_availability(self, external_id: str) -> list[dict[str, Any]]:
        raise ResearchRequiredError(_MESSAGE)

    def get_queue_status(self, external_id: str) -> dict[str, Any] | None:
        raise ResearchRequiredError(_MESSAGE)

    def health_check(self) -> HealthResult:
        return HealthResult(HEALTH_OFFLINE, _MESSAGE)


class YandexAdapter(ResearchRequiredAdapter):
    provider_code = "yandex"
    provider_name = "Яндекс Карты"


class TwoGisAdapter(ResearchRequiredAdapter):
    provider_code = "twogis"
    provider_name = "2ГИС"


class LukoilAdapter(ResearchRequiredAdapter):
    provider_code = "lukoil"
    provider_name = "Лукойл"


class RosneftAdapter(ResearchRequiredAdapter):
    provider_code = "rosneft"
    provider_name = "Роснефть"


class GazpromAdapter(ResearchRequiredAdapter):
    provider_code = "gazprom"
    provider_name = "Газпром"


class GazpromNeftAdapter(ResearchRequiredAdapter):
    provider_code = "gazpromneft"
    provider_name = "Газпромнефть"


class TBankAdapter(ResearchRequiredAdapter):
    provider_code = "tbank"
    provider_name = "Т-Банк"


class TelegramSourceAdapter(ResearchRequiredAdapter):
    provider_code = "telegram"
    provider_name = "Telegram-каналы"