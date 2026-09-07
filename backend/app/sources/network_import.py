"""Импорт официальных списков сетей (CSV/JSON) — research-sources.md §2 (R01/R94i).

Источник файловый: оператор/администратор кладёт файл, адаптер читает его без сети.
Поддерживаемые форматы:
  CSV  — первая строка заголовки (name, lat, lon, brand, address, phone, ref, city, region);
  JSON — список объектов с теми же ключами либо {"stations": [...]}.
Ключи-алиасы (русские/английские варианты) принимаются. health_check проверяет
доступность файла: нет файла → DEGRADED (источник включён, но ждёт данных).
"""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any

from ..core.config import settings
from .base import HEALTH_DEGRADED, HEALTH_ONLINE, HealthResult, SourceAdapter, SourceRecord

# алиасы колонок: каноническое имя -> допустимые заголовки (без учёта регистра)
COLUMN_ALIASES: dict[str, tuple[str, ...]] = {
    "name": ("name", "название", "title", "station"),
    "brand": ("brand", "network", "сеть", "operator", "бренд"),
    "lat": ("lat", "latitude", "широта"),
    "lon": ("lon", "lng", "longitude", "долгота"),
    "address": ("address", "адрес"),
    "phone": ("phone", "телефон"),
    "ref": ("ref", "номер", "station_number", "номер_азс"),
    "city": ("city", "город"),
    "region": ("region", "регион"),
}

CANONICAL = tuple(COLUMN_ALIASES)


def _index_columns(header: list[str]) -> dict[str, int]:
    """Заголовок CSV → {каноническое имя: индекс колонки}."""
    lowered = [h.strip().lower() for h in header]
    index: dict[str, int] = {}
    for canonical, aliases in COLUMN_ALIASES.items():
        for i, cell in enumerate(lowered):
            if cell in aliases:
                index[canonical] = i
                break
    return index


def _cell(row: dict[str, str], key: str) -> str:
    return (row.get(key) or "").strip()


def record_from_row(row: dict[str, str], index: int) -> SourceRecord:
    brand = _cell(row, "brand")
    ref = _cell(row, "ref")
    ext_id = f"{brand or 'station'}-{ref or index}"
    lat = _cell(row, "lat")
    lon = _cell(row, "lon")
    if not lat or not lon:
        raise ValueError(f"строка {index}: нет координат lat/lon")
    name = _cell(row, "name") or brand
    parts = [p for p in (_cell(row, "address"), _cell(row, "city")) if p]
    payload = json.dumps(row, ensure_ascii=False)
    return SourceRecord(
        external_id=ext_id,
        latitude=float(lat.replace(",", ".")),
        longitude=float(lon.replace(",", ".")),
        brand_raw=brand,
        name_raw=name,
        address_raw=", ".join(parts),
        payload=payload,
        extra={"phone": _cell(row, "phone"), "city": _cell(row, "city"), "region": _cell(row, "region")},
    )


def parse_csv(text: str) -> list[SourceRecord]:
    rows = list(csv.DictReader(text.splitlines()))
    if not rows:
        return []
    index = _index_columns(rows[0].keys() if rows else [])  # header доступен в DictReader
    # DictReader уже разложил по заголовкам; переименовываем в канонические
    renamed: list[dict[str, str]] = []
    for raw in rows:
        mapped: dict[str, str] = {}
        for canonical, i in index.items():
            key = list(raw.keys())[i] if i < len(raw) else None
            if key is not None:
                mapped[canonical] = raw[key]
        renamed.append(mapped)
    return [record_from_row(r, i + 1) for i, r in enumerate(renamed)]


def parse_json(data: Any) -> list[SourceRecord]:
    if isinstance(data, dict):
        data = data.get("stations", [])
    if not isinstance(data, list):
        raise ValueError("JSON должен быть списком объектов или {\"stations\": [...]}")
    return [record_from_row({k: str(v) for k, v in r.items()}, i + 1) for i, r in enumerate(data)]


def parse_file(path: str | Path) -> list[SourceRecord]:
    """Парсит файл по расширению: .csv / .json (+ .jsonl)."""
    p = Path(path)
    suffix = p.suffix.lower()
    text = p.read_text(encoding="utf-8-sig")
    if suffix == ".csv":
        return parse_csv(text)
    if suffix in (".json", ".jsonl"):
        return parse_json(json.loads(text))
    raise ValueError(f"неизвестный формат файла импорта: {suffix}")


class NetworkImportAdapter(SourceAdapter):
    provider_code = "network_import"
    provider_name = "Импорт списков сетей (CSV/JSON)"
    capabilities = {"discovery": True, "availability": False, "queue": False}

    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path) if path is not None else Path(settings.network_import_path or "")

    def discover_stations(self, region: dict[str, Any]) -> list[SourceRecord]:
        if not self.path or not self.path.is_file():
            raise FileNotFoundError(f"файл импорта не задан или не найден: {self.path}")
        return parse_file(self.path)

    def health_check(self) -> HealthResult:
        if self.path and self.path.is_file():
            return HealthResult(HEALTH_ONLINE, f"файл доступен: {self.path.name}")
        return HealthResult(HEALTH_DEGRADED, "файл импорта не задан (settings.network_import_path)")