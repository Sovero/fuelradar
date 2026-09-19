"""Контракт docker-compose (T02/R83): файловый источник внутри контейнеров.

Ручное обогащение каталога работает, только если сходятся две вещи:

1. каталог загрузок импорта (`FUELRADAR_CSV_UPLOAD_DIR`) задан **одинаково** у
   `api` и `worker`: админка (процесс `api`) пишет туда загрузку, а адаптер
   `network_import` в процессе воркера сам читает из него
   `<каталог>/catalog-enrichment.csv` — отдельного пути к файлу нет;
2. каталог лежит на общем томе: `api` и `worker` — разные контейнеры с разными
   файловыми системами, локальный путь одного для другого не существует.

Тест не запускает docker (его может не быть на машине разработчика и в CI): он
разбирает сами compose-файлы и берёт **дефолты подстановок** `${VAR:-default}` —
у оператора эти переменные в `.env` не заданы, значит в контейнеры уезжает именно
дефолт. Профиль `prod` — это оверлей поверх базового файла, поэтому проверяются
оба варианта запуска (`docker-compose.yml` и он же + `docker-compose.prod.yml`).

Отдельно закрывается регресс: вторая настройка пути (`NETWORK_IMPORT_PATH`)
больше не должна появляться в compose — иначе «один каталог + один файл» снова
разъедутся и воркер начнёт искать загрузку не там (см. `import_file_path`).
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

from app.sources.network_import import CSV_IMPORT_FILENAME, NetworkImportAdapter, import_file_path

ROOT = Path(__file__).resolve().parents[2]
INTERPOLATION = re.compile(r"^\$\{([A-Z0-9_]+):-(.*)\}$")
# Каталог импорта обязан лежать на общем томе — вне контейнерной ФС.
SHARED_MOUNT = "/data"
COMPOSE_FILES = ("docker-compose.yml", "docker-compose.prod.yml")


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
    """Каталог загрузки админки и каталог источника — один и тот же, на общем томе."""
    api_dir = _service_env(profile, "api")["FUELRADAR_CSV_UPLOAD_DIR"]
    worker_dir = _service_env(profile, "worker")["FUELRADAR_CSV_UPLOAD_DIR"]

    assert api_dir == f"{SHARED_MOUNT}/import"
    assert worker_dir == api_dir, "воркер читает другой каталог, чем пишет админка"

    assert _mount_targets(profile, "api").get("fuelradar-data") == SHARED_MOUNT, "нет общего тома у api"
    assert _mount_targets(profile, "worker").get("fuelradar-data") == SHARED_MOUNT, "нет общего тома у worker"
    assert api_dir.startswith(f"{SHARED_MOUNT}/"), "каталог импорта вне общего тома"


def test_import_file_resolves_from_upload_dir(profile: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """Источник сам берёт файл из каталога загрузки: compose-значение → путь адаптера."""
    upload_dir = _service_env(profile, "api")["FUELRADAR_CSV_UPLOAD_DIR"]
    monkeypatch.delenv("NETWORK_IMPORT_PATH", raising=False)
    monkeypatch.setenv("FUELRADAR_CSV_UPLOAD_DIR", upload_dir)

    expected = Path(upload_dir) / CSV_IMPORT_FILENAME
    assert import_file_path() == expected
    assert NetworkImportAdapter().resolve_path() == expected


def test_compose_has_no_second_import_path_setting() -> None:
    """Второй настройки пути к файлу в compose нет — только каталог загрузки."""
    for name in COMPOSE_FILES:
        for number, line in enumerate((ROOT / name).read_text(encoding="utf-8").splitlines(), start=1):
            stripped = line.strip()
            if stripped.startswith("#"):
                continue  # пояснения и историю в комментариях не проверяем
            assert "NETWORK_IMPORT_PATH" not in stripped, f"{name}:{number}: вернулась вторая переменная пути"


def test_worker_gets_network_lists_urls(profile: str) -> None:
    """`NETWORK_LISTS_URLS` доезжает до воркера (пусто → источник «не настроено»)."""
    assert "NETWORK_LISTS_URLS" in _service_env(profile, "worker")
