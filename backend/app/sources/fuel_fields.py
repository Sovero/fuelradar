"""Наличие топлива из сетевых списков (R13/R15/R17) — чистые функции без сети и БД.

Первый источник наличия, которому **не нужны отметки водителей**: сеть, региональный
штаб или городской портал публикует перечень АЗС со статусами топлива одним файлом.
Здесь только разбор — строка источника → канонический код топлива (`normalize_fuel`,
R13) и канонический статус (`fuel_status`, R15); сеть и запись наблюдений — в
адаптере и воркере.

Два инварианта, которые нельзя ослабить:

  - **непонятное значение не превращается в «топлива нет»**. Нераспознанное слово —
    это отсутствие данных, и наблюдение по нему не пишется вовсе (R15: UNKNOWN ≠
    UNAVAILABLE). Источник, который говорит «уточняется», не должен выключить АЗС
    на карте;
  - **незнакомое название топлива не выдумывает новый вид** (R13): запись
    пропускается, а не попадает в каталог под именем источника.

Формат (JSON/GeoJSON/CSV) — три равноправных способа сказать одно и то же:

    {"name": "АЗС 12", "lat": 45.03, "lon": 38.97,
     "fuel": {"АИ-95": "есть", "ДТ": "нет"}}          # объект-карта
    {"fuel_аи-95": "есть", "fuel_дт": "нет"}          # колонки/ключи fuel_<топливо>
    "observed_at": "2026-10-06T09:30:00"              # опционально, naive-UTC
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

from ..fuel_status import (
    AVAILABLE,
    FUEL_STATUSES,
    LOW_STOCK,
    UNAVAILABLE,
    UNKNOWN,
)
from ..normalization.fuel import normalize_fuel

# Ключ-карта со статусами: {"fuel": {"АИ-95": "есть"}} (JSON/GeoJSON).
MAP_KEY = "fuel"
# Префиксы колонок/ключей: fuel_аи-95, fuel:дт, топливо_95, наличие-аи-95.
KEY_PREFIXES = ("fuel", "топливо", "наличие")

# Слова источника → канонический статус (R15). Только точные формы: подстрочные
# совпадения опасны («недоступно» содержит «доступно»), поэтому «есть» и «нет»
# распознаются как отдельные слова, а всё прочее честно считается нераспознанным.
STATUS_WORDS: dict[str, str] = {
    AVAILABLE.casefold(): AVAILABLE,
    "есть": AVAILABLE,
    "да": AVAILABLE,
    "в наличии": AVAILABLE,
    "наличие": AVAILABLE,
    "заправка есть": AVAILABLE,
    "ok": AVAILABLE,
    "yes": AVAILABLE,
    "true": AVAILABLE,
    "+": AVAILABLE,
    "работает": AVAILABLE,
    LOW_STOCK.casefold(): LOW_STOCK,
    "мало": LOW_STOCK,
    "ограничено": LOW_STOCK,
    "лимит": LOW_STOCK,
    "до 20 л": LOW_STOCK,
    UNAVAILABLE.casefold(): UNAVAILABLE,
    "нет": UNAVAILABLE,
    "нет топлива": UNAVAILABLE,
    "закончилось": UNAVAILABLE,
    "отсутствует": UNAVAILABLE,
    "no": UNAVAILABLE,
    "false": UNAVAILABLE,
    "-": UNAVAILABLE,
    UNKNOWN.casefold(): UNKNOWN,
    "неизвестно": UNKNOWN,
    "уточняется": UNKNOWN,
    "нет данных": UNKNOWN,
    "?": UNKNOWN,
}

# Ключи времени наблюдения: список может сказать, когда данные были сняты.
OBSERVED_KEYS = ("observed_at", "updated_at", "updated", "обновлено", "время")


def _normalize_key(key: Any) -> str:
    return str(key).strip().casefold()


def _fuel_key_name(key: Any) -> str | None:
    """Ключ колонки → название топлива, если это колонка наличия. Иначе None.

    Принимаются `fuel`, `fuel_<топливо>`, `fuel:<топливо>`, `топливо-<топливо>` —
    разделитель любой из «_», «:», «-» и пробел: списки приходят из разных систем.
    """
    text = str(key).strip()
    lowered = text.casefold()
    for prefix in KEY_PREFIXES:
        if not lowered.startswith(prefix):
            continue
        rest = text[len(prefix) :]
        name = rest.lstrip("_:-. \t").strip()
        if name:
            return name
        if lowered == prefix:
            return prefix  # ключ «fuel» без суффикса — карта значений (см. fuel_entries)
    return None


def parse_status_word(raw: Any) -> str:
    """Значение источника → канонический статус; непонятное → UNKNOWN (R15)."""
    text = str(raw or "").strip().casefold().rstrip(".")
    if not text:
        return UNKNOWN
    if text.upper() in FUEL_STATUSES:
        return text.upper()
    return STATUS_WORDS.get(text, UNKNOWN)


def is_fuel_field(key: Any) -> bool:
    """Похоже ли поле на наличие топлива: карта `fuel`/`топливо` или `fuel_<топливо>`."""
    if _normalize_key(key) in (MAP_KEY.casefold(), "топливо", "наличие"):
        return True
    name = _fuel_key_name(key)
    return name is not None and _normalize_key(name) not in {"топливо", "наличие", MAP_KEY.casefold()}


def is_observed_field(key: Any) -> bool:
    """Ключ времени наблюдения (observed_at/обновлено/…)."""
    return _normalize_key(key) in OBSERVED_KEYS


def fuel_entries(row: Mapping[str, Any]) -> dict[str, Any]:
    """Строка источника → {название топлива: сырое значение} (порядок сохранён)."""
    entries: dict[str, Any] = {}
    for key, value in row.items():
        lowered = _normalize_key(key)
        if lowered in (MAP_KEY.casefold(), "топливо", "наличие") and isinstance(value, Mapping):
            for fuel_name, status in value.items():
                entries[str(fuel_name)] = status
            continue
        name = _fuel_key_name(key)
        if name and _normalize_key(name) not in {"топливо", "наличие", MAP_KEY.casefold()}:
            entries[name] = value
    return entries


def row_observed_at(row: Mapping[str, Any]) -> tuple[bool, datetime | None]:
    """(объявлено ли время наблюдения, время).

    Объявленное, но неразбираемое время — это `(True, None)`: вызывающий обязан
    пропустить статусы строки, а не выдать их за свежие (иначе список недельной
    давности выглядел бы только что снятым).
    """
    for key, value in row.items():
        if _normalize_key(key) not in OBSERVED_KEYS:
            continue
        text = str(value or "").strip()
        if not text:
            continue
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return True, None
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone(UTC).replace(tzinfo=None)
        return True, parsed
    return False, None


def to_availability(entries: Mapping[str, Any]) -> tuple[dict[str, dict[str, str]], int]:
    """{название: значение} → ({код топлива: {status, commercial_name}}, число пропусков).

    Пропуск (счётчик `skipped`) — это не ошибка источника, а честное «мы это не
    поняли»: неизвестное название топлива (R13) или нераспознанный статус (R15).
    Первое упоминание кода топлива выигрывает — дубликаты не перетирают друг друга.
    """
    parsed: dict[str, dict[str, str]] = {}
    skipped = 0
    for raw_name, raw_status in entries.items():
        fuel = normalize_fuel(str(raw_name))
        status = parse_status_word(raw_status)
        if fuel.base_code == "UNKNOWN" or status == UNKNOWN:
            skipped += 1
            continue
        parsed.setdefault(
            fuel.base_code,
            {"status": status, "commercial_name": fuel.commercial_name},
        )
    return parsed, skipped
