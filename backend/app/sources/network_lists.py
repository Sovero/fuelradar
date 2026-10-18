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

Источник умеет и наличие топлива: первая реальная альтернатива отметкам
водителей — сеть, региональный штаб или городской портал публикует один список,
где у каждой АЗС есть статусы топлива (`fuel: {"АИ-95": "есть"}` в JSON или
колонки `fuel_аи-95` в CSV). Разбор — `fuel_fields` (R13/R15: непонятное слово
не становится «нет топлива», незнакомое топливо не выдумывает новый вид).
Такие данные приходят вместе с каталогом одним запросом, поэтому воркер пишет
наблюдения после каталога, а точечные задания на каждую АЗС не ставятся
(`availability_bulk` в capabilities).

Сеть — только через инъекцию `http_get` (в тестах без сети), как у Overpass.
Координаты фильтруются по bbox региона (клиппинг зоны пилота).

Список URL пополняемый: хранится в БД (app_settings, ключ network_lists) и
редактируется в админке (PUT /admin/sources/network-lists) без правки .env и
перезапуска; .env (NETWORK_LISTS_URLS) — стартовый дефолт. Адаптер читает
актуальный список при каждом запуске сбора (лениво), поэтому добавленная в
админке ссылка подхватывается следующим тиком воркера.
"""

from __future__ import annotations

import csv
import io
import json
import re
from collections.abc import Callable, Mapping
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
from .fuel_fields import (
    fuel_entries,
    is_fuel_field,
    is_observed_field,
    row_observed_at,
    to_availability,
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
    return [canonical for canonical, _ in _geojson_pairs(data)]


def _geojson_pairs(data: dict[str, Any]) -> list[tuple[dict[str, str], dict[str, Any]]]:
    """FeatureCollection → [(каноническая строка, сырые properties+координаты)].

    Сырые properties нужны для наличия топлива (см. `fuel_fields`): без них
    колонки `fuel_*` терялись бы при канонизации (payload — тоже сырьё, R84).
    """
    if data.get("type") != "FeatureCollection":
        raise ValueError("GeoJSON должен быть FeatureCollection")
    pairs: list[tuple[dict[str, str], dict[str, Any]]] = []
    for i, feature in enumerate(data.get("features", []), start=1):
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "Point":
            continue
        coords = geometry.get("coordinates") or []
        if len(coords) < 2:
            continue
        raw = dict(feature.get("properties") or {})
        raw.setdefault("lon", coords[0])
        raw.setdefault("lat", coords[1])
        raw.setdefault("ref", str(i))
        pairs.append((_canonical_row(raw), raw))
    return pairs


def _payload_rows(text: str) -> list[tuple[dict[str, str], dict[str, Any]]]:
    """Тело ответа → [(каноническая строка, сырая строка)]; формат — по содержимому."""
    stripped = text.lstrip("﻿ \t\r\n")  # BOM/пробелы до определения формата
    data: Any = None
    if stripped[:1] in ("{", "["):
        try:
            data = json.loads(stripped)
        except json.JSONDecodeError:
            data = None  # упадём в CSV-ветку (файлы бывают «почти JSON»)
    if isinstance(data, dict) and data.get("type") == "FeatureCollection":
        return _geojson_pairs(data)
    if isinstance(data, dict):
        payload = data.get("stations", data)
        if not isinstance(payload, list):
            raise ValueError("JSON должен быть списком объектов или {\"stations\": [...]}")
        raw_rows = [dict(item) for item in payload]
    elif isinstance(data, list):
        raw_rows = [dict(item) for item in data]
    else:
        raw_rows = [dict(row) for row in csv.DictReader(io.StringIO(text))]
    return [(_canonical_row(raw), raw) for raw in raw_rows]


def _fuel_columns(canonical: dict[str, str], raw: Mapping[str, Any]) -> dict[str, Any]:
    """Дописать к строке колонки наличия и времени — payload хранит сырьё (R84).

    Вложенные значения (карта `fuel`) остаются как есть: payload — это JSON, и
    `str({"АИ-95": "есть"})` превратил бы сырьё источника в python-repr.
    """
    merged: dict[str, Any] = dict(canonical)
    for key, value in raw.items():
        if not (is_fuel_field(key) or is_observed_field(key)):
            continue
        if isinstance(value, (Mapping, list)):
            merged[str(key)] = value
        else:
            merged[str(key)] = "" if value is None else str(value)
    return merged


def parse_payload_with_stats(text: str) -> tuple[list[SourceRecord], int]:
    """Тело ответа → (записи, сколько значений наличия распознать не удалось).

    Наличие складывается в `record.extra["availability"]` (уже канонические коды
    топлива и статусы) и остаётся в сыром `payload` — R84. Счётчик пропусков
    нужен журналу сбора: «источник дал 12 статусов, 2 значения не поняты» —
    это диагностика формата, а не ошибка сбора.
    """
    records: list[SourceRecord] = []
    skipped_total = 0
    for i, (canonical, raw) in enumerate(_payload_rows(text)):
        record = record_from_row(_fuel_columns(canonical, raw), i + 1)
        declared, observed = row_observed_at(raw)
        if declared and observed is None:
            # Время объявлено, но не разобрано: статусы строки пропускаем, а не
            # выдаём за только что снятые (R17/R56 — свежесть не выдумываем).
            skipped_total += len(fuel_entries(raw)) or 1
            records.append(record)
            continue
        parsed, skipped = to_availability(fuel_entries(raw))
        skipped_total += skipped
        if parsed:
            items = [{"fuel_code": code, **data} for code, data in parsed.items()]
            if observed is not None:
                for item in items:
                    item["observed_at"] = observed
            record.extra["availability"] = items
        records.append(record)
    return records, skipped_total


def parse_stations_payload(text: str) -> list[SourceRecord]:
    """Тело ответа → записи; формат определяется по содержимому (JSON → GeoJSON → CSV)."""
    return parse_payload_with_stats(text)[0]


def split_urls(raw: str) -> list[str]:
    """NETWORK_LISTS_URLS → список URL; разделители — «;» или перевод строки."""
    return [u.strip() for u in re.split(r"[;\r\n]+", raw or "") if u.strip()]


SETTING_KEY = "network_lists"  # app_settings → {"urls": [...]}


def load_urls(session) -> list[str]:
    """Действующий список URL: из БД (админка), при отсутствии — из .env (дефолт)."""
    from ..db.models import AppSetting

    row = session.get(AppSetting, SETTING_KEY)
    if row is not None:
        urls = [str(u) for u in (row.value or {}).get("urls") or [] if str(u).strip()]
        if urls:
            return urls
    return split_urls(settings.network_lists_urls)


def urls_source(session) -> str:
    """Откуда берётся действующий список: "db" (админка) или "env" (дефолт .env)."""
    from ..db.models import AppSetting

    row = session.get(AppSetting, SETTING_KEY)
    if row is not None and [u for u in (row.value or {}).get("urls") or [] if str(u).strip()]:
        return "db"
    return "env"


def save_urls(session, urls: list[str]) -> list[str]:
    """Сохранить список URL в БД (админка). Пустой список возвращает дефолт .env.

    Возвращает нормализованный список: без дублей и пустых строк, порядок сохранён.
    """
    from ..db.models import AppSetting

    normalized: list[str] = []
    for url in urls:
        cleaned = url.strip()
        if cleaned and cleaned not in normalized:
            normalized.append(cleaned)
    row = session.get(AppSetting, SETTING_KEY)
    if not normalized:
        if row is not None:
            session.delete(row)  # пусто в UI → возврат к .env-дефолту
    elif row is None:
        session.add(AppSetting(key=SETTING_KEY, value={"urls": normalized}))
    else:
        row.value = {"urls": normalized}
    session.commit()
    return normalized if normalized else split_urls(settings.network_lists_urls)


def _default_urls_loader() -> list[str]:
    """Ленивый загрузчик для адаптера: свежий список из БД, фолбэк — .env.

    Отдельная короткоживущая сессия: воркер вызывает адаптер между своими
    транзакциями.
    """
    from ..db.session import SessionLocal

    with SessionLocal() as session:
        return load_urls(session)


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
    # availability=True — источник может сказать, что топливо есть/нет; queue пока
    # нет. availability_bulk — это наличие приезжает вместе с каталогом одним
    # запросом, поэтому воркер не ставит точечные задания на каждую АЗС.
    capabilities = {"discovery": True, "availability": True, "queue": False, "availability_bulk": True}

    def __init__(
        self,
        urls: list[str] | None = None,
        http_get: Callable[[str], str] | None = None,
        urls_loader: Callable[[], list[str]] | None = None,
    ) -> None:
        # urls=None → список берётся динамически (БД → .env) при каждом обращении:
        # пополненный в админке список подхватывает следующий тик воркера.
        self.urls = urls
        self._http_get = http_get or _default_http_get
        self._urls_loader = urls_loader or _default_urls_loader
        # Наличие из последнего сбора: {external_id: [{fuel_code, status, …}]}.
        # Заполняется в discover_stations — повторного запроса на каждую АЗС нет.
        self._availability: dict[str, list[dict[str, Any]]] = {}
        # Сколько значений наличия источник дал, но распознать не удалось (диагностика формата).
        self.skipped_fuel_values = 0

    def current_urls(self) -> list[str]:
        """Действующий список: явный аргумент конструктора (тесты/CLI) или загрузчик.

        Сбой загрузчика (БД недоступна) не роняет сбор — откат к .env-дефолту.
        """
        if self.urls is not None:
            return self.urls
        try:
            return self._urls_loader()
        except Exception:  # noqa: BLE001 — список URL не должен ломать сбор
            return split_urls(settings.network_lists_urls)

    def not_configured_reason(self) -> str | None:
        """Без URL читать нечего: «ждёт данных» (активация — через админку/.env).

        Проверяется до планирования: включённый, но не заполненный источник не
        должен копить сбои на каждом цикле (R84) — оператор видит причину и
        добавляет ссылки списка.
        """
        if self.current_urls():
            return None
        return "URL списков не настроен (NETWORK_LISTS_URLS или админка)"

    def discover_stations(self, region: dict[str, Any]) -> list[SourceRecord]:
        urls = self.current_urls()
        if not urls:
            raise AdapterError("URL списков сетей не настроен (NETWORK_LISTS_URLS или админка)")
        south, west, north, east = bbox_from_region(region)
        records: list[SourceRecord] = []
        availability: dict[str, list[dict[str, Any]]] = {}
        skipped = 0
        for url in urls:
            text = self._http_get(url)
            fetched, url_skipped = parse_payload_with_stats(text)
            skipped += url_skipped
            for record in fetched:
                if not (south <= record.latitude <= north and west <= record.longitude <= east):
                    continue
                records.append(record)
                items = record.extra.get("availability")
                if items:
                    availability[record.external_id] = items
        self._availability = availability
        self.skipped_fuel_values = skipped
        return records

    def bulk_fuel_availability(self) -> dict[str, list[dict[str, Any]]]:
        """Наличие, приехавшее в последнем `discover_stations()` — без второго запроса."""
        return self._availability

    def get_fuel_availability(self, external_id: str) -> list[dict[str, Any]]:
        """Наличие по АЗС. Список читается целиком, точечных запросов у источника нет.

        Живой ответ возможен только в рамках того же сбора: у отдельного задания на
        АЗС кэша нет, поэтому честно пусто (сам такой сбора не планируется —
        `availability_bulk` в capabilities).
        """
        return self._availability.get(external_id, [])

    def health_check(self) -> HealthResult:
        urls = self.current_urls()
        if not urls:
            return HealthResult(HEALTH_DEGRADED, "URL списков не настроен (NETWORK_LISTS_URLS или админка)")
        try:
            self._http_get(urls[0])
            return HealthResult(HEALTH_ONLINE, f"список доступен: {urls[0]}")
        except RateLimitedError as exc:
            return HealthResult(HEALTH_RATE_LIMITED, str(exc))
        except AuthError as exc:
            return HealthResult(HEALTH_AUTH_ERROR, str(exc))
        except AdapterError as exc:
            return HealthResult(HEALTH_OFFLINE, str(exc))
