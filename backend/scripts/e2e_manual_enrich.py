"""E2E-проверка ручного обогащения: CSV + дедуп сливаются с OSM-записями.

Сценарий воспроизводит рабочий процесс оператора:
  1. OSM-сбор (офлайн, из фикстуры tests/fixtures/overpass_krasnodar.json)
     → source_station_records → дедуп создаёт станции мастер-каталога;
  2. оператор заполняет CSV-заготовку тестовыми брендами (Лукойл/Роснефть)
     для двух станций — одна безымянная в OSM (node/1000004), одна уже
     именованная (node/1000002);
  3. повторный инжест через network_import + дедуп: CSV-записи должны
     авто-слиться с OSM-станциями по координатам (external_id разные —
     связывает именно дедуп, а не id).

Запуск:  cd backend && python scripts/e2e_manual_enrich.py
Офлайн:  сеть не используется (Overpass-адаптер подменён фикстурой).
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

# Изолированная БД — до любых импортов приложения (как в tests/conftest.py).
_TMP = tempfile.mkdtemp(prefix="fuelradar_enrich_e2e_")
os.environ["DATABASE_URL"] = f"sqlite:///{os.path.join(_TMP, 'e2e.db')}"
os.environ["FUELRADAR_NO_ENV_FILE"] = "1"
os.environ["DEBUG"] = "true"

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db.models import SourceProvider, SourceStationRecord  # noqa: E402
from app.db.session import SessionLocal, init_db  # noqa: E402
from app.dedup.service import DedupService  # noqa: E402
from app.sources.network_import import NetworkImportAdapter  # noqa: E402
from app.sources.overpass import OverpassAdapter  # noqa: E402
from app.stations.ingest import CatalogIngest  # noqa: E402

REGION = {"city": "Краснодар", "lat": 45.0355, "lon": 38.9753, "radius_km": 10.0}
FIXTURE = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "overpass_krasnodar.json"

# CSV-строки: координаты = точные координаты OSM-нод из фикстуры.
# node/1000004 — безымянная в OSM; node/1000002 — уже «Роснефть».
# Внимание: значения с запятыми в CSV надо заключать в кавычки — поэтому
# адреса без запятых (как и в реальной заготовке оператора).
CSV_ROWS = [
    # name, brand, lat, lon, address, ref
    ("АЗС №4 (обогащено)", "Лукойл", 45.010000, 38.995000, "ул. Тестовая 4", "1000004"),
    ("Роснефть АЗС №2", "Роснефть", 45.028000, 38.979000, "ул. Тестовая 2", "1000002"),
]


def write_csv(path: Path) -> None:
    lines = ["name,brand,lat,lon,address,ref,city,region"]
    for name, brand, lat, lon, address, ref in CSV_ROWS:
        lines.append(f"{name},{brand},{lat:.6f},{lon:.6f},{address},{ref},Краснодар,Краснодарский край")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def dump_records(session, title: str) -> None:
    print(f"\n--- {title} ---")
    rows = session.query(SourceStationRecord).order_by(SourceStationRecord.source_provider_id, SourceStationRecord.id).all()
    for r in rows:
        print(f"  [{r.source_provider_id}] {r.external_id:<22} brand={r.brand_raw!r:<14} "
              f"state={r.dedup_state:<9} station_id={r.station_id}")


def main() -> int:
    init_db()
    csv_path = Path(_TMP) / "enriched-template.csv"
    write_csv(csv_path)

    osm_adapter = OverpassAdapter(http_get=lambda url, params: __import__("json").loads(FIXTURE.read_text("utf-8")))
    csv_adapter = NetworkImportAdapter(path=csv_path)

    with SessionLocal() as session:
        ingest = CatalogIngest(session)
        dedup = DedupService(session)
        provider_id_by_code = {p.code: p.id for p in session.query(SourceProvider).all()}
        osm_pid = provider_id_by_code["osm_overpass"]
        net_pid = provider_id_by_code["network_import"]

        # Шаг 1: OSM-каталог (офлайн-фикстура) + первичный дедуп.
        summary = ingest.collect_catalog(REGION, source_codes=["osm_overpass"], trigger="e2e",
                                         adapter_overrides={"osm_overpass": osm_adapter})
        print(f"OSM ingest: {summary}")
        print(f"dedup #1:   {dedup.process_pending(region=REGION)}")
        dump_records(session, "после OSM-сбора")

        osm_by_station = {
            r.external_id: r.station_id
            for r in session.query(SourceStationRecord).all()
            if r.source_provider_id == osm_pid
        }
        target_1000004 = osm_by_station.get("node/1000004")
        target_1000002 = osm_by_station.get("node/1000002")
        assert target_1000004 and target_1000002, "OSM-записи не привязались к станциям"

        # Шаг 2: «оператор заполнил CSV» → инжест network_import + дедуп.
        summary = ingest.collect_catalog(REGION, source_codes=["network_import"], trigger="e2e",
                                         adapter_overrides={"network_import": csv_adapter})
        print(f"\nCSV ingest: {summary}")
        stats = dedup.process_pending(region=REGION)
        print(f"dedup #2:   {stats}")
        dump_records(session, "после CSV-импорта и дедупа")

        # Проверки: Роснефть-пара (обе стороны заполнены) — авто-слияние;
        # Лукойл-пара (OSM-сторона полностью пуста) — REVIEW: координаты+
        # нейтральные поля дают максимум 0.75 < 0.85, тихо сливать нельзя —
        # оператор подтверждает слияние в очереди дедупа (R10).
        csv_records = {
            r.external_id: r
            for r in session.query(SourceStationRecord).all()
            if r.source_provider_id == net_pid
        }
        print("\n=== РЕЗУЛЬТАТ ===")
        ok = True

        rec_auto = csv_records.get("Роснефть-1000002")
        if rec_auto and rec_auto.station_id == target_1000002 and rec_auto.dedup_state == "MERGED":
            print(f"  Роснефть-1000002: АВТО-слияние с OSM-станцией {target_1000002} ✓")
        else:
            print(f"  FAIL: Роснефть-1000002 ожидала авто-слияния, получила {rec_auto.dedup_state if rec_auto else 'нет записи'}")
            ok = False

        rec_review = csv_records.get("Лукойл-1000004")
        if rec_review and rec_review.dedup_state == "REVIEW" and rec_review.station_id is None:
            print("  Лукойл-1000004: честно отправлена в REVIEW (OSM-сторона пуста, доказательств < 0.85) ✓")
            # Оператор подтверждает слияние в очереди дедупа: правильная OSM-запись — node/1000004.
            osm_rec = session.query(SourceStationRecord).filter(
                SourceStationRecord.source_provider_id == osm_pid,
                SourceStationRecord.external_id == "node/1000004",
            ).one()
            DedupService(session).admin_merge(osm_rec.id, rec_review.id, actor="e2e-operator")
            session.refresh(rec_review)
            print(f"    подтверждено оператором: station_id={rec_review.station_id}")
        else:
            print(f"  FAIL: Лукойл-1000004 ожидала REVIEW, получила {rec_review.dedup_state if rec_review else 'нет записи'}")
            ok = False

        if rec_review and rec_review.station_id == target_1000004:
            print(f"  Лукойл-1000004: после подтверждения слита с OSM-станцией {target_1000004} ✓")
        else:
            ok = False
            print("  FAIL: подтверждённое слияние не связало запись с OSM-станцией")

        stations_total = len({r.station_id for r in session.query(SourceStationRecord).all() if r.station_id})
        print(f"  станций в мастер-каталоге: {stations_total} (ожидание 4 — без дублей)")
        ok &= stations_total == 4

        print("\nИТОГ:", "СЦЕНАРИЙ ПРОЙДЕН ✓" if ok else "ЕСТЬ РАСХОЖДЕНИЯ ✗")
        return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
