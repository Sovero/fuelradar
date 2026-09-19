"""Импорт официальных списков сетей (CSV/JSON) — research-sources.md §2 (R01/R94i).

Источник файловый: оператор/администратор кладёт файл, адаптер читает его без сети.
Поддерживаемые форматы:
  CSV  — первая строка заголовки (name, lat, lon, brand, address, phone, ref, city, region);
  JSON — список объектов с теми же ключами либо {"stations": [...]}.
Ключи-алиасы (русские/английские варианты) принимаются. health_check проверяет
доступность файла: нет файла → DEGRADED (источник включён, но ждёт данных).

Файл по умолчанию — загрузка админского импорта CSV (вкладка «Покрытие
каталога»): тот же каталог загрузки, поэтому отдельного пути к файлу не нужно,
одна переменная окружения `FUELRADAR_CSV_UPLOAD_DIR` на api и worker
(см. import_file_path). Явный путь (`NETWORK_IMPORT_PATH` или `--file` у
`cli.seed`) остаётся переопределением — для CSV/JSON вне каталога загрузки.
"""

from __future__ import annotations

import csv
import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ..core.config import settings
from .base import HEALTH_DEGRADED, HEALTH_ONLINE, HealthResult, SourceAdapter, SourceRecord

# Имя файла, под которым админский импорт сохраняет загрузку оператора. Живёт
# здесь, а не в api/admin.py: владелец файла — источник, который его читает
# (api только пишет; см. api.admin.import_catalog_csv).
CSV_IMPORT_FILENAME = "catalog-enrichment.csv"

# Без FUELRADAR_CSV_UPLOAD_DIR каталогом загрузки считается backend/data/import —
# рядом с шаблоном-заготовкой krasnodar-unnamed-template.csv (dev-запуск
# без docker работает из коробки: админка пишет, источник читает тот же файл).
DEFAULT_UPLOAD_DIR = Path(__file__).resolve().parents[2] / "data" / "import"


def upload_dir() -> Path:
    """Каталог загрузок админского импорта (FUELRADAR_CSV_UPLOAD_DIR).

    Читается на каждом вызове, а не из settings: каталог подменяют тесты
    (`monkeypatch.setenv`), а settings кэшированы на процесс. Приоритет:
    переменная окружения (тесты, docker) → .env через settings → дефолт.
    """
    return Path(
        os.environ.get("FUELRADAR_CSV_UPLOAD_DIR") or settings.csv_upload_dir or DEFAULT_UPLOAD_DIR
    )


def import_file_path() -> Path:
    """Файл, который читает network_import.

    По умолчанию — загрузка админского импорта CSV из каталога загрузки, то есть
    контракт «админка пишет — источник читает» держится одной переменной
    окружения на оба процесса. Явный NETWORK_IMPORT_PATH переопределяет его,
    если файл лежит вне каталога загрузки (путь «без админки»).
    """
    explicit = os.environ.get("NETWORK_IMPORT_PATH") or settings.network_import_path
    return Path(explicit) if explicit else upload_dir() / CSV_IMPORT_FILENAME


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
        # Явный путь — переопределение (CLI `--file`, файл вне каталога загрузки);
        # None → загрузка админского импорта (import_file_path), разрешается лениво.
        self.explicit_path = Path(path) if path is not None else None

    def resolve_path(self) -> Path:
        """Файл для чтения: явный путь либо загрузка из каталога импорта."""
        return self.explicit_path or import_file_path()

    def discover_stations(self, region: dict[str, Any]) -> list[SourceRecord]:
        path = self.resolve_path()
        if not path.is_file():
            raise FileNotFoundError(f"файл импорта не найден: {path}")
        return parse_file(path)

    def health_check(self) -> HealthResult:
        path = self.resolve_path()
        if path.is_file():
            return HealthResult(HEALTH_ONLINE, f"файл доступен: {path.name}")
        return HealthResult(HEALTH_DEGRADED, f"файл импорта не найден: {path}")

    def file_state(self) -> dict[str, Any]:
        """Что именно читает источник и когда этот файл обновлялся (R58).

        Оператор видит это в админке («Источники» и «Покрытие каталога»), поэтому
        возвращаем и путь, и признак «путь задан явно»: если источник читает файл
        по NETWORK_IMPORT_PATH вне каталога загрузки, импорт из админки в него не
        попадёт — это надо видеть сразу, а не выяснять по «Джоба упала».
        Время — naive-UTC ISO, как остальные даты в API (фронтенд дочитывает «Z»).
        """
        path = self.resolve_path()
        exists = path.is_file()
        size: int | None = None
        modified: str | None = None
        if exists:
            try:
                stat = path.stat()
                size = stat.st_size
                modified = datetime.fromtimestamp(stat.st_mtime, tz=UTC).replace(tzinfo=None).isoformat()
            except OSError:
                # Права/битая ссылка: честнее сказать «файла нет», чем показать
                # путь как рабочий и молчать о том, что прочитать его не выйдет.
                exists = False
        explicit = self.explicit_path is not None or bool(
            os.environ.get("NETWORK_IMPORT_PATH") or settings.network_import_path
        )
        return {
            "path": str(path),
            "name": path.name,
            "directory": str(path.parent),
            "exists": exists,
            "size_bytes": size,
            "modified_at": modified,
            "explicit": explicit,
            "upload_dir": str(upload_dir()),
        }