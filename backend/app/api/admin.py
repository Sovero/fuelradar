"""Административный API (T05/M16): источники, refresh, merge/split, очередь дедупликации.

Доступ определяется cookie-сессией и ролью USER/OPERATOR/ADMIN; все действия
журналируются в admin_action_log (R67). Refresh ставит задание воркеру (T06) —
без синхронного сбора (R83).
"""

from __future__ import annotations

import os
from datetime import date as date_type
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Response, UploadFile
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth.service import USER_ROLES
from ..db.models import (
    AdminActionLog,
    CollectionJob,
    CollectionLog,
    SourceHealth,
    SourceProvider,
    SourceStationRecord,
    Station,
    User,
    UserReport,
)
from ..db.session import get_db
from ..dedup import DedupService
from ..normalization.names import normalize_brand
from .deps import require_admin, require_operator
from .schemas import AdminMergeBody, DedupQueueAction


class BlockUserBody(BaseModel):
    blocked: bool = True


class UserRoleBody(BaseModel):
    role: str


class SourceUpdateBody(BaseModel):
    """PATCH источника (M16-админка): какие поля менять — None = не трогать."""

    trust: float | None = None
    status: str | None = None
    min_interval_minutes: int | None = None


# Потолок размера загружаемого CSV обогащения (2 МБ с запасом: 10k строк ~ 1.5 МБ)
_CSV_MAX_BYTES = 2 * 1024 * 1024
router = APIRouter(prefix="/admin", tags=["admin"])


_TARGET_TYPE_BY_ACTION = {"refresh_source": "source", "block_user": "user", "unblock_user": "user"}


def _journal(session: Session, action: str, target_id: str, payload: dict) -> None:
    target_type = _TARGET_TYPE_BY_ACTION.get(action, "station")
    session.add(AdminActionLog(actor="admin", action=action, target_type=target_type, target_id=target_id, payload=payload))


@router.get("/action-log", dependencies=[Depends(require_operator)])
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


@router.get("/users", dependencies=[Depends(require_operator)])
def list_users(limit: int = 50, offset: int = 0, session: Session = Depends(get_db)) -> dict:
    """Список пользователей с ролями (M16): кто чем управляет, кого можно менять/блокировать."""
    limit = max(1, min(limit, 200))
    total = session.scalar(select(func.count()).select_from(User))
    rows = session.scalars(select(User).order_by(User.id).offset(offset).limit(limit)).all()
    return {
        "total": total,
        "items": [
            {
                "id": u.id,
                "display_name": u.display_name or "",
                "email": u.email,
                "telegram_id": u.telegram_id,
                "role": u.role,
                "is_blocked": u.is_blocked,
                "reliability_score": u.reliability_score,
            }
            for u in rows
        ],
    }


@router.post("/users/{user_id}/role", dependencies=[Depends(require_admin)])
def change_user_role(user_id: int, body: UserRoleBody, session: Session = Depends(get_db)) -> dict:
    """Сменить роль (M16 RBAC). Применяется сразу: deps перечитывают пользователя из БД.

    Последнего ADMIN понизить нельзя: bootstrap одноразовый, администратора было бы
    некому вернуть. Так же защищён CLI cli/roles.py.
    """
    role = (body.role or "").strip().upper()
    if role not in USER_ROLES:
        raise HTTPException(status_code=422, detail=f"Роль должна быть одной из {', '.join(sorted(USER_ROLES))}")
    user = session.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    if user.role == role:
        return {"id": user.id, "role": user.role, "changed": False}
    if user.role == "ADMIN" and role != "ADMIN":
        admins = session.scalar(select(func.count()).select_from(User).where(User.role == "ADMIN"))
        if admins <= 1:
            raise HTTPException(
                status_code=409,
                detail="Это последний администратор — понизить нельзя. Сначала назначьте второго ADMIN.",
            )
    old_role = user.role
    user.role = role
    _journal(session, "role_change", str(user_id), {"from": old_role, "to": role, "email": user.email})
    session.commit()
    return {"id": user.id, "role": role, "changed": True, "previous_role": old_role}


@router.get("/sources", dependencies=[Depends(require_operator)])
def list_sources(session: Session = Depends(get_db)) -> list[dict]:
    """Список источников: статус (ACTIVE/RESEARCH_REQUIRED), health, доверие (R57/R95i)."""
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


@router.get("/sources/{provider_id}/health", dependencies=[Depends(require_operator)])
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


@router.post("/sources/{provider_id}/refresh", dependencies=[Depends(require_admin)])
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


@router.patch("/sources/{provider_id}", dependencies=[Depends(require_admin)])
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


@router.get("/collection-log", dependencies=[Depends(require_operator)])
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


@router.get("/collection-log/{job_id}/details", dependencies=[Depends(require_operator)])
def collection_log_details(job_id: int, session: Session = Depends(get_db)) -> list[dict]:
    """Построчные сообщения конкретного запуска (collection_logs, R84)."""
    job = session.get(CollectionJob, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Задание не найдено")
    logs = session.scalars(
        select(CollectionLog).where(CollectionLog.job_id == job_id).order_by(CollectionLog.id)
    )
    return [{"level": entry.level, "message": entry.message, "created_at": entry.created_at} for entry in logs]


@router.get("/reports", dependencies=[Depends(require_operator)])
def list_reports(
    user_id: int | None = None,
    limit: int = 50,
    offset: int = 0,
    session: Session = Depends(get_db),
) -> dict:
    """Отчёты всех пользователей (не только свои, в отличие от `/reports/mine`, T07) —
    иначе администратору неоткуда узнать, кого блокировать (бриф: «блокировать
    недостоверные пользовательские сообщения»)."""
    limit = max(1, min(limit, 200))
    query = select(UserReport).order_by(UserReport.id.desc())
    if user_id is not None:
        query = query.where(UserReport.user_id == user_id)
    total = session.scalar(select(func.count()).select_from(query.subquery()))
    rows = session.scalars(query.offset(offset).limit(limit)).all()
    users = {u.id: u for u in session.scalars(select(User))}
    return {
        "total": total,
        "items": [
            {
                "id": r.id,
                "user_id": r.user_id,
                "user_reliability_score": users[r.user_id].reliability_score if r.user_id in users else None,
                "user_is_blocked": users[r.user_id].is_blocked if r.user_id in users else None,
                "station_id": r.station_id,
                "gps_confirmed": r.gps_confirmed,
                "distance_to_station_m": r.distance_to_station_m,
                "created_at": r.created_at,
            }
            for r in rows
        ],
    }


@router.post("/users/{user_id}/block", dependencies=[Depends(require_admin)])
def block_user(user_id: int, body: BlockUserBody = BlockUserBody(), session: Session = Depends(get_db)) -> dict:
    """R41.1: блокировка недостоверного пользователя — закрывает доступ к новым
    отчётам сразу (`deps.require_user`/`current_active_user`), история остаётся видимой.
    `blocked: false` — снять блокировку (тот же эндпоинт, без отдельного /unblock)."""
    user = session.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    user.is_blocked = body.blocked
    _journal(session, "block_user" if body.blocked else "unblock_user", str(user_id), {"blocked": body.blocked})
    session.commit()
    return {"id": user.id, "is_blocked": user.is_blocked}


def _station_or_404(session: Session, station_id: str) -> Station:
    station = session.get(Station, station_id)
    if station is None:
        raise HTTPException(status_code=404, detail="Станция не найдена")
    return station


@router.post("/stations/{station_id}/merge", dependencies=[Depends(require_admin)])
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


@router.post("/stations/{station_id}/split", dependencies=[Depends(require_admin)])
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


@router.get("/catalog-gaps", dependencies=[Depends(require_operator)])
def catalog_gaps(limit: int = 20, session: Session = Depends(get_db)) -> dict:
    """Покрытие атрибутов мастер-каталога: где пусто и чем можно дозаполнить.

    Читающая сводка для оператора пилота (пост-M16, R58/R94i): сколько станций
    без бренда/телефона/адреса и по каким полям у каждой записи источника
    есть данные, которых в мастере нет. Никаких записей не меняет: обогащение
    выполняется штатным инжестом (NETWORK_IMPORT_PATH / network_lists), а
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
    }


@router.get("/catalog-gaps/export.csv", dependencies=[Depends(require_operator)])
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
    """Каталог загруженных файлов импорта.

    По умолчанию — backend/data/import (рядом с krasnodar-unnamed-template.csv);
    FUELRADAR_CSV_UPLOAD_DIR переопределяет его (docker: общий volume api+worker,
    например /data/import — воркер собирает в отдельном контейнере).
    """
    d = Path(os.environ.get("FUELRADAR_CSV_UPLOAD_DIR") or (Path(__file__).resolve().parents[2] / "data" / "import"))
    d.mkdir(parents=True, exist_ok=True)
    return d


@router.post("/catalog-gaps/import-csv", dependencies=[Depends(require_admin)])
async def import_catalog_csv(file: UploadFile, session: Session = Depends(get_db)) -> dict:
    """Загрузка заполненного CSV обогащения напрямую, без правки .env.

    Файл сохраняется в каталог импорта, settings.network_import_path указывает
    на него и наследуется процессом воркера (same-env) — сбор проходит штатным
    инжестом через очередь (R83): создаётся задание P1/manual. Валидация — тем
    же парсером network_import: битый файл отклоняется до записи (422).
    """
    from ..sources.network_import import parse_csv
    from ..worker import schedule_priority_job

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

    path = _csv_upload_dir() / "catalog-enrichment.csv"
    path.write_text(text, encoding="utf-8")

    provider = session.scalar(select(SourceProvider).where(SourceProvider.code == "network_import"))
    if provider is None:
        raise HTTPException(status_code=409, detail="Источник network_import не заведён")
    job = schedule_priority_job(session, provider.id, priority="P1", trigger="manual")
    _journal(session, "csv_import", path.name, {"rows": len(records), "job_id": job.id, "path": str(path)})
    session.commit()
    return {"saved": str(path), "rows": len(records), "job_id": job.id, "provider": provider.code}


@router.get("/dedup-queue", dependencies=[Depends(require_operator)])
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


@router.post("/dedup-queue", dependencies=[Depends(require_admin)])
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
