"""Реестр адаптеров: код источника → класс (R12).

Ингест (T02) и воркер (T06) берут адаптеры отсюда. RESEARCH_REQUIRED-адаптеры
присутствуют в реестре, но не выполняются: ингест фильтрует по статусу источника
из БД (ACTIVE), а сами классы бросают ResearchRequiredError (двойная защита).
"""

from __future__ import annotations

from sqlalchemy import select

from .base import SourceAdapter
from .network_import import NetworkImportAdapter
from .network_lists import NetworkListsAdapter
from .overpass import OverpassAdapter
from .research import (
    GazpromAdapter,
    GazpromNeftAdapter,
    LukoilAdapter,
    RosneftAdapter,
    TBankAdapter,
    TelegramSourceAdapter,
    TwoGisAdapter,
    YandexAdapter,
)
from .user_reports import UserReportAdapter

ADAPTER_CLASSES: dict[str, type[SourceAdapter]] = {
    OverpassAdapter.provider_code: OverpassAdapter,
    NetworkImportAdapter.provider_code: NetworkImportAdapter,
    NetworkListsAdapter.provider_code: NetworkListsAdapter,
    UserReportAdapter.provider_code: UserReportAdapter,
    YandexAdapter.provider_code: YandexAdapter,
    TwoGisAdapter.provider_code: TwoGisAdapter,
    LukoilAdapter.provider_code: LukoilAdapter,
    RosneftAdapter.provider_code: RosneftAdapter,
    GazpromAdapter.provider_code: GazpromAdapter,
    GazpromNeftAdapter.provider_code: GazpromNeftAdapter,
    TBankAdapter.provider_code: TBankAdapter,
    TelegramSourceAdapter.provider_code: TelegramSourceAdapter,
}


def build_adapter(code: str, **kwargs) -> SourceAdapter:
    cls = ADAPTER_CLASSES.get(code)
    if cls is None:
        raise KeyError(f"нет адаптера для источника: {code}")
    return cls(**kwargs)


def provider_by_code(session, code: str):
    from ..db.models import SourceProvider

    return session.scalar(select(SourceProvider).where(SourceProvider.code == code))


def active_provider_codes(session) -> list[str]:
    """Коды источников со статусом ACTIVE (R12/R94i)."""
    from ..db.models import SourceProvider

    rows = session.scalars(select(SourceProvider.code).where(SourceProvider.status == "ACTIVE"))
    return list(rows)