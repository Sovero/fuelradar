"""T02 — CLI seed (A01): офлайн-наполнение каталога, счётчики, атрибуция, ошибки.

БД общая на сессию тестов, поэтому проверки — по уникальным внешним ID (tmp-файл)
и по журналу collection_jobs (append-only), а не по общим счётчикам строк.
"""

from __future__ import annotations

import pytest
from sqlalchemy import func, select

from app.db.models import CollectionJob, SourceStationRecord
from app.db.session import init_db


@pytest.fixture(scope="module", autouse=True)
def _db() -> None:
    init_db()


def _seed_jobs_count(db_session) -> int:
    return db_session.scalar(select(func.count()).select_from(CollectionJob).where(CollectionJob.trigger == "seed"))


def test_seed_offline_populates_catalog(db_session, capsys) -> None:
    from cli.seed import main

    jobs_before = _seed_jobs_count(db_session)
    code = main(["--region", "krasnodar", "--offline"])
    out = capsys.readouterr().out
    assert code == 0
    assert "Итого: 7 записей" in out  # 4 OSM-фикстура + 3 CSV-фикстура
    assert "© OpenStreetMap contributors" in out
    assert "osm_overpass" in out and "network_import" in out
    # каждый активный источник записал свой job-журнал (R84): OSM + импорт + user_reports
    assert _seed_jobs_count(db_session) - jobs_before == 3


def test_seed_with_custom_file_populates_unique_ids(tmp_path, db_session, capsys) -> None:
    """Сквозная проверка: файл импорта → source_station_records с уникальными ID."""
    from cli.seed import main

    csv_file = tmp_path / "stations.csv"
    csv_file.write_text(
        "name,brand,lat,lon,ref\n"
        "Тестовая АЗС 9001,ТестСеть,45.1000,38.9000,9001\n"
        "Тестовая АЗС 9002,ТестСеть,45.1100,38.9100,9002\n",
        encoding="utf-8",
    )
    code = main(["--region", "krasnodar", "--offline", "--source", "network_import", "--file", str(csv_file)])
    out = capsys.readouterr().out
    assert code == 0
    assert "Итого: 2 записи" in out

    for ext_id in ("ТестСеть-9001", "ТестСеть-9002"):
        row = db_session.scalar(
            select(SourceStationRecord).where(SourceStationRecord.external_id == ext_id)
        )
        assert row is not None, ext_id
        assert row.brand_raw == "ТестСеть"


def test_seed_unknown_region_returns_2(capsys) -> None:
    from cli.seed import main

    code = main(["--region", "несуществующий-регион"])
    assert code == 2
    assert "не указан регион" in capsys.readouterr().err


def test_seed_direct_coords_works(capsys) -> None:
    from cli.seed import main

    code = main(["--lat", "45.03", "--lon", "38.98", "--radius-km", "5", "--offline", "--source", "network_import"])
    out = capsys.readouterr().out
    assert code == 0
    assert "Регион: произвольная точка" in out
    assert "Итого: 3 записи" in out