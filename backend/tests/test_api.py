"""Публичный API: контракты, валидация (422 на русском), кэш, админ-операции.

Входа в приложении нет — приложение показывает всё тому, кто его запустил, поэтому
здесь нет ни сессий, ни ролей: только контракты и валидация.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import func, select

from app.confidence import StatusService
from app.core.config import settings
from app.db.models import (
    AdminActionLog,
    CollectionJob,
    CollectionLog,
    SourceHealth,
    SourceProvider,
    SourceStationRecord,
    Station,
    StationBrand,
    UserReport,
)
from app.db.session import SessionLocal, init_db

LAT, LON = 45.0355, 38.9753
S1, S2, S3, S4 = "fr_station_950001", "fr_station_950002", "fr_station_950003", "fr_station_950004"
STATION_FOR_REPORTS = "fr_station_950099"


def _ago(minutes: float) -> datetime:
    return datetime.now(UTC).replace(tzinfo=None) - timedelta(minutes=minutes)


@pytest.fixture(scope="module", autouse=True)
def _data(db_session) -> None:
    """S1 у точки (Лукойл, AVAILABLE ~98), S2 5 км (AVAILABLE 96, очередь LOW), S3 2 км
    (конфликт → LIKELY, очередь HIGH), S4 20 км (вне радиуса по умолчанию)."""
    init_db()
    brand = db_session.scalar(select(StationBrand).where(StationBrand.name == "Лукойл"))
    if brand is None:
        brand = StationBrand(name="Лукойл", canonical_name="Лукойл", priority=1)
        db_session.add(brand)
        db_session.flush()

    specs = {
        S1: (LAT, LON, brand.id),
        S2: (LAT + 0.045, LON, None),
        S3: (LAT + 0.018, LON, None),
        S4: (LAT + 0.18, LON, None),
    }
    for sid, (lat, lon, brand_id) in specs.items():
        if db_session.get(Station, sid) is None:
            db_session.add(Station(id=sid, canonical_name=f"АЗС тест {sid[-2:]}", brand_id=brand_id,
                                   latitude=lat, longitude=lon, city="Краснодар"))
    db_session.commit()

    network = db_session.scalar(select(SourceProvider).where(SourceProvider.code == "network_import"))
    users = db_session.scalar(select(SourceProvider).where(SourceProvider.code == "user_reports"))
    svc = StatusService(db_session)
    # S1: свежее AVAILABLE
    svc.record_fuel_observation(S1, "AI_95", "AVAILABLE", network.id, _ago(5))
    # S2: AVAILABLE 10 мин + очередь LOW 5 машин
    svc.record_fuel_observation(S2, "AI_95", "AVAILABLE", network.id, _ago(10))
    svc.record_queue_observation(S2, "LOW", users.id, 5)
    # S3: конфликт есть/нет → LIKELY_AVAILABLE ~67-48; очередь HIGH без числа
    svc.record_fuel_observation(S3, "AI_95", "AVAILABLE", network.id, _ago(60))
    svc.record_fuel_observation(S3, "AI_95", "UNAVAILABLE", users.id, _ago(55),
          user_reliability=None, gps_confirmed=None)
    svc.record_queue_observation(S3, "HIGH", users.id)
    # S4: только станция, без статусов
    init_db()


# ---------- карта/список: анонимно, со статусами и score (R63/R65) ----------


def test_nearby_anonymous_with_status_and_score(client) -> None:
    """R65: карта анонимна; ответ содержит статусы, score, дистанцию; кэш работает."""
    r1 = client.get(f"/api/v1/stations/nearby?lat={LAT}&lon={LON}&radius_km=6")
    assert r1.status_code == 200
    assert r1.headers["X-Cache"] == "MISS"
    items = r1.json()
    ids = {i["id"] for i in items}
    assert {S1, S2, S3} <= ids and S4 not in ids

    s1 = next(i for i in items if i["id"] == S1)
    assert s1["statuses"][0]["status"] == "AVAILABLE"
    assert s1["statuses"][0]["fuel_code"] == "AI_95"
    assert s1["statuses"][0]["confidence"] >= 90
    assert s1["score"] is not None and 0 <= s1["score"] <= 100
    assert s1["distance_km"] is not None and s1["distance_km"] < 0.1
    assert s1["brand"] == "Лукойл"

    r2 = client.get(f"/api/v1/stations/nearby?lat={LAT}&lon={LON}&radius_km=6")
    assert r2.headers["X-Cache"] == "HIT"


def test_station_list_cache_invalidates_after_new_observation(client, db_session) -> None:
    """R82/§12 №5: новая запись наблюдения не должна ждать истечения TTL кэша."""
    station_id = "fr_station_950098"
    if db_session.get(Station, station_id) is None:
        db_session.add(
            Station(
                id=station_id,
                canonical_name="АЗС тест инвалидации кэша",
                latitude=49.0,
                longitude=45.0,
                city="Кэшоград",
            )
        )
        db_session.commit()

    provider = db_session.scalar(select(SourceProvider).where(SourceProvider.code == "network_import"))
    service = StatusService(db_session)
    service.record_fuel_observation(station_id, "AI_95", "AVAILABLE", provider.id)

    first = client.get("/api/v1/stations", params={"city": "Кэшоград"})
    assert first.headers["X-Cache"] == "MISS"
    assert first.json()[0]["statuses"][0]["status"] == "AVAILABLE"
    assert client.get("/api/v1/stations", params={"city": "Кэшоград"}).headers["X-Cache"] == "HIT"

    service.record_fuel_observation(station_id, "AI_95", "UNAVAILABLE", provider.id)

    refreshed = client.get("/api/v1/stations", params={"city": "Кэшоград"})
    assert refreshed.headers["X-Cache"] == "MISS"
    assert refreshed.json()[0]["statuses"][0]["status"] == "UNAVAILABLE"


def test_filters_and_sort(client) -> None:
    r = client.get(f"/api/v1/stations?lat={LAT}&lon={LON}&status=AVAILABLE&fuel=AI_95")
    ids = {i["id"] for i in r.json()}
    assert S1 in ids and S2 in ids and S3 not in ids  # S3 — LIKELY_AVAILABLE

    r = client.get(f"/api/v1/stations?lat={LAT}&lon={LON}&confidence_min=90")
    ids = {i["id"] for i in r.json()}
    assert S1 in ids and S2 in ids and S3 not in ids

    r = client.get(f"/api/v1/stations?lat={LAT}&lon={LON}&queue_max=LOW")
    ids = {i["id"] for i in r.json()}
    assert S1 in ids and S2 in ids and S3 not in ids  # очередь HIGH > LOW

    r = client.get(f"/api/v1/stations?lat={LAT}&lon={LON}&sort=distance&radius_km=25")
    order = [i["id"] for i in r.json()]
    assert order.index(S1) < order.index(S3) < order.index(S2) < order.index(S4)

    r = client.get(f"/api/v1/stations?lat={LAT}&lon={LON}&radius_km=25&brand=Лукойл")
    assert {i["id"] for i in r.json()} == {S1}

    r = client.get(f"/api/v1/stations?bbox={LAT - 0.1},{LON - 0.1},{LAT + 0.1},{LON + 0.1}")
    assert S4 not in {i["id"] for i in r.json()}  # 20 км — вне bbox


def test_preferred_brands_boosts_user_preferences_score(client, db_session) -> None:
    """R77: личное предпочтение сети поднимает user_preferences в Score для ЭТОГО запроса,
    не меняя общий (station_brands.priority) приоритет сети для остальных пользователей."""
    low_priority_brand = StationBrand(name="Тест-Сеть-Низкий-Приоритет", canonical_name="Тест-Сеть", priority=5)
    db_session.add(low_priority_brand)
    db_session.flush()
    sid = "fr_station_950099"
    db_session.add(Station(id=sid, canonical_name="АЗС тест preferred_brands", brand_id=low_priority_brand.id,
                            latitude=LAT, longitude=LON, city="Краснодар"))
    db_session.commit()

    baseline = client.get(f"/api/v1/stations/{sid}").json()
    assert baseline["score_breakdown"]["user_preferences"]["value"] == pytest.approx(0.5)  # priority=5 -> нейтрально

    boosted = client.get(f"/api/v1/stations/{sid}", params={"preferred_brands": str(low_priority_brand.id)}).json()
    assert boosted["score_breakdown"]["user_preferences"]["value"] == pytest.approx(1.0)  # предпочтено -> максимум
    assert boosted["score"] > baseline["score"]

    # Тот же эффект и в списке (не только в карточке одной станции).
    listed = client.get(
        "/api/v1/stations", params={"lat": LAT, "lon": LON, "radius_km": 1, "preferred_brands": str(low_priority_brand.id)}
    ).json()
    listed_station = next(s for s in listed if s["id"] == sid)
    assert listed_station["score"] > baseline["score"]

    # Общий приоритет сети (для тех, кто её не предпочёл) не изменился.
    db_session.refresh(low_priority_brand)
    assert low_priority_brand.priority == 5


def test_validation_422_russian(client) -> None:
    r = client.get("/api/v1/stations/nearby?lat=95&lon=38")
    assert r.status_code == 422 and "широта" in r.json()["detail"]

    r = client.get("/api/v1/stations/nearby?lat=45&lon=200")
    assert r.status_code == 422 and "долгота" in r.json()["detail"]

    r = client.get("/api/v1/stations?bbox=1,2,3")
    assert r.status_code == 422 and "bbox" in r.json()["detail"]

    r = client.get(f"/api/v1/stations?lat={LAT}&lon={LON}&status=BOGUS")
    assert r.status_code == 422 and "статус" in r.json()["detail"]

    r = client.get(f"/api/v1/stations?lat={LAT}&lon={LON}&fuel=БЕНЗИН-Х")
    assert r.status_code == 422 and "топлив" in r.json()["detail"]

    r = client.get(f"/api/v1/stations?lat={LAT}&lon={LON}&sort=cheese")
    assert r.status_code == 422 and "sort" in r.json()["detail"]


# ---------- карточка и история (R92/R17) ----------


def test_station_detail_explanation(client) -> None:
    r = client.get(f"/api/v1/stations/{S3}?lat={LAT}&lon={LON}")
    assert r.status_code == 200
    body = r.json()
    assert body["statuses"][0]["status"] == "LIKELY_AVAILABLE"
    expl = body["status_explanation"]
    assert expl["contributions"], "разбор вкладов обязателен (R92)"
    sources = {c.get("source") for c in expl["contributions"]}
    assert any(s for s in sources), "у вкладов должны быть названия источников"
    assert any(isinstance(c.get("age_minutes"), int) for c in expl["contributions"])
    assert body["score_breakdown"]["fuel_available"]["value"] > 0
    assert body["eta_minutes"] is not None  # дистанция передана → ETA (R45)
    assert body["queue"]["level"] == "HIGH"

    r = client.get("/api/v1/stations/fr_station_999999")
    assert r.status_code == 404


def test_history(client, db_session) -> None:
    r = client.get(f"/api/v1/stations/{S2}/history?fuel=AI95")
    assert r.status_code == 200
    items = r.json()
    assert len(items) >= 1
    assert items[0]["fuel_code"] == "AI_95"
    assert items[0]["source"] == "Импорт списков сетей (CSV/JSON)"
    dates = [i["observed_at"] for i in items]
    assert dates == sorted(dates, reverse=True)


def test_meta(client) -> None:
    """A02/R98i: справочники и переводы — только здесь."""
    body = client.get("/api/v1/meta").json()
    ai95 = next(f for f in body["fuel_types"] if f["code"] == "AI_95")
    assert ai95["name_ru"] == "АИ-95" and "ЭКТО" in ai95["commercial"]
    statuses = {s["code"]: s["name_ru"] for s in body["fuel_statuses"]}
    assert statuses["AVAILABLE"] == "Есть" and statuses["UNKNOWN"] == "Нет данных"
    queues = {q["code"]: q["name_ru"] for q in body["queue_levels"]}
    assert queues["NONE"] == "Нет" and queues["VERY_HIGH"] == "Очень большая"
    lukoil = next(b for b in body["station_brands"] if b["name"] == "Лукойл")
    assert isinstance(lukoil["id"], int)  # R77: id нужен фронту для preferred_brands
    assert any(s["code"] == "osm_overpass" and "OpenStreetMap" in s["attribution"] for s in body["sources"])
    # Telegram (R64): вход не нужен, канал — подписка на сводку; без токена он выключен.
    assert body["telegram_digest"]["enabled"] is False
    # ETA на линии маршрута: средняя скорость отдаётся из конфига (не дублируется во фронте).
    assert body["avg_speed_kmh"] == settings.avg_speed_kmh


def _add_test_provider(session, code: str) -> SourceProvider:
    """Одноразовый TEST-провайдер для записей этого тест-файла.

    Тесты живут на общей session-scope БД: SourceStationRecord под кодами
    osm_overpass/network_import считаются тестами ingest (upsert-подсчёт),
    поэтому свои записи пишем под уникальный код со статусом TEST — такой
    провайдер не попадает в дефолтный выбор seed/воркера.
    """
    provider = session.scalar(select(SourceProvider).where(SourceProvider.code == code))
    if provider is None:
        provider = SourceProvider(
            code=code,
            name=code,
            capabilities={"discovery": True, "availability": False, "queue": False},
            status="TEST",
        )
        session.add(provider)
        session.flush()
    return provider


# ---------- права: аноним/пользователь/админ (R65/R95i) ----------


def test_personalization_is_open_without_login(client) -> None:
    """Персональных профилей нет: избранное/зоны/правила — общий набор приложения."""
    assert client.get("/api/v1/favorites").status_code == 200
    assert client.get("/api/v1/monitoring-zones").status_code == 200
    assert client.get("/api/v1/alerts").status_code == 200
    assert client.get("/api/v1/push/subscriptions").status_code == 200


def test_admin_endpoints_are_open_for_the_local_operator(client) -> None:
    """Входа нет: админские чтения доступны сразу; статический токен не нужен."""
    r = client.get("/api/v1/admin/sources")
    assert r.status_code == 200
    src = {s["code"]: s for s in r.json()}
    assert src["yandex"]["status"] == "RESEARCH_REQUIRED"
    assert src["osm_overpass"]["attribution"] == "© OpenStreetMap contributors"


def test_admin_refresh_creates_job(client, db_session) -> None:
    """R83: refresh не собирает синхронно — создаёт задание P2/manual для воркера (T06)."""
    provider = db_session.scalar(select(SourceProvider).where(SourceProvider.code == "osm_overpass"))
    r = client.post(f"/api/v1/admin/sources/{provider.id}/refresh")
    assert r.status_code == 200
    job_id = r.json()["job_id"]
    job = db_session.get(CollectionJob, job_id)
    assert job.status == "PENDING" and job.priority == "P1" and job.trigger == "manual"
    log = db_session.scalar(select(AdminActionLog).order_by(AdminActionLog.id.desc()))
    assert log.action == "refresh_source" and log.target_id == "osm_overpass"
    # БД общая на весь прогон тестов (db_session — session-scope): не оставлять
    # задание активным, иначе оно блокирует реальный сбор по этому провайдеру
    # в test_ingest.py через партиционный uq_collection_active.
    job.status = "DONE"
    db_session.commit()


def test_admin_catalog_gaps_reports_missing_fields_and_enrichable(client, db_session) -> None:
    """GET /admin/catalog-gaps: покрытие бренда/телефона/адреса + кандидаты дозаполнения.

    Проверяем и агрегаты, и смысл «откуда дозаполнить»: кандидат появляется
    только когда у source-записи распознаётся бренд (normalize_brand) или есть
    адрес, а в мастер-каталоге это поле пусто.
    """
    assert client.get("/api/v1/admin/catalog-gaps").status_code == 200


    # Специальные станции для сценария: G1 без бренда и адреса, G2 полный.
    # osm-запись кандидата — под одноразовый TEST-провайдер: SourceStationRecord
    # под osm_overpass/network_import утверждается test_ingest (session-scope БД).
    osm_test = _add_test_provider(db_session, "osm_osm_test")
    net = db_session.scalar(select(SourceProvider).where(SourceProvider.code == "network_import"))
    g1, g2 = "fr_station_950011", "fr_station_950012"
    if db_session.get(Station, g1) is None:
        db_session.add(Station(id=g1, canonical_name="АЗС без бренда", latitude=LAT + 0.02,
                               longitude=LON + 0.02, city="Краснодар"))  # brand_id None, address ""
    if db_session.get(Station, g2) is None:
        brand = db_session.scalar(select(StationBrand).where(StationBrand.name == "Лукойл"))
        db_session.add(Station(id=g2, canonical_name="АЗС полная", brand_id=brand.id,
                               latitude=LAT + 0.03, longitude=LON + 0.03, city="Краснодар",
                               address="ул. Полная, 1", phone="+7 861 000-00-00"))
    db_session.commit()

    db_session.add_all([
        # источник знает бренд для безбрендовой G1 → кандидат brand
        SourceStationRecord(source_provider_id=net.id, external_id="gap-1", station_id=g1,
                            latitude=LAT + 0.02, longitude=LON + 0.02,
                            brand_raw="Лукойл", name_raw="", address_raw="", payload="{}"),
        # адрес есть у записи, но G2 уже с адресом → не кандидат.
        # Провайдер — osm_osm_test (одноразовый код TEST-провайдера): тесты живут
        # на общей session-scope БД, и осмысленные записи (SourceStationRecord) под
        # osm_overpass утверждает test_ingest (upsert-подсчёт). Не пересекаться.
        SourceStationRecord(source_provider_id=osm_test.id, external_id="gap-2", station_id=g2,
                            latitude=LAT + 0.03, longitude=LON + 0.03,
                            brand_raw="", name_raw="АЗС полная", address_raw="ул. Полная, 1", payload="{}"),
    ])
    db_session.commit()

    r = client.get("/api/v1/admin/catalog-gaps")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] >= 6
    for key, at_least in (("brand", 1), ("phone", 1), ("address", 1), ("any", 1)):
        assert body["missing"][key] >= at_least, body["missing"]

    cand = {c["station_id"]: c for c in body["candidates"]}
    assert g1 in cand
    assert cand[g1]["fields"] == ["brand"]  # бренд распознаётся normalize_brand
    assert cand[g1]["provider_code"] == "network_import"
    assert "phone" not in cand[g1]["fields"]  # телефон источник не даёт
    assert g2 not in cand  # полная станция — не кандидат

    codes = {s["code"]: s for s in body["sources"]}
    assert codes["network_import"]["stations"] >= 1 and codes["network_import"]["fields"] >= 1

    # limit ограничивает список кандидатов
    assert len(client.get("/api/v1/admin/catalog-gaps?limit=1").json()["candidates"]) == 1


def test_admin_catalog_gaps_export_csv_matches_template_format(client, db_session) -> None:
    """GET /admin/catalog-gaps/export.csv: формат заготовки обогащения.

    CSV обязан читаться продакшен-парсером network_import.parse_csv, колонки
    и семантика ref/osm_url — как в krasnodar-unnamed-template.csv.
    """
    net = db_session.scalar(select(SourceProvider).where(SourceProvider.code == "network_import"))
    g1 = "fr_station_950011"
    if db_session.get(Station, g1) is None:
        db_session.add(Station(id=g1, canonical_name="АЗС без бренда", latitude=LAT + 0.02,
                               longitude=LON + 0.02, city="Краснодар"))
    # запись с OSM-внешним id: даёт и бренд, и osm_url в экспорте
    rec = SourceStationRecord(source_provider_id=net.id, external_id="node/447783364", station_id=g1,
                              latitude=LAT + 0.02, longitude=LON + 0.02,
                              brand_raw="Лукойл", name_raw="", address_raw="ул. Экспортная, 5", payload="{}")
    db_session.add(rec)
    db_session.commit()

    r = client.get("/api/v1/admin/catalog-gaps/export.csv")
    assert r.status_code == 200
    assert "text/csv" in r.headers["content-type"]
    assert "attachment" in r.headers["content-disposition"]

    text = r.content.decode("utf-8")
    import csv as _csv
    import io as _io
    table = list(_csv.reader(_io.StringIO(text)))
    assert table[0] == ["name", "brand", "lat", "lon", "address", "phone", "ref", "city", "region", "osm_url"]
    cells = next(row for row in table[1:] if "447783364" in row)
    assert cells[1] == "Лукойл"  # бренд распознан и предзаполнен
    assert cells[2] == f"{LAT + 0.02:.6f}" and cells[3] == f"{LON + 0.02:.6f}"
    assert cells[4] == "ул. Экспортная, 5"  # запятая внутри значения экранируется csv
    assert cells[6] == "447783364"  # ref = id объекта OSM без префикса node/
    assert cells[9] == "https://www.openstreetmap.org/node/447783364"

    # главный критерий: файл читается тем же парсером, что и реальный импорт
    from app.sources.network_import import parse_csv
    records = parse_csv(text)
    assert any(r_.brand_raw == "Лукойл" and r_.address_raw == "ул. Экспортная, 5" for r_ in records), records

    # Входа нет: выгрузка доступна тому, кто запустил приложение.
    assert client.get("/api/v1/admin/catalog-gaps/export.csv").status_code == 200


def test_admin_catalog_csv_import_saves_and_enqueues(client, db_session, monkeypatch, tmp_path) -> None:
    """POST /admin/catalog-gaps/import-csv: файл сохраняется, джоб P1, аудит; битый CSV → 422."""
    # Каталог загрузки — временный, чтобы тест не трогал реальный data/import
    monkeypatch.setenv("FUELRADAR_CSV_UPLOAD_DIR", str(tmp_path))

    assert client.post("/api/v1/admin/catalog-gaps/import-csv").status_code == 422  # без файла

    # Источник «сбоил»: импорт сбрасывает backoff, а факт сброса остаётся в аудите
    provider_row = db_session.scalar(select(SourceProvider).where(SourceProvider.code == "network_import"))
    health = db_session.scalar(select(SourceHealth).where(SourceHealth.source_provider_id == provider_row.id))
    if health is None:
        health = SourceHealth(source_provider_id=provider_row.id, consecutive_failures=0)
        db_session.add(health)
    health.consecutive_failures = 3
    db_session.commit()

    good = (
        "name,brand,lat,lon,address,phone,ref,city,region\n"
        "АЗС без бренда,Лукойл,45.055500,38.995300,ул. Импортная 1,,447783364,Краснодар,\n"
    )
    r = client.post(
        "/api/v1/admin/catalog-gaps/import-csv",
        files={"file": ("enrichment.csv", good.encode("utf-8"), "text/csv")},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["rows"] == 1 and body["provider"] == "network_import"
    # Ответ сразу сообщает, какой файл записан и когда он обновлён (R58)
    assert body["file"]["path"] == body["saved"] and body["file"]["exists"] is True
    assert body["file"]["size_bytes"] > 0 and body["file"]["modified_at"]
    assert body["file"]["last_read_at"] is None or isinstance(body["file"]["last_read_at"], str)
    # Честное время запуска: потолок частоты источника (R54) соблюдается и после
    # ручного импорта, поэтому админка получает фактическое next_run_at
    assert body["next_run_at"]
    assert Path(body["saved"]).read_text(encoding="utf-8").startswith("name,brand")

    # Контракт «админка пишет — источник читает»: файл лёг ровно туда, откуда его
    # заберёт network_import, и второй переменной для этого не нужно
    monkeypatch.delenv("NETWORK_IMPORT_PATH", raising=False)
    from app.sources.network_import import (
        CSV_IMPORT_FILENAME,
        NetworkImportAdapter,
        import_file_path,
    )

    assert Path(body["saved"]) == tmp_path / CSV_IMPORT_FILENAME
    assert import_file_path() == Path(body["saved"])
    assert NetworkImportAdapter().health_check().health == "ONLINE"

    db_session.refresh(health)
    assert health.consecutive_failures == 0  # backoff сброшен явным импортом

    # задание воркеру создано и завершено (не висит в uq_collection_active)
    job = db_session.get(CollectionJob, body["job_id"])
    assert job is not None and job.status in ("PENDING", "DONE")
    if job.status == "PENDING":
        job.status = "DONE"
        db_session.commit()

    log = db_session.scalar(select(AdminActionLog).order_by(AdminActionLog.id.desc()))
    assert log.action == "csv_import" and log.payload["rows"] == 1
    assert log.payload["backoff_reset"] == 3  # сведения о сбоях не теряются молча

    # битые файлы отклоняются до записи: не-csv, кривая строка, пустой файл
    bad = client.post(
        "/api/v1/admin/catalog-gaps/import-csv",
        files={"file": ("notes.txt", b"hello", "text/plain")},
    )
    assert bad.status_code == 422
    broken = client.post(
        "/api/v1/admin/catalog-gaps/import-csv",
        files={"file": ("bad.csv", "name,brand,lat,lon\nнет координат,Лукойл,,".encode(), "text/csv")},
    )
    assert broken.status_code == 422
    empty = client.post(
        "/api/v1/admin/catalog-gaps/import-csv",
        files={"file": ("empty.csv", b"name,brand,lat,lon\n", "text/csv")},
    )
    assert empty.status_code == 422


def test_admin_shows_file_read_by_network_import(client, db_session, monkeypatch, tmp_path) -> None:
    """R58: админка видит, какой файл читает network_import и когда он обновлялся.

    Это ответ на «данные уже в каталоге?» без лазания в .env: путь тот же, что
    разрешает сам источник, а время правки файла и время последнего успешного
    сбора показывают, когда импорт ещё не забран воркером.
    """
    monkeypatch.delenv("NETWORK_IMPORT_PATH", raising=False)
    monkeypatch.setenv("FUELRADAR_CSV_UPLOAD_DIR", str(tmp_path))

    from app.sources.network_import import CSV_IMPORT_FILENAME

    target = tmp_path / CSV_IMPORT_FILENAME

    # Список источников: у файлового источника есть file, у сетевого — нет
    sources = {s["code"]: s for s in client.get("/api/v1/admin/sources").json()}
    assert sources["network_import"]["file"]["path"] == str(target)
    assert sources["network_import"]["file"]["exists"] is False
    assert sources["osm_overpass"]["file"] is None  # сетевой источник файла не читает

    before = client.get("/api/v1/admin/catalog-gaps").json()["import_file"]
    assert before["name"] == CSV_IMPORT_FILENAME and before["path"] == str(target)
    assert before["exists"] is False and before["modified_at"] is None
    assert before["upload_dir"] == str(tmp_path) and before["explicit"] is False
    assert "last_read_at" in before  # расхождение «файл новее последнего сбора» видно

    good = (
        "name,brand,lat,lon,address,ref,city\n"
        "АЗС файловая,Лукойл,45.0355,38.9753,ул. Файловая 3,447783365,Краснодар\n"
    )
    imported = client.post(
        "/api/v1/admin/catalog-gaps/import-csv",
        files={"file": ("enrichment.csv", good.encode("utf-8"), "text/csv")},
    )
    assert imported.status_code == 200
    body = imported.json()

    after = client.get("/api/v1/admin/catalog-gaps").json()["import_file"]
    assert after["exists"] is True
    # размер — с диска (запись файла — забота API, а не теста)
    assert after["size_bytes"] == Path(after["path"]).stat().st_size > 0
    assert after["modified_at"] and after["modified_at"] != before["modified_at"]
    assert datetime.fromisoformat(after["modified_at"]) >= _ago(1)

    # Именно своё задание доводим до терминального статуса: БД общая на весь прогон,
    # и PENDING-джоба по network_import ломает uq_collection_active у test_seed_cli.
    job = db_session.get(CollectionJob, body["job_id"])
    assert job is not None
    if job.status in ("PENDING", "RUNNING"):
        job.status = "DONE"
        db_session.commit()


def test_admin_network_lists_crud_and_audit(client, db_session) -> None:
    """Пополняемый список URL сетевых списков: БД поверх .env, валидация, аудит.

    Пустой список возвращает .env-дефолт (адаптер никогда не остаётся без URL
    молча), дубли схлопываются, журнал R67 хранит только хосты, не полные URL.
    Сохранение непустого списка — «обновление по запросу»: активирует источник
    (NOT_USED → ACTIVE) и сразу ставит P1-джобу сбора (R83 не нарушен — сбор
    выполняет воркер, не API).
    """
    provider = db_session.scalar(select(SourceProvider).where(SourceProvider.code == "network_lists"))
    original_status = provider.status

    # стартовое состояние: список из .env (в тестовой среде он пуст)
    r = client.get("/api/v1/admin/sources/network-lists")
    assert r.status_code == 200
    initial = r.json()
    assert initial["source"] == "env"

    # сохранение: дубли схлопываются, порядок сохранён; источник активируется,
    # джоба P1 поставлена — сбор начнётся сам на ближайшем тике воркера
    r = client.put("/api/v1/admin/sources/network-lists", json={
        "urls": ["https://a.example.com/azs.json", "https://b.example.com/list.csv", "https://a.example.com/azs.json"],
    })
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "db"
    assert body["urls"] == ["https://a.example.com/azs.json", "https://b.example.com/list.csv"]
    assert body["count"] == 2 and body["previous_count"] == len(initial["urls"])
    assert body["activated"] is True and body["provider_status"] == "ACTIVE"
    assert isinstance(body["job_id"], int)

    db_session.expire_all()
    assert provider.status == "ACTIVE"
    job = db_session.get(CollectionJob, body["job_id"])
    assert job is not None and job.status == "PENDING"
    assert job.priority == "P1" and job.job_type == "catalog" and job.trigger == "manual"
    # джоба доводится до терминального статуса (гигиена session-scope БД)
    job.status = "DONE"
    db_session.commit()

    # в БД записано, адаптер загрузки увидит именно этот список
    from app.sources.network_lists import load_urls, urls_source

    with SessionLocal() as session:
        assert load_urls(session) == body["urls"]
        assert urls_source(session) == "db"

    # аудит: действие есть, полных URL нет (только хосты и количество)
    log = db_session.scalar(select(AdminActionLog).order_by(AdminActionLog.id.desc()))
    assert log.action == "network_lists_update"
    assert log.payload["count"] == 2
    assert log.payload["activated"] is True and log.payload["job_id"] == body["job_id"]
    assert set(log.payload["hosts"]) == {"a.example.com", "b.example.com"}
    assert all("https://" not in str(v) for v in log.payload.values())

    # валидация: не-URL отклоняется, список в БД не портится
    r = client.put("/api/v1/admin/sources/network-lists", json={"urls": ["ftp://nope.example.com"]})
    assert r.status_code == 422
    with SessionLocal() as session:
        assert load_urls(session) == body["urls"]

    # пустой список → возврат к .env-дефолту; статус источника не трогается
    # (выключение — явный PATCH /sources/{id}, не побочный эффект очистки)
    r = client.put("/api/v1/admin/sources/network-lists", json={"urls": []})
    assert r.status_code == 200 and r.json()["source"] == "env"
    assert r.json()["activated"] is False and r.json()["job_id"] is None
    with SessionLocal() as session:
        assert urls_source(session) == "env"

    db_session.expire_all()
    assert provider.status == "ACTIVE"
    # восстановить сид-статус, чтобы не влиять на другие тесты
    provider.status = original_status
    db_session.commit()


def test_admin_updates_source_trust_status_interval(client, db_session) -> None:
    """PATCH /admin/sources/{id}: оператор меняет trust/статус/интервал, всё с аудитом."""
    provider = db_session.scalar(select(SourceProvider).where(SourceProvider.code == "osm_overpass"))
    old_trust = provider.trust
    r = client.patch(f"/api/v1/admin/sources/{provider.id}", json={
        "trust": 0.9, "status": "ACTIVE", "min_interval_minutes": 30,
    })
    assert r.status_code == 200
    assert r.json()["changed"] is True
    db_session.expire_all()
    db_session.refresh(provider)
    assert provider.trust == 0.9 and provider.min_interval_minutes == 30

    log = db_session.scalar(select(AdminActionLog).order_by(AdminActionLog.id.desc()))
    assert log.action == "source_update" and log.target_id == "osm_overpass"
    assert log.payload["trust"]["from"] == old_trust and log.payload["trust"]["to"] == 0.9
    assert log.payload["min_interval_minutes"]["to"] == 30
    # статус не менялся — в payload его нет
    assert "status" not in log.payload

    # no-op: те же значения — changed=False, без записи в аудит
    before = db_session.scalar(select(func.count()).select_from(AdminActionLog))
    r2 = client.patch(f"/api/v1/admin/sources/{provider.id}", json={"trust": 0.9, "min_interval_minutes": 30})
    assert r2.status_code == 200 and r2.json()["changed"] is False
    after = db_session.scalar(select(func.count()).select_from(AdminActionLog))
    assert after == before

    # валидация: недопустимый trust/статус/интервал, пустое тело
    assert client.patch(f"/api/v1/admin/sources/{provider.id}", json={"trust": 1.5}).status_code == 422
    assert client.patch(f"/api/v1/admin/sources/{provider.id}", json={"trust": -0.1}).status_code == 422
    assert client.patch(f"/api/v1/admin/sources/{provider.id}", json={"status": "BROKEN"}).status_code == 422
    assert client.patch(f"/api/v1/admin/sources/{provider.id}", json={"min_interval_minutes": 0}).status_code == 422
    assert client.patch(f"/api/v1/admin/sources/{provider.id}", json={}).status_code == 422
    assert client.patch("/api/v1/admin/sources/999999", json={"trust": 0.5}).status_code == 404


def test_admin_collection_log_lists_jobs_and_details(client, db_session) -> None:
    """Журнал загрузок (не снимок health) — ручные и плановые запуски, с деталями по одному."""
    provider = db_session.scalar(select(SourceProvider).where(SourceProvider.code == "osm_overpass"))
    job = CollectionJob(source_provider_id=provider.id, job_type="catalog", trigger="schedule",
                        priority="P4", status="DONE", records_count=4, error_count=0)
    db_session.add(job)
    db_session.flush()
    db_session.add(CollectionLog(job_id=job.id, source_provider_id=provider.id, level="INFO", message="собрано 4 записи"))
    db_session.commit()

    r = client.get("/api/v1/admin/collection-log", params={"provider_id": provider.id, "limit": 1})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] >= 1
    row = body["items"][0]
    assert row["provider_code"] == "osm_overpass" and row["records_count"] >= 0

    details = client.get(f"/api/v1/admin/collection-log/{job.id}/details")
    assert details.status_code == 200
    assert any("собрано" in entry["message"] for entry in details.json())


def test_admin_lists_reports_without_profiles(client, db_session) -> None:
    """Бриф: отчёты с устройств видны в админке — обезличенно (GPS + расстояние)."""
    db_session.add(UserReport(station_id=STATION_FOR_REPORTS, idempotency_key="admintest-reports-1"))
    db_session.commit()

    r = client.get("/api/v1/admin/reports")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] >= 1
    row = body["items"][0]
    assert set(row) == {"id", "station_id", "gps_confirmed", "distance_to_station_m", "created_at"}


def test_admin_action_log_lists_entries(client, db_session) -> None:
    """Журнал действий (R67): только чтение, с фильтром по action и дате."""
    provider = _add_test_provider(db_session, "audit_log_src")
    db_session.commit()
    # одно реальное действие через API — оно попадёт в журнал
    updated = client.patch(f"/api/v1/admin/sources/{provider.id}", json={"trust": 0.42})
    assert updated.status_code == 200

    r = client.get("/api/v1/admin/action-log", params={"action": "source_update", "limit": 10})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] >= 1
    entry = next(e for e in body["items"] if e["target_id"] == provider.code)
    assert entry["actor"] == "local"
    assert entry["payload"]["trust"]["to"] == 0.42
    assert entry["created_at"] is not None

    # фильтр по несуществующему action — пусто, но 200
    empty = client.get("/api/v1/admin/action-log", params={"action": "no_such_action"}).json()
    assert empty["total"] == 0

    # фильтр по actor — подстрока без регистра (актор один: «local»)
    by_actor = client.get("/api/v1/admin/action-log", params={"actor": "LOC"}).json()
    assert by_actor["total"] >= 1
    assert all(e["actor"].lower().find("loc") != -1 for e in by_actor["items"])
    assert client.get("/api/v1/admin/action-log", params={"actor": "нет-такого-актёра"}).json()["total"] == 0

    # фильтр по датам: интервал, содержащий «сейчас», находит записи; узкий прошлый интервал — пусто
    today = datetime.now(UTC).date().isoformat()
    ranged = client.get("/api/v1/admin/action-log", params={"date_from": today, "date_to": today}).json()
    assert ranged["total"] >= 1
    yesterday = (datetime.now(UTC) - timedelta(days=1)).date().isoformat()
    assert client.get("/api/v1/admin/action-log", params={"date_from": "2020-01-01", "date_to": "2020-01-02"}).json()["total"] == 0
    assert client.get("/api/v1/admin/action-log", params={"date_to": yesterday}).json()["total"] == 0


def test_admin_merge_split_and_queue(client, db_session) -> None:
    """R10/R09.1: очередь дедупликации → подтверждение слияния → разделение."""
    network = db_session.scalar(select(SourceProvider).where(SourceProvider.code == "network_import"))
    from app.dedup import DedupService

    rec_a = SourceStationRecord(source_provider_id=network.id, external_id="t05-a",
                                latitude=46.0, longitude=40.0, brand_raw="Лукойл", name_raw="АЗС Лукойл")
    rec_b = SourceStationRecord(source_provider_id=network.id, external_id="t05-b",
                                latitude=46.0, longitude=40.0, brand_raw="Роснефть", name_raw="АЗС Роснефть")
    db_session.add_all([rec_a, rec_b])
    db_session.commit()
    summary = DedupService(db_session).process_pending()
    assert summary["review"] >= 1

    queue = client.get("/api/v1/admin/dedup-queue").json()
    mine = [c for c in queue if c["external_id"] in ("t05-a", "t05-b")]
    assert mine and mine[0]["suggested_record_id"] is not None and mine[0]["weights"]

    review = next(c for c in mine if c["record_id"] == rec_b.id)
    r = client.post("/api/v1/admin/dedup-queue",
                    json={"record_id": review["record_id"], "action": "merge",
                          "target_record_id": review["suggested_record_id"]})
    assert r.status_code == 200
    station_id = r.json()["station_id"]

    r = client.post(f"/api/v1/admin/stations/{station_id}/split",
                    json={"record_id": rec_b.id})
    assert r.status_code == 200
    assert r.json()["new_station_id"] != station_id

    r = client.post(f"/api/v1/admin/stations/{station_id}/merge",
                    json={"record_id": rec_a.id})
    assert r.status_code in (200, 404)  # 404 допустим, если запись уже переехала при split


def test_rate_limit_429(client) -> None:
    """R66: превышение лимита → 429."""
    from app.api import deps

    original = settings.rate_limit_per_minute
    try:
        deps.reset_rate_limit()
        settings.rate_limit_per_minute = 1
        assert client.get("/api/v1/meta").status_code == 200
        assert client.get("/api/v1/meta").status_code == 429
        assert "запросов" in client.get("/api/v1/meta").json()["detail"]
    finally:
        settings.rate_limit_per_minute = original
        deps.reset_rate_limit()


# ---------- вход и профиль (R06/R65) ----------


def test_cross_origin_mutation_is_denied(client, monkeypatch) -> None:
    """R66: изменяющие запросы с чужого Origin отклоняются (анти-CSRF)."""
    monkeypatch.setattr(settings, "debug", False)
    denied = client.post(
        "/api/v1/monitoring-zones",
        json={"zone_type": "CIRCLE", "params": {"lat": LAT, "lon": LON, "radius_km": 1}},
        headers={"Origin": "https://evil.example"},
    )
    assert denied.status_code == 403


def test_zone_coordinates_and_alert_fuel_roundtrip(client):
    assert client.post('/api/v1/monitoring-zones', json={'zone_type': 'circle', 'params': {'lat': 100, 'lon': 38, 'radius_km': 1}}).status_code == 422
    assert client.post('/api/v1/monitoring-zones', json={'zone_type': 'polygon', 'params': {'points': [[45,38], [46,39], ['bad', 40]]}}).status_code == 422
    rule = client.post('/api/v1/alerts', json={'fuel_code': 'AI_95'}).json()
    assert next(row for row in client.get('/api/v1/alerts').json() if row['id'] == rule['id'])['fuel_code'] == 'AI_95'
    client.put(f"/api/v1/alerts/{rule['id']}", json={'name': 'All fuels'})
    assert next(row for row in client.get('/api/v1/alerts').json() if row['id'] == rule['id'])['fuel_code'] is None


def test_expired_current_status_read_as_unknown(client, db_session):
    from app.db.models import StationCurrentStatus
    row = db_session.scalar(select(StationCurrentStatus).where(StationCurrentStatus.station_id == S1))
    original = row.expires_at
    row.expires_at = _ago(1)
    db_session.commit()
    try:
        response = client.get(f'/api/v1/stations/{S1}/fuel')
        assert response.json()[0]['status'] == 'UNKNOWN'
        assert response.json()[0]['confidence'] == 0
    finally:
        row.expires_at = original
        db_session.commit()
