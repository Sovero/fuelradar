"""CLI `seed` — наполнение каталога АЗС из активных источников (A01, R01).

Примеры:
    python -m cli.seed --region krasnodar                     # OSM + импорт (сеть)
    python -m cli.seed --region krasnodar --offline           # фикстуры, без сети
    python -m cli.seed --region krasnodar --source osm_overpass
    python -m cli.seed --lat 45.03 --lon 38.98 --radius-km 5 --file stations.csv

Выход: счётчики по источникам, ошибки, атрибуция OSM (R81). Сбор никогда не
выполняется синхронно в API (R83) — только воркер (T06) или эта CLI-команда.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

_FIXTURES = Path(__file__).resolve().parents[1] / "tests" / "fixtures"


def _ru_plural(n: int, one: str, few: str, many: str) -> str:
    """1 запись / 2 записи / 5 записей."""
    n10, n100 = n % 10, n % 100
    if n10 == 1 and n100 != 11:
        return one
    if 2 <= n10 <= 4 and not 12 <= n100 <= 14:
        return few
    return many


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="seed", description="Наполнение мастер-каталога АЗС из источников")
    p.add_argument("--region", help="имя региона из cli/regions.py (krasnodar, sochi, …)")
    p.add_argument("--lat", type=float, help="центр поиска: широта (вместо --region)")
    p.add_argument("--lon", type=float, help="центр поиска: долгота")
    p.add_argument("--radius-km", type=float, help="радиус поиска, км (по умолчанию 10)")
    p.add_argument("--source", action="append", help="код источника (повторяемый); по умолчанию все ACTIVE")
    p.add_argument("--file", help="файл CSV/JSON для network_import (по умолчанию — загрузка из каталога импорта)")
    p.add_argument("--offline", action="store_true", help="без сети: OSM/импорт из фикстур (демо/тесты)")
    p.add_argument("--no-dedup", action="store_true", help="не запускать дедупликацию после сбора (T03)")
    return p


def _overrides(args: argparse.Namespace):
    """Offline-режим: подменяем адаптеры фикстурами (тесты и демо без сети)."""
    if not args.offline:
        return {}
    from app.sources.network_import import NetworkImportAdapter
    from app.sources.overpass import OverpassAdapter

    def fake_http_get(url: str, params: dict) -> dict:
        # health-проба и discover-запрос возвращают одну фикстуру
        del url, params
        import json

        return json.loads((_FIXTURES / "overpass_krasnodar.json").read_text("utf-8"))

    overrides = {"osm_overpass": OverpassAdapter(http_get=fake_http_get)}
    import_file = args.file or (_FIXTURES / "network_krasnodar.csv")
    overrides["network_import"] = NetworkImportAdapter(path=import_file)
    return overrides


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    from app.core.config import settings
    from app.db.session import SessionLocal, init_db
    from app.stations.ingest import CatalogIngest
    from cli.regions import resolve_region

    try:
        region = resolve_region(
            args.region, lat=args.lat, lon=args.lon, radius_km=args.radius_km, default_city=settings.default_region_city
        )
    except ValueError as exc:
        print(f"ошибка: {exc}", file=sys.stderr)
        return 2

    source_codes = args.source

    init_db()
    overrides = _overrides(args)
    started = time.time()
    with SessionLocal() as session:
        ingest = CatalogIngest(session)
        summary = ingest.collect_catalog(region, source_codes=source_codes, trigger="seed", adapter_overrides=overrides)
        if args.no_dedup:
            dedup_summary = None
        else:
            from sqlalchemy import func, select

            from app.db.models import Station
            from app.dedup import DedupService

            dedup_summary = DedupService(session).process_pending(region)
            stations = session.scalar(select(func.count()).select_from(Station))
        session.commit()

    elapsed = time.time() - started
    total_records = sum(v["records"] for v in summary.values())
    total_errors = sum(v["errors"] for v in summary.values())

    print(f"Регион: {region.get('city')} ({region['lat']:.4f}, {region['lon']:.4f}, r={region.get('radius_km')} км)")
    for code, counts in sorted(summary.items()):
        print(f"  {code:16s} записей: {counts['records']:4d}  ошибок: {counts['errors']}")
    print(
        f"Итого: {total_records} {_ru_plural(total_records, 'запись', 'записи', 'записей')}, "
        f"{total_errors} {_ru_plural(total_errors, 'ошибка', 'ошибки', 'ошибок')}, {elapsed:.1f} с"
    )
    if dedup_summary is not None:
        print(
            f"Дедупликация: автослияний {dedup_summary['auto_merged']}, "
            f"на подтверждение {dedup_summary['review']}, новых станций {dedup_summary['created']}"
        )
        print(f"Станций в мастер-каталоге: {stations}")
    if "osm_overpass" in summary:
        print("Атрибуция: © OpenStreetMap contributors (источник osm_overpass)")

    if total_errors and not source_codes:
        print("Часть источников завершилась ошибкой — подробности в collection_logs/source_health.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())