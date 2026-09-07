"""Адаптер OpenStreetMap/Overpass (R01/R81/R94i).

Discovery-источник: `amenity=fuel` по bbox региона. Availability не выдаёт —
теги `fuel:*` описывают ассортимент, а не наличие сейчас (research-sources.md §1).
Атрибуция ODbL обязательна и сохраняется (поле attribution + SourceProvider).
Сеть — только через инъекцию `http_get` (в тестах/offline — фикстуры, без сети).
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable
from typing import Any

from ..core.config import settings
from .base import (
    HEALTH_AUTH_ERROR,
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

QUERY_TMPL = (
    "[out:json][timeout:25];\n"
    'node["amenity"="fuel"]({south:.6f},{west:.6f},{north:.6f},{east:.6f});\n'
    "out body;"
)

PROBE_QUERY = "[out:json];node(0,0,0,0);out count;"


def bbox_from_region(region: dict[str, Any]) -> tuple[float, float, float, float]:
    """(south, west, north, east) из центра+радиуса или готового bbox."""
    if "bbox" in region:
        bbox = region["bbox"]
        return float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])
    lat = float(region["lat"])
    lon = float(region["lon"])
    radius_km = float(region.get("radius_km", 10.0))
    d_lat = radius_km / 111.0
    d_lon = radius_km / (111.0 * math.cos(math.radians(lat))) if abs(lat) < 89.0 else d_lat
    return lat - d_lat, lon - d_lon, lat + d_lat, lon + d_lon


def _default_http_get(url: str, params: dict[str, str]) -> dict[str, Any]:
    """Реальный транспорт. В тестах заменяется фикстурой."""
    import httpx

    try:
        resp = httpx.get(url, params=params, timeout=settings.overpass_timeout_seconds)
    except httpx.HTTPError as exc:
        raise AdapterError(f"overpass network error: {exc}") from exc
    if resp.status_code == 429:
        raise RateLimitedError("overpass rate limited (429)")
    if resp.status_code == 403:
        raise AuthError("overpass access denied (403)")
    if resp.status_code != 200:
        raise AdapterError(f"overpass http {resp.status_code}")
    return resp.json()


def parse_overpass_element(el: dict[str, Any]) -> SourceRecord | None:
    """Элемент Overpass `out body` → SourceRecord; непригодные — None."""
    if el.get("type") != "node":
        return None
    tags = el.get("tags") or {}
    if tags.get("amenity") not in (None, "fuel"):
        return None
    lat = el.get("lat")
    lon = el.get("lon")
    if lat is None or lon is None:
        return None
    parts = []
    for key in ("addr:street", "addr:housenumber", "addr:city"):
        if tags.get(key):
            parts.append(tags[key])
    brand = tags.get("brand") or tags.get("operator") or ""
    name = tags.get("name") or brand or ""
    fuel_tags = {k: v for k, v in tags.items() if k.startswith("fuel:")}
    return SourceRecord(
        external_id=f"node/{el['id']}",
        latitude=float(lat),
        longitude=float(lon),
        brand_raw=brand,
        name_raw=name,
        address_raw=", ".join(parts),
        payload=json.dumps(el, ensure_ascii=False),
        extra={"ref": tags.get("ref", ""), "phone": tags.get("phone", ""),
               "opening_hours": tags.get("opening_hours", ""), "fuel_tags": fuel_tags},
    )


class OverpassAdapter(SourceAdapter):
    provider_code = "osm_overpass"
    provider_name = "OpenStreetMap (Overpass)"
    attribution = "© OpenStreetMap contributors"
    capabilities = {"discovery": True, "availability": False, "queue": False}

    def __init__(self, endpoint: str | None = None, http_get: Callable | None = None) -> None:
        self.endpoint = endpoint or settings.overpass_endpoint
        self._http_get = http_get or _default_http_get

    def discover_stations(self, region: dict[str, Any]) -> list[SourceRecord]:
        south, west, north, east = bbox_from_region(region)
        query = QUERY_TMPL.format(south=south, west=west, north=north, east=east)
        data = self._http_get(self.endpoint, {"data": query})
        remark = data.get("remark")
        if remark and "error" in str(remark).lower():
            raise AdapterError(f"overpass remark: {remark}")
        records = [r for r in (parse_overpass_element(el) for el in data.get("elements", [])) if r is not None]
        return records

    def get_fuel_availability(self, external_id: str) -> list[dict[str, Any]]:
        # Discovery-источник: наличие сейчас не даёт (research-sources.md §1).
        return []

    def health_check(self) -> HealthResult:
        try:
            self._http_get(self.endpoint, {"data": PROBE_QUERY})
            return HealthResult(HEALTH_ONLINE, "overpass отвечает")
        except RateLimitedError as exc:
            return HealthResult(HEALTH_RATE_LIMITED, str(exc))
        except AuthError as exc:
            return HealthResult(HEALTH_AUTH_ERROR, str(exc))
        except AdapterError as exc:
            return HealthResult(HEALTH_OFFLINE, str(exc))