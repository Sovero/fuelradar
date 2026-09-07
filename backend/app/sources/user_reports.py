"""Адаптер пользовательских отчётов (research-sources.md §3, R94i).

Структура-адаптер: канал уже активен, но сами отчёты приходят через API
`POST /reports` (таск 07) и пишутся в user_reports/fuel_observations напрямую.
Здесь — контракт интерфейса SourceAdapter и health-статус без внешних вызовов.
"""

from __future__ import annotations

from typing import Any

from .base import HEALTH_ONLINE, HealthResult, SourceAdapter, SourceRecord


class UserReportAdapter(SourceAdapter):
    provider_code = "user_reports"
    provider_name = "Пользовательские отчёты"
    capabilities = {"discovery": False, "availability": True, "queue": True}

    def discover_stations(self, region: dict[str, Any]) -> list[SourceRecord]:
        # Discovery-канала нет: каталог не пополняется отчётами (T07 создаёт
        # заявку на новую АЗС для администратора, а не запись каталога здесь).
        return []

    def health_check(self) -> HealthResult:
        # Внутренний канал приложения — «жив», пока живо API.
        return HealthResult(HEALTH_ONLINE, "внутренний канал")