"""Контракт docker-compose (T02/R83): файловые источники внутри контейнеров.

Ручное обогащение каталога работает, только если сходятся три вещи:

1. `api` пишет загрузку из админки в `FUELRADAR_CSV_UPLOAD_DIR`;
2. `worker` читает ровно тот файл по `NETWORK_IMPORT_PATH` — внутри этого каталога,
   имя файла фиксировано (`app.api.admin.CSV_IMPORT_FILENAME`);
3. каталог лежит на общем томе: `api` и `worker` — разные контейнеры с разными
   файловыми системами, локальный путь одного для другого не существует.

Тест не запускает docker (его может не быть на машине разработчика и в CI): он
разбирает сами compose-файлы и берёт **дефолты подстановок** `${VAR:-default}` —
у оператора эти переменные в `.env` не заданы, значит в контейнеры уезжает именно
дефолт. Профиль `prod` — это оверлей поверх базового файла, поэтому проверяются
оба варианта запуска (`docker-compose.yml` и он же + `docker-compose.prod.yml`).
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

from app.api.admin import CSV_IMPORT_FILENAME

ROOT = Path(__file__).resolve().parents[2]
INTERPOLATION = re.compile(r"^\$\{([A-Z0-9_]+):-(.*)\}$")
# Каталог импорта обязан лежать на общем томе — вне контейнерной ФС.
SHARED_MOUNT = "/data"


def _load(name: str) -> dict:
    return yaml.safe_load((ROOT / name).read_text(encoding="utf-8"))


def _default(value: str) -> str:
    """Значение переменной, которое попадёт в контейнер без .env оператора."""
    match = INTERPOLATION.match(str(value))
    return match.group(2) if match else str(value)


def _service_env(profile: str, service: str) -> dict[str, str]:
    data = _load("docker-compose.yml")
    if profile == "prod":
        overlay = _load("docker-compose.prod.yml")
        for code, extra in overlay.get("services", {}).items():
            merged = data["services"].setdefault(code, {})  # оверлей заводит и новые сервисы
            env = dict(merged.get("environment") or {})
            env.update(extra.get("environment") or {})
            merged["environment"] = env
    return {key: _default(value) for key, value in (data["services"][service].get("environment") or {}).items()}


def _mount_targets(profile: str, service: str) -> dict[str, str]:
    """{источник тома: точка монтирования} для сервиса (с учётом оверлея)."""
    data = _load("docker-compose.yml")
    if profile == "prod":
        overlay = _load("docker-compose.prod.yml")
        for code, extra in overlay.get("services", {}).items():
            merged = data["services"].setdefault(code, {})
            current = list(merged.get("volumes") or [])
            current.extend(extra.get("volumes") or [])
            merged["volumes"] = current
    targets: dict[str, str] = {}
    for entry in data["services"][service].get("volumes") or []:
        source, _, target = str(entry).partition(":")
        targets[source] = target
    return targets


@pytest.fixture(params=["dev", "prod"])
def profile(request: pytest.FixtureRequest) -> str:
    return request.param


def test_api_and_worker_share_import_dir(profile: str) -> None:
    """Каталог загрузки админки и путь воркера — один и тот же файл на общем томе."""
    api_dir = _service_env(profile, "api")["FUELRADAR_CSV_UPLOAD_DIR"]
    worker_path = _service_env(profile, "worker")["NETWORK_IMPORT_PATH"]

    assert api_dir == f"{SHARED_MOUNT}/import"
    assert worker_path == f"{api_dir}/{CSV_IMPORT_FILENAME}"

    api_mounts = _mount_targets(profile, "api")
    worker_mounts = _mount_targets(profile, "worker")
    shared = sorted(set(api_mounts.items()) & set(worker_mounts.items()))
    assert (("fuelradar-data", SHARED_MOUNT)) in shared, "нет общего тома у api и worker"
    assert api_dir.startswith(f"{SHARED_MOUNT}/"), "каталог импорта вне общего тома"


def test_worker_gets_network_lists_urls(profile: str) -> None:
    """`NETWORK_LISTS_URLS` доезжает до воркера (пусто → источник «не настроено»)."""
    assert "NETWORK_LISTS_URLS" in _service_env(profile, "worker")
