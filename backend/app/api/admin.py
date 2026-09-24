"""Административный API (T05): источники, refresh, merge/split, очередь дедупликации.

Пользователей в приложении нет: раздел открыт тому, кто запустил FuelRadar, и
отделяется от остального API только своим per-IP лимитом (не авторизацией).
Все действия журналируются в admin_action_log (R67) от имени «local». Refresh
ставит задание воркеру (T06) — без синхронного сбора (R83).
"""

from __future__ import annotations

from datetime import date as date_type
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Response, UploadFile
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db.models import (
    AdminActionLog,
    CollectionJob,
    CollectionLog,
    SourceHealth,
    SourceProvider,
    SourceStationRecord,
    Station,
    UserReport,
)
from ..db.session import get_db
from ..dedup import DedupService
from ..normalization.names import normalize_brand
from .deps import LOCAL_ACTOR, admin_rate_limit
from .schemas import AdminMergeBody, DedupQueueAction


class SourceUpdateBody(BaseModel):
    """PATCH источника (M16-админка): какие поля менять — None = не трогать."""

    trust: float | None = None
    status: str | None = None
    min_interval_minutes: int | None = None


class NetworkListsBody(BaseModel):
    """PUT списка URL сетевых списков АЗС: пополняемый перечень через админку."""

    urls: list[str]


# Потолок размера загружаемого CSV обогащения (2 МБ с запасом: 10k строк ~ 1.5 МБ)
_CSV_MAX_BYTES = 2 * 1024 * 1024
router = APIRouter(prefix="/admin", tags=["admin"])


_TARGET_TYPE_BY_ACTION = {"refresh_source": "source"}


def _journal(session: Session, action: str, target_id: str, payload: dict) -> None:
    target_type = _TARGET_TYPE_BY_ACTION.get(action, "station")
    session.add(AdminActionLog(actor=LOCAL_ACTOR, action=action, target_type=target_type, target_id=target_id, payload=payload))


@router.get("/action-log", dependencies=[Depends(admin_rate_limit)])
def action_log(
    action: str | None = None,
    actor: str | None = None,
    date_from: date_type | None = None,
    date_to: date_type | None = None,
    limit: int = 50,
    offset: int = 0,
    session: Session = Depends(get_db),
) -> dict:
    """Журнал административных действий (R67): кто, что и когда менял.

    Append-only: только чтение, без редактирования и удаления. payload включает
    только безопасные данные (email, old→new роль) — секретов и токенов тут нет
    по построению (R68). Фильтры: action, actor (подстрока, без регистра),
    date_from/date_to — включительно, даты интерпретируются в UTC.
    """
    limit = max(1, min(limit, 200))
    query = select(AdminActionLog).order_by(AdminActionLog.id.desc())
    if action:
        query = query.where(AdminActionLog.action == action)
    if actor:
        query = query.where(func.lower(AdminActionLog.actor).like(f"%{actor.lower()}%"))
    if date_from is not None:
        query = query.where(AdminActionLog.created_at >= datetime(date_from.year, date_from.month, date_from.day))
    if date_to is not None:
        end = datetime(date_to.year, date_to.month, date_to.day) + timedelta(days=1)
        query = query.where(AdminActionLog.created_at < end)
    total = session.scalar(select(func.count()).select_from(query.subquery()))
    rows = session.scalars(query.offset(offset).limit(limit)).all()
    return {
        "total": total,
        "items": [
            {
                "id": entry.id,
                "actor": entry.actor,
                "action": entry.action,
                "target_type": entry.target_type,
                "target_id": entry.target_id,
                "payload": entry.payload or {},
                "created_at": entry.created_at,
            }
            for entry in rows
        ],
    }


def _provider_or_404(session: Session, provider_id: int) -> SourceProvider:
    provider = session.get(SourceProvider, provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="Источник не найден")
    return provider


def _source_file_state(code: str) -> dict | None:
    """Файл-вход источника (R58) — только у файловых адаптеров; у сетевых это None.

    Путь разрешает сам адаптер, поэтому админка показывает ровно тот файл, который
    заберёт воркер, а не отдельную копию настройки.
    """
    from ..sources.registry import source_file_state

    return source_file_state(code)


def _import_file_state(session: Session) -> dict | None:
    """Файл, читаемый network_import (R58), и когда источник последний раз его прочитал.

    `last_read_at` — время последнего успешного сбора источника (source_health):
    разница между «файл обновлён» и «файл прочитан» и есть ответ на вопрос, попали
    ли данные уже в каталог.
    """
    state = _source_file_state("network_import")
    if state is None:  # источника нет в реестре — файл не выдумываем
        return None
    provider = session.scalar(select(SourceProvider).where(SourceProvider.code == "network_import"))
    state["provider_id"] = provider.id if provider else None
    health = (
        session.scalar(select(SourceHealth).where(SourceHealth.source_provider_id == provider.id))
        if provider is not None
        else None
    )
    state["last_read_at"] = health.last_success_at if health else None
    return state


@router.get("/sources", dependencies=[Depends(admin_rate_limit)])
def list_sources(session: Session = Depends(get_db)) -> list[dict]:
    """Список источников: статус (ACTIVE/RESEARCH_REQUIRED), health, доверие (R57/R95i).

    Для файловых источников отдаём ещё и `file` (R58): какой именно файл читает
    источник и когда он правился — оператору иначе пришлось бы гадать по `.env`.
    """
    health = {h.source_provider_id: h for h in session.scalars(select(SourceHealth))}
    return [
        {
            "id": p.id,
            "code": p.code,
            "name": p.name,
            "status": p.status,
            "trust": p.trust,
            "capabilities": p.capabilities,
            "attribution": p.attribution,
            "min_interval_minutes": p.min_interval_minutes,
            "file": _source_file_state(p.code),
            "health": {
                "state": health[p.id].health if p.id in health else "UNKNOWN",
                "last_check_at": health[p.id].last_check_at if p.id in health else None,
                "last_success_at": health[p.id].last_success_at if p.id in health else None,
                "consecutive_failures": health[p.id].consecutive_failures if p.id in health else 0,
                "last_error": health[p.id].last_error if p.id in health else "",
            },
        }
        for p in session.scalars(select(SourceProvider).order_by(SourceProvider.code))
    ]


@router.get("/sources/{provider_id}/health", dependencies=[Depends(admin_rate_limit)])
def source_health(provider_id: int, session: Session = Depends(get_db)) -> dict:
    provider = _provider_or_404(session, provider_id)
    health = session.scalar(select(SourceHealth).where(SourceHealth.source_provider_id == provider.id))
    if health is None:
        return {"provider": provider.code, "health": "UNKNOWN", "consecutive_failures": 0, "last_error": ""}
    return {
        "provider": provider.code,
        "health": health.health,
        "last_check_at": health.last_check_at,
        "last_success_at": health.last_success_at,
        "consecutive_failures": health.consecutive_failures,
        "last_error": health.last_error,
    }


@router.post("/sources/{provider_id}/refresh", dependencies=[Depends(admin_rate_limit)])
def refresh_source(provider_id: int, session: Session = Depends(get_db)) -> dict:
    """R83: не собирает синхронно — ставит задание в очередь воркера (T06, приоритет P2)."""
    provider = _provider_or_404(session, provider_id)
    from ..worker import schedule_priority_job

    if provider.status != "ACTIVE":
        raise HTTPException(status_code=409, detail="Источник не активен: требуется исследование")
    job = schedule_priority_job(session, provider.id, priority="P1", trigger="manual")
    _journal(session, "refresh_source", provider.code, {"job_id": job.id})
    session.commit()
    return {"job_id": job.id, "provider": provider.code, "status": job.status, "priority": job.priority}


SOURCE_STATUSES = {"ACTIVE", "RESEARCH_REQUIRED", "NOT_USED"}


@router.patch("/sources/{provider_id}", dependencies=[Depends(admin_rate_limit)])
def update_source(provider_id: int, body: SourceUpdateBody, session: Session = Depends(get_db)) -> dict:
    """ADMIN-управление источником: доверие (trust), статус, интервал сбора.

    Все изменения пишутся одним действием в admin_action_log (R67) со старыми и
    новыми значениями. Деактивация (NOT_USED/RESEARCH_REQUIRED) не трогает данные
    и задания: воркер просто перестаёт опрашивать источник (R84), набор коллекции
    меняется только на новых запусках. Запрос без изменений (все значения равны
    текущим) — no-op без записи в аудит.
    """
    provider = _provider_or_404(session, provider_id)

    if body.trust is not None and not (0.0 <= body.trust <= 1.0):
        raise HTTPException(status_code=422, detail="trust должен быть числом от 0 до 1")
    if body.status is not None and body.status not in SOURCE_STATUSES:
        raise HTTPException(status_code=422, detail="Недопустимый статус источника")
    if body.min_interval_minutes is not None and body.min_interval_minutes <= 0:
        raise HTTPException(status_code=422, detail="Интервал должен быть положительным числом минут")
    if body.trust is None and body.status is None and body.min_interval_minutes is None:
        raise HTTPException(status_code=422, detail="Не передано ни одного поля для изменения")

    changes: dict = {}
    if body.trust is not None and body.trust != provider.trust:
        changes["trust"] = {"from": provider.trust, "to": body.trust}
        provider.trust = body.trust
    if body.status is not None and body.status != provider.status:
        changes["status"] = {"from": provider.status, "to": body.status}
        provider.status = body.status
    if body.min_interval_minutes is not None and body.min_interval_minutes != provider.min_interval_minutes:
        changes["min_interval_minutes"] = {"from": provider.min_interval_minutes, "to": body.min_interval_minutes}
        provider.min_interval_minutes = body.min_interval_minutes

    if not changes:
        return {"id": provider.id, "code": provider.code, "changed": False}

    _journal(session, "source_update", provider.code, changes)
    session.commit()
    return {"id": provider.id, "code": provider.code, "changed": True, "changes": changes}


@router.get("/sources/network-lists", dependencies=[Depends(admin_rate_limit)])
def get_network_lists(session: Session = Depends(get_db)) -> dict:
    """Пополняемый список URL сетевых списков АЗС: БД (админка) поверх .env-дефолта.

    source показывает, откуда берётся действующий список: "db" (переопределён
    через админку) или "env" (дефолт NETWORK_LISTS_URLS из .env).
    """
    from ..sources.network_lists import load_urls, urls_source

    return {"urls": load_urls(session), "source": urls_source(session)}


@router.put("/sources/network-lists", dependencies=[Depends(admin_rate_limit)])
def put_network_lists(body: NetworkListsBody, session: Session = Depends(get_db)) -> dict:
    """Сохранить пополняемый список URL (админка). Пустой список → возврат к .env-дефолту.

    Обновление по запросу: непустой список активирует источник (NOT_USED → ACTIVE)
    и сразу ставит P1-задание сбора каталога — воркер подхватит его на ближайшем
    тике, без правки .env и без кнопки «Обновить сейчас». Синхронной загрузки нет
    (R83): API не дёргает внешние источники. Очистка списка возвращает .env-дефолт
    и НЕ меняет статус источника — выключать надо явно (PATCH /sources/{id}).

    Валидация: только http(s), без дублей (порядок сохранён). Журналируется итоговый
    список (R67); секретов в URL быть не должно — но на случай пары user:pass@ в
    ссылке журнал хранит только хост, сами URL остаются в app_settings.
    """
    from ..sources.network_lists import load_urls, save_urls, urls_source

    cleaned: list[str] = []
    for url in body.urls:
        text = url.strip()
        if not text:
            continue
        if not (text.startswith("http://") or text.startswith("https://")):
            raise HTTPException(status_code=422, detail=f"URL должен начинаться с http(s)://: {text}")
        if text not in cleaned:
            cleaned.append(text)
    before = load_urls(session)
    saved = save_urls(session, cleaned)

    provider = session.scalar(select(SourceProvider).where(SourceProvider.code == "network_lists"))
    activated = False
    job_id: int | None = None
    if provider is not None:
        if saved and provider.status != "ACTIVE":
            provider.status = "ACTIVE"
            activated = True
        if saved and provider.status == "ACTIVE":
            from ..worker import schedule_priority_job

            job = schedule_priority_job(session, provider.id, priority="P1", trigger="manual")
            job_id = job.id
    _journal(
        session,
        "network_lists_update",
        "network_lists",
        {
            "count": len(saved),
            "hosts": [url.split("/")[2] for url in saved if url.count("/") >= 2],
            **({"activated": True} if activated else {}),
            **({"job_id": job_id} if job_id is not None else {}),
        },
    )
    session.commit()
    return {
        "urls": saved,
        "source": urls_source(session),
        "count": len(saved),
        "previous_count": len(before),
        "provider_status": provider.status if provider is not None else None,
        "activated": activated,
        "job_id": job_id,
    }


@router.get("/collection-log", dependencies=[Depends(admin_rate_limit)])
def collection_log(
    provider_id: int | None = None,
    limit: int = 50,
    offset: int = 0,
    session: Session = Depends(get_db),
) -> dict:
    """R58/пользовательский запрос: журнал загрузок каталога/наблюдений —
    и ручных (refresh), и по расписанию воркера (T06), а не только текущий
    снимок health. Не путать с /sources/{id}/health — это история запусков.
    """
    limit = max(1, min(limit, 200))
    query = select(CollectionJob).order_by(CollectionJob.id.desc())
    if provider_id is not None:
        query = query.where(CollectionJob.source_provider_id == provider_id)
    total = session.scalar(select(func.count()).select_from(query.subquery()))
    jobs = session.scalars(query.offset(offset).limit(limit)).all()
    providers = {p.id: p for p in session.scalars(select(SourceProvider))}
    return {
        "total": total,
        "items": [
            {
                "id": j.id,
                "provider_code": providers[j.source_provider_id].code if j.source_provider_id in providers else None,
                "provider_name": providers[j.source_provider_id].name if j.source_provider_id in providers else None,
                "station_id": j.station_id,
                "job_type": j.job_type,
                "trigger": j.trigger,  # schedule | manual | seed
                "priority": j.priority,
                "status": j.status,
                "records_count": j.records_count,
                "error_count": j.error_count,
                "error_message": j.error_message,
                "started_at": j.started_at,
                "finished_at": j.finished_at,
            }
            for j in jobs
        ],
    }


@router.get("/collection-log/{job_id}/details", dependencies=[Depends(admin_rate_limit)])
def collection_log_details(job_id: int, session: Session = Depends(get_db)) -> list[dict]:
    """Построчные сообщения конкретного запуска (collection_logs, R84)."""
    job = session.get(CollectionJob, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Задание не найдено")
    logs = session.scalars(
        select(CollectionLog).where(CollectionLog.job_id == job_id).order_by(CollectionLog.id)
    )
    return [{"level": entry.level, "message": entry.message, "created_at": entry.created_at} for entry in logs]


@router.get("/reports", dependencies=[Depends(admin_rate_limit)])
def list_reports(limit: int = 50, offset: int = 0, session: Session = Depends(get_db)) -> dict:
    """Отчёты с устройств: что и когда сообщили, подтвердил ли GPS.

    Пользователей нет, поэтому список обезличен — видно только факт отчёта
    (станция, GPS-подтверждение, расстояние, время)."""
    limit = max(1, min(limit, 200))
    query = select(UserReport).order_by(UserReport.id.desc())
    total = session.scalar(select(func.count()).select_from(query.subquery()))
    rows = session.scalars(query.offset(offset).limit(limit)).all()
    return {
        "total": total,
        "items": [
            {
                "id": r.id,
                "station_id": r.station_id,
                "gps_confirmed": r.gps_confirmed,
                "distance_to_station_m": r.distance_to_station_m,
                "created_at": r.created_at,
            }
            for r in rows
        ],
    }


def _station_or_404(session: Session, station_id: str) -> Station:
    station = session.get(Station, station_id)
    if station is None:
        raise HTTPException(status_code=404, detail="Станция не найдена")
    return station


@router.post("/stations/{station_id}/merge", dependencies=[Depends(admin_rate_limit)])
def merge_station(station_id: str, body: AdminMergeBody, session: Session = Depends(get_db)) -> dict:
    """Объединить запись (и её станцию, если есть) со станцией {station_id} (R09.1/R10)."""
    _station_or_404(session, station_id)
    service = DedupService(session)
    representative = session.scalar(
        select(SourceStationRecord).where(SourceStationRecord.station_id == station_id).limit(1)
    )
    if representative is None:
        raise HTTPException(status_code=404, detail="У станции нет записей источников для объединения")
    try:
        target = service.admin_merge(representative.id, body.record_id, actor="admin")
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    _journal(session, "merge", target, {"record_id": body.record_id, "into": station_id})
    session.commit()
    return {"station_id": target, "merged_record_id": body.record_id}


@router.post("/stations/{station_id}/split", dependencies=[Depends(admin_rate_limit)])
def split_station(station_id: str, body: AdminMergeBody, session: Session = Depends(get_db)) -> dict:
    """Выделить запись в отдельную станцию (R09.1): прежние внешние ID сохраняются."""
    _station_or_404(session, station_id)
    record = session.get(SourceStationRecord, body.record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Запись источника не найдена")
    if record.station_id != station_id:
        raise HTTPException(status_code=400, detail="Запись не принадлежит этой станции")
    service = DedupService(session)
    new_id = service.admin_split(body.record_id, actor="admin")
    _journal(session, "split", station_id, {"record_id": body.record_id, "new_station_id": new_id})
    session.commit()
    return {"new_station_id": new_id, "record_id": body.record_id}


def _enrichable_candidates(session: Session) -> dict[str, dict]:
    """Общая выборка кандидатов дозаполнения для /catalog-gaps и экспорта CSV.

    source_station_records, привязанные к станции, у которых заполнены поля,
    пустые в мастер-каталоге. Бренд берётся normalize_brand (тот же, что в
    инжесте), чтобы кандидат обещал только то, что реально распознается при
    повторном импорте.
    """
    stations_without_brand = {
        row[0]
        for row in session.execute(select(Station.id).where(Station.brand_id.is_(None))).all()
    }
    stations_without_address = {
        row[0]
        for row in session.execute(select(Station.id).where((Station.address == "") | (Station.address == "?"))).all()
    }

    rows = session.execute(
        select(
            SourceStationRecord,
            Station.canonical_name,
            SourceProvider.code,
            SourceProvider.name,
        )
        .join(Station, SourceStationRecord.station_id == Station.id)
        .join(SourceProvider, SourceStationRecord.source_provider_id == SourceProvider.id)
        .order_by(SourceStationRecord.id)
    ).all()

    enrichable: dict[str, dict] = {}
    for record, canonical, provider_code, provider_name in rows:
        fields = set()
        brand = normalize_brand(record.brand_raw)
        if brand and record.station_id in stations_without_brand:
            fields.add("brand")
        if record.address_raw.strip() and record.station_id in stations_without_address:
            fields.add("address")
        if fields:
            enrichable[record.station_id] = {
                "station_id": record.station_id,
                "station_name": canonical,
                "provider_code": provider_code,
                "provider_name": provider_name,
                "fields": fields,
                # для экспорта CSV: сырые значения источника и внешний id записи
                "record": record,
            }
    return enrichable


@router.get("/catalog-gaps", dependencies=[Depends(admin_rate_limit)])
def catalog_gaps(limit: int = 20, session: Session = Depends(get_db)) -> dict:
    """Покрытие атрибутов мастер-каталога: где пусто и чем можно дозаполнить.

    Читающая сводка для оператора пилота (пост-M16, R58/R94i): сколько станций
    без бренда/телефона/адреса и по каким полям у каждой записи источника
    есть данные, которых в мастере нет. Никаких записей не меняет: обогащение
    выполняется штатным инжестом (импорт CSV / network_lists), а
    слияние — через очередь дедупа. Лимит списка кандидатов: 1–100.
    """
    limit = max(1, min(limit, 100))

    total = session.scalar(select(func.count()).select_from(Station))
    if total == 0:
        return {
            "total": 0,
            "missing": {"brand": 0, "phone": 0, "address": 0, "any": 0},
            "sources": [],
            "candidates": [],
            "import_file": _import_file_state(session),
        }

    def _blank(column) -> int:
        # Пусто = '' (дефолт модели); '?' — известный OSM-заглушечный маркер отсутствия.
        return (
            session.scalar(
                select(func.count())
                .select_from(Station)
                .where((column == "") | (column == "?"))
            )
            or 0
        )

    missing_brand = session.scalar(
        select(func.count()).select_from(Station).where(Station.brand_id.is_(None))
    ) or 0
    missing_phone = _blank(Station.phone)
    missing_address = _blank(Station.address)
    missing_any = session.scalar(
        select(func.count())
        .select_from(Station)
        .where(
            (Station.brand_id.is_(None))
            | (Station.phone == "")
            | (Station.phone == "?")
            | (Station.address == "")
            | (Station.address == "?")
        )
    ) or 0

    enrichable = _enrichable_candidates(session)

    candidates = []
    for item in sorted(enrichable.values(), key=lambda x: (-len(x["fields"]), x["station_id"]))[:limit]:
        candidates.append({k: v for k, v in item.items() if k != "record"} | {"fields": sorted(item["fields"])})

    by_source: dict[str, dict[str, int]] = {}
    for item in enrichable.values():
        agg = by_source.setdefault(item["provider_code"], {"name": item["provider_name"], "stations": 0, "fields": 0})
        agg["stations"] += 1
        agg["fields"] += len(item["fields"])

    return {
        "total": total,
        "missing": {
            "brand": missing_brand,
            "phone": missing_phone,
            "address": missing_address,
            "any": missing_any,
        },
        "sources": [
            {"code": code, **data} for code, data in sorted(by_source.items(), key=lambda kv: -kv[1]["fields"])
        ],
        "candidates": candidates,
        # Кнопка импорта пишет в этот же файл — показываем его прямо на вкладке,
        # иначе «файл обновлён в 14:20, а сбор был утром» выглядит как зависший сбор.
        "import_file": _import_file_state(session),
    }


@router.get("/catalog-gaps/export.csv", dependencies=[Depends(admin_rate_limit)])
def catalog_gaps_export_csv(session: Session = Depends(get_db)) -> Response:
    """Кандидаты дозаполнения в CSV формата krasnodar-unnamed-template.csv.

    Готовый файл для ручного обогащения: колонки — алиасы парсера
    network_import (name, brand, lat, lon, address, phone, ref, city, region),
    плюс osm_url для сверки. brand/address предзаполняются из данных источника
    (то, что кандидат и обещал дозаполнить), остальные колонки пустые — их
    заполняет оператор. ref — внешний id записи источника: по нему и по
    совпадающим координатам дедуп свяжет строку с существующей станцией.
    """
    import csv
    import io

    enrichable = _enrichable_candidates(session)
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(("name", "brand", "lat", "lon", "address", "phone", "ref", "city", "region", "osm_url"))
    for item in sorted(enrichable.values(), key=lambda x: (-len(x["fields"]), x["station_id"])):
        record = item["record"]
        brand = normalize_brand(record.brand_raw)
        ext = (record.external_id or "").strip()
        # node/<id> (OSM) → прямая ссылка на объект; остальное — сам id.
        osm_url = f"https://www.openstreetmap.org/{ext}" if "/" in ext else ""
        writer.writerow(
            (
                item["station_name"] or item["station_id"],
                brand,
                f"{record.latitude:.6f}",
                f"{record.longitude:.6f}",
                record.address_raw.strip(),
                "",
                ext.split("/")[-1] if ext else record.id,
                "",
                "",
                osm_url,
            )
        )

    headers = {"Content-Disposition": 'attachment; filename="catalog-gaps-enrichment-template.csv"'}
    return Response(content=buffer.getvalue(), media_type="text/csv; charset=utf-8", headers=headers)


def _csv_upload_dir() -> Path:
    """Каталог загрузок импорта (создаётся при записи).

    Каталог и имя файла — общий контракт с источником `network_import`: он читает
    <каталог>/<CSV_IMPORT_FILENAME> оттуда же, поэтому api только пишет, а путь
    разрешает сам источник (`app/sources/network_import.py::upload_dir`) — одна
    переменная окружения FUELRADAR_CSV_UPLOAD_DIR на api и worker.
    """
    from ..sources.network_import import upload_dir

    d = upload_dir()
    d.mkdir(parents=True, exist_ok=True)
    return d


@router.post("/catalog-gaps/import-csv", dependencies=[Depends(admin_rate_limit)])
async def import_catalog_csv(file: UploadFile, session: Session = Depends(get_db)) -> dict:
    """Загрузка заполненного CSV обогащения напрямую, без правки .env.

    Файл сохраняется под фиксированным именем в каталог импорта, откуда его сам
    берёт источник `network_import` (отдельного пути к файлу не требуется) —
    сбор проходит штатным инжестом через очередь (R83): создаётся задание
    P1/manual. Валидация — тем же парсером network_import: битый файл
    отклоняется до записи (422).
    """
    from ..sources.network_import import CSV_IMPORT_FILENAME, parse_csv
    from ..worker import rate_limit_floor, schedule_priority_job

    raw = await file.read()
    if len(raw) > _CSV_MAX_BYTES:
        raise HTTPException(status_code=422, detail="Файл больше 2 МБ")
    if not (file.filename or "").lower().endswith(".csv"):
        raise HTTPException(status_code=422, detail="Нужен файл .csv")
    try:
        text = raw.decode("utf-8-sig")
        records = parse_csv(text)
    except (UnicodeDecodeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=f"Файл не разобран: {exc}") from exc
    if not records:
        raise HTTPException(status_code=422, detail="В файле нет строк со станциями")

    path = _csv_upload_dir() / CSV_IMPORT_FILENAME
    path.write_text(text, encoding="utf-8")

    provider = session.scalar(select(SourceProvider).where(SourceProvider.code == "network_import"))
    if provider is None:
        raise HTTPException(status_code=409, detail="Источник network_import не заведён")
    job = schedule_priority_job(session, provider.id, priority="P1", trigger="manual")

    # Сбрасываем backoff источника: оператор принёс свежий файл, и автоматическое
    # расписание повторных попыток (R56) к этой задаче больше не относится.
    # Сам факт сброса остаётся в аудите (backoff_reset), поэтому сведения о сбоях
    # не теряются молча. Потолок частоты (R54) не трогаем — воркер не станет
    # опрашивать источник раньше его rate limit, а если интервал ещё не истёк,
    # задание честно подождёт: фактическое время запуска уходит в next_run_at,
    # чтобы админка не обещала мгновенный результат.
    health = session.scalar(select(SourceHealth).where(SourceHealth.source_provider_id == provider.id))
    backoff_reset = int(health.consecutive_failures or 0) if health else 0
    if health is not None and backoff_reset:
        health.consecutive_failures = 0
    floor = rate_limit_floor(session, provider, apply_backoff=False)
    if floor is not None and floor > (job.next_run_at or floor):
        job.next_run_at = floor
    next_run_at = job.next_run_at.isoformat() if job.next_run_at else None
    _journal(session, "csv_import", path.name, {
        "rows": len(records), "job_id": job.id, "path": str(path),
        "backoff_reset": backoff_reset, "next_run_at": next_run_at,
    })
    session.commit()
    # Состояние файла отдаём сразу после записи: админка показывает фактическое
    # время правки и путь, не дожидаясь перезагрузки вкладки (R58).
    return {"saved": str(path), "rows": len(records), "job_id": job.id,
            "provider": provider.code, "next_run_at": next_run_at,
            "file": _import_file_state(session)}


@router.get("/dedup-queue", dependencies=[Depends(admin_rate_limit)])
def dedup_queue(session: Session = Depends(get_db)) -> list[dict]:
    """Кандидаты «на подтверждение» (R10): запись + предложение + разбор по весам."""
    service = DedupService(session)
    result = []
    for candidate in service.review_candidates():
        provider = session.get(SourceProvider, candidate["source"])
        candidate = dict(candidate)
        candidate["source_name"] = provider.name if provider else None
        result.append(candidate)
    return result


@router.post("/dedup-queue", dependencies=[Depends(admin_rate_limit)])
def dedup_queue_action(body: DedupQueueAction, session: Session = Depends(get_db)) -> dict:
    """Подтвердить слияние (merge) или выделить запись в отдельную станцию (new_station)."""
    service = DedupService(session)
    try:
        if body.action == "merge":
            if body.target_record_id is None:
                raise HTTPException(status_code=422, detail="Для action=merge нужен target_record_id")
            station_id = service.admin_merge(body.target_record_id, body.record_id, actor="admin")
        else:
            station_id = service.admin_assign_new_station(body.record_id, actor="admin")
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    _journal(session, f"dedup_{body.action}", station_id, {"record_id": body.record_id})
    session.commit()
    return {"station_id": station_id, "action": body.action, "record_id": body.record_id}
