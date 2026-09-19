"""E2E: админский импорт CSV при разделении api и worker (как в контейнерах).

Главный риск у пилота — не docker сам по себе, а **разные файловые системы**:
админка (процесс `api`) сохраняет загрузку в свой каталог
(`FUELRADAR_CSV_UPLOAD_DIR`), а воркер — отдельный процесс — ищет файл по
`NETWORK_IMPORT_PATH`. Если это не один и тот же файл на общем томе, задание
падает с `FileNotFoundError`, а карта молча живёт без обогащённого каталога.

Docker в CI и на машине разработчика может отсутствовать, поэтому скрипт
воспроизводит то же разделение без контейнеров: две переменные как в
`docker-compose.yml` (см. `tests/test_compose_config.py`), два процесса, и у
воркера **сознательно нет** `FUELRADAR_CSV_UPLOAD_DIR` — ему он и не нужен.

  1. `api` (TestClient, env как у сервиса `api`): bootstrap ADMIN →
     `POST /admin/catalog-gaps/import-csv` → файл лёг в каталог загрузки;
  2. фаза «как было»: тик воркера **без** `NETWORK_IMPORT_PATH` — задание
     обязано упасть (`FileNotFoundError`), это исходный дефект;
  3. фаза «как в compose»: повторный импорт и тик воркера с
     `NETWORK_IMPORT_PATH=<каталог загрузки>/catalog-enrichment.csv` — задание
     DONE, записи источника и станции мастер-каталога на месте.

Запуск:  cd backend && python scripts/e2e_csv_import_split.py
Офлайн:  сеть не используется — активным остаётся только файловый источник.

Потолок частоты источника (`min_interval_minutes`) в симуляции обнулён: обе
фазы должны выполняться сразу, расписание — не предмет этой проверки.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

# Изолированное окружение — до любых импортов приложения (как в tests/conftest.py).
_TMP = tempfile.mkdtemp(prefix="fuelradar_split_e2e_")
_BACKEND = Path(__file__).resolve().parents[1]
# Каталог загрузки: в контейнерах это /data/import на общем томе fuelradar-data.
_IMPORT_DIR = Path(_TMP) / "import"

os.environ["DATABASE_URL"] = f"sqlite:///{Path(_TMP) / 'e2e.db'}"
os.environ["FUELRADAR_NO_ENV_FILE"] = "1"
os.environ["FUELRADAR_CSV_UPLOAD_DIR"] = str(_IMPORT_DIR)
os.environ["DEFAULT_REGION_CITY"] = "Краснодар"
os.environ["DEFAULT_REGION_RADIUS_KM"] = "10"

sys.path.insert(0, str(_BACKEND))

from sqlalchemy import select, update  # noqa: E402

from app.api.admin import CSV_IMPORT_FILENAME  # noqa: E402
from app.db.models import (  # noqa: E402
    CollectionJob,
    SourceHealth,
    SourceProvider,
    SourceStationRecord,
    Station,
)
from app.db.session import SessionLocal, init_db  # noqa: E402

# Координаты внутри пилотного региона (Краснодар), строки — как из админского экспорта.
CSV_TEXT = (
    "name,brand,lat,lon,address,phone,ref,city,region,osm_url\n"
    "АЗС Лукойл №77,Лукойл,45.035500,38.975300,ул. Новая 15,+7 861 111-22-33,447783364,"
    "Краснодар,Краснодарский край,https://www.openstreetmap.org/node/447783364\n"
    "АЗС Роснефть №12,Роснефть,45.044000,38.981000,ул. Ставропольская 20,+7 861 222-33-44,447783399,"
    "Краснодар,Краснодарский край,https://www.openstreetmap.org/node/447783399\n"
)

# Программа воркера — запускается отдельным процессом, чтобы env-разделение
# сервисов было настоящим, а не эмуляцией внутри одного интерпретатора.
WORKER_CODE = (
    "from app.core.config import settings\n"
    "from app.db.session import SessionLocal\n"
    "from app.worker import Worker\n"
    "from cli.regions import resolve_region\n"
    "region = resolve_region(default_city=settings.default_region_city,\n"
    "                        radius_km=settings.default_region_radius_km)\n"
    "print('tid: worker tick ->', Worker(SessionLocal, region).run_once())\n"
)


def worker_env(**extra: str) -> dict[str, str]:
    """Env воркера как в docker-compose.yml: без FUELRADAR_CSV_UPLOAD_DIR."""
    env = {**os.environ, "NETWORK_LISTS_URLS": "", **extra}
    env.pop("FUELRADAR_CSV_UPLOAD_DIR", None)
    return env


def run_worker(**extra: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-c", WORKER_CODE],
        cwd=str(_BACKEND),
        env=worker_env(**extra),
        capture_output=True,
        text=True,
    )


def upload(client, csv_text: str) -> dict:
    response = client.post(
        "/api/v1/admin/catalog-gaps/import-csv",
        files={"file": ("enriched.csv", csv_text, "text/csv")},
    )
    if response.status_code != 200:
        raise SystemExit(f"импорт не принят: {response.status_code} {response.text}")
    return response.json()


def last_job(session, provider_id: int) -> CollectionJob | None:
    return session.scalar(
        select(CollectionJob)
        .where(CollectionJob.source_provider_id == provider_id)
        .order_by(CollectionJob.id.desc())
    )


def main() -> int:  # noqa: C901 — сценарий читается сверху вниз
    from fastapi.testclient import TestClient

    from app.main import app

    init_db()
    with SessionLocal() as session:
        # Офлайн-симуляция: сетевые источники выключены, потолок частоты снят.
        session.execute(
            update(SourceProvider)
            .where(SourceProvider.code != "network_import")
            .values(status="NOT_USED")
        )
        session.execute(
            update(SourceProvider)
            .where(SourceProvider.code == "network_import")
            .values(min_interval_minutes=0)
        )
        session.commit()
        provider_id = session.scalar(
            select(SourceProvider.id).where(SourceProvider.code == "network_import")
        )

    client = TestClient(app)
    boot = client.post(
        "/api/v1/auth/bootstrap",
        json={
            "display_name": "Пилот Оператор",
            "email": "pilot@example.com",
            "password": "PilotPass12345",
            "password_confirm": "PilotPass12345",
        },
    )
    if boot.status_code != 201:
        raise SystemExit(f"bootstrap не прошёл: {boot.status_code} {boot.text}")

    ok = True
    print("=== ФАЗА 1: как было (воркер без NETWORK_IMPORT_PATH) ===")
    first = upload(client, CSV_TEXT)
    saved = Path(first["saved"])
    in_shared_dir = saved.is_file() and _IMPORT_DIR in saved.parents
    print(f"  api записал: {saved}")
    print(f"  файл в каталоге загрузки ({_IMPORT_DIR.name}/): {'да' if in_shared_dir else 'нет'}")
    ok &= in_shared_dir
    ok &= saved.name == CSV_IMPORT_FILENAME

    proc = run_worker()
    if proc.returncode != 0:
        print(proc.stdout, proc.stderr)
        return 1
    with SessionLocal() as session:
        job = last_job(session, provider_id)
        health = session.scalar(
            select(SourceHealth).where(SourceHealth.source_provider_id == provider_id)
        )
        expected_failure = job.status == "FAILED" and job.error_message == "FileNotFoundError"
        print(f"  задание №{job.id}: {job.status} ({job.error_message or '—'}) — ожидалось FAILED/FileNotFoundError")
        print(f"  health источника: {health.health if health else '—'}")
        ok &= expected_failure

    print("\n=== ФАЗА 2: как в compose (NETWORK_IMPORT_PATH на тот же файл) ===")
    second = upload(client, CSV_TEXT)
    # Повторный импорт перезаписывает тот же файл, а не заводит новый — иначе
    # воркер читал бы прошлую загрузку.
    ok &= Path(second["saved"]) == saved
    proc = run_worker(NETWORK_IMPORT_PATH=str(saved))
    if proc.returncode != 0:
        print(proc.stdout, proc.stderr)
        return 1
    print(f"  воркер получил NETWORK_IMPORT_PATH={saved}")

    with SessionLocal() as session:
        job = last_job(session, provider_id)
        health = session.scalar(
            select(SourceHealth).where(SourceHealth.source_provider_id == provider_id)
        )
        records = list(
            session.scalars(
                select(SourceStationRecord).where(
                    SourceStationRecord.source_provider_id == provider_id
                )
            )
        )
        linked = [r for r in records if r.station_id]
        stations = list(session.scalars(select(Station).where(Station.is_active.is_(True))))

        print(f"  задание №{job.id}: {job.status} ({job.error_message or '—'}), записей {job.records_count}")
        ok &= job.status == "DONE" and job.records_count == 2
        print(f"  health источника: {health.health if health else '—'} (ожидалось ONLINE)")
        ok &= bool(health and health.health == "ONLINE")
        print(f"  записей network_import: {len(records)} (ожидалось 2)")
        ok &= len(records) == 2
        print(f"  из них привязано к станциям: {len(linked)} (ожидалось 2)")
        ok &= len(linked) == 2
        brands = {r.brand_raw for r in records}
        print(f"  бренды в мастер-каталоге: {sorted(brands)}")
        ok &= brands == {"Лукойл", "Роснефть"}
        print(f"  станций в каталоге: {len(stations)}")
        ok &= len(stations) == 2

    print("\nИТОГ:", "КОНТРАКТ КАТАЛОГА ЗАГРУЗКИ СОБЛЮДЁН ✓" if ok else "ЕСТЬ РАСХОЖДЕНИЯ ✗")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
