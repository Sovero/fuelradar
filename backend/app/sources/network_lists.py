"""Адаптер сетевых списков АЗС по HTTP (research-sources.md §2, R01/R94i).

Первый источник, переведённый из RESEARCH_REQUIRED в рабочий код: крупные сети
(Лукойл, Роснефть, Газпромнефть…) и региональные порталы публикуют перечни АЗС
открытыми файлами. Статус в сидах — NOT_USED: адаптер реален, но без настроенных
URL ничего не собирает; активация — через админку (PATCH /admin/sources/{id})
после заполнения NETWORK_LISTS_URLS.

Форматы одного файла (определяются по содержимому, не по расширению):
  JSON    — список объектов либо {"stations": [...]} с ключами-алиасами
            (те же, что у network_import: name/brand/lat/lon/address/…);
  GeoJSON — FeatureCollection: Point-геометрия + properties;
  CSV     — заголовки-алиасы (русские/английские).

Источник discovery-only: списки описывают перечень АЗС, а не наличие топлива
сейчас. Сеть — только через инъекцию `http_get` (в тестах без сети), как у
Overpass. Координаты фильтруются по bbox региона (клиппинг зоны пилота).
"""

from __future__ import annotations

import csv
import io
import json
import re
from collections.abc import Callable
from typing import Any

from ..core.config import settings
from .base import (
    HEALTH_AUTH_ERROR,
    HEALTH_DEGRADED,
    HEALTH_OFFLINE,
    HEALTH_ONLINE,
    HEALTH_RATE_LIMITED,
    AdapterError,
    AuthError,
    HealthResult,
    RateLimitedError,
    SourceAdapter,
    SourceRecord,
)
from .network_import import COLUMN_ALIASES, record_from_row
from .overpass import bbox_from_region

_ALIASES_BY_LOWER: dict[str, str] = {
    alias: canonical for canonical, aliases in COLUMN_ALIASES.items() for alias in aliases
}


def _canonical_row(raw: dict[str, Any]) -> dict[str, str]:
    """Произвольный словарь → строка с каноническими ключами (алиасы, любой регистр)."""
    lowered = {str(k).strip().lower(): v for k, v in raw.items() if v is not None}
    return {canonical: str(lowered[alias]) for alias, canonical in _ALIASES_BY_LOWER.items() if alias in lowered}


def parse_geojson(data: dict[str, Any]) -> list[dict[str, str]]:
    """FeatureCollection → строки канонических полей; координаты — из Point-геометрии."""
    if data.get("type") != "FeatureCollection":
        raise ValueError("GeoJSON должен быть FeatureCollection")
    rows: list[dict[str, str]] = []
    for i, feature in enumerate(data.get("features", []), start=1):
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "Point":
            continue
        coords = geometry.get("coordinates") or []
        if len(coords) < 2:
            continue
        row = _canonical_row(dict(feature.get("properties") or {}))
        row.setdefault("lon", str(coords[0]))
        row.setdefault("lat", str(coords[1]))
        row.setdefault("ref", str(i))
        rows.append(row)
    return rows


def parse_stations_payload(text: str) -> list[SourceRecord]:
    """Тело ответа → записи; формат определяется по содержимому (JSON → GeoJSON → CSV)."""
    stripped = text.lstrip("﻿ \t\r\n")  # BOM/пробелы до определения формата
    data: Any = None
    if stripped[:1] in ("{", "["):
        try:
            data = json.loads(stripped)
        except json.JSONDecodeError:
            data = None  # упадём в CSV-ветку (файлы бывают «почти JSON»)
    if isinstance(data, dict) and data.get("type") == "FeatureCollection":
        rows = parse_geojson(data)
    elif isinstance(data, dict):
        payload = data.get("stations", data)
        if not isinstance(payload, list):
            raise ValueError("JSON должен быть списком объектов или {\"stations\": [...]}")
        rows = [_canonical_row(item) for item in payload]
    elif isinstance(data, list):
        rows = [_canonical_row(item) for item in data]
    else:
        reader = csv.DictReader(io.StringIO(text))
        rows = [_canonical_row(dict(row)) for row in reader]
    return [record_from_row(row, i + 1) for i, row in enumerate(rows)]


def split_urls(raw: str) -> list[str]:
    """NETWORK_LISTS_URLS → список URL; разделители — «;» или перевод строки."""
    return [u.strip() for u in re.split(r"[;\r\n]+", raw or "") if u.strip()]


def _default_http_get(url: str) -> str:
    """Реальный транспорт. В тестах заменяется фикстурой."""
    import httpx

    try:
        resp = httpx.get(url, timeout=settings.network_lists_timeout_seconds, follow_redirects=True)
    except httpx.HTTPError as exc:
        raise AdapterError(f"network lists error: {exc}") from exc
    if resp.status_code == 429:
        raise RateLimitedError("network lists rate limited (429)")
    if resp.status_code == 403:
        raise AuthError("network lists access denied (403)")
    if resp.status_code != 200:
        raise AdapterError(f"network lists http {resp.status_code}")
    return resp.text


class NetworkListsAdapter(SourceAdapter):
    provider_code = "network_lists"
    provider_name = "Сетевые списки АЗС (HTTP)"
    capabilities = {"discovery": True, "availability": False, "queue": False}

    def __init__(self, urls: list[str] | None = None, http_get: Callable[[str], str] | None = None) -> None:
        self.urls = urls if urls is not None else split_urls(settings.network_lists_urls)
        self._http_get = http_get or _default_http_get

    def discover_stations(self, region: dict[str, Any]) -> list[SourceRecord]:
        if not self.urls:
            raise AdapterError("URL списков сетей не настроен (NETWORK_LISTS_URLS)")
        south, west, north, east = bbox_from_region(region)
        records: list[SourceRecord] = []
        for url in self.urls:
            text = self._http_get(url)
            for record in parse_stations_payload(text):
                if south <= record.latitude <= north and west <= record.longitude <= east:
                    records.append(record)
        return records

    def health_check(self) -> HealthResult:
        if not self.urls:
            return HealthResult(HEALTH_DEGRADED, "URL списков не настроен (NETWORK_LISTS_URLS)")
        try:
            self._http_get(self.urls[0])
            return HealthResult(HEALTH_ONLINE, f"список доступен: {self.urls[0]}")
        except RateLimitedError as exc:
            return HealthResult(HEALTH_RATE_LIMITED, str(exc))
        except AuthError as exc:
            return HealthResult(HEALTH_AUTH_ERROR, str(exc))
        except AdapterError as exc:
            return HealthResult(HEALTH_OFFLINE, str(exc))
