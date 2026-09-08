"""Дедупликация мастер-каталога (T03, R02/R09/R10).

Из source_station_records строит stations с собственными ID `fr_station_*` (R07).
Логика:
  - каждая запись сравнивается с уже привязанными к станциям (веса §11);
  - score >= auto_merge → автослияние в ту же станцию (AUTO_MERGE);
  - score >= needs_review → очередь подтверждения администратору (REVIEW);
  - иначе — новая станция (R02: станция существует при подтверждении одним источником);
  - повторный сбор ничего не задваивает: upsert ингеста сохраняет dedup_state,
    здесь обрабатываются только PENDING (идемпотентность по внешнему ID, R09);
  - админ-действия «объединить»/«разделить» пишут dedup_decisions (R10, объяснимость
    и откат: split восстанавливает обе станции с прежними внешними ID).
"""

from __future__ import annotations

import json
import logging
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..core.config import settings
from ..db.models import (
    DedupDecision,
    FuelObservation,
    QueueObservation,
    SourceStationRecord,
    Station,
    StationBrand,
    StationCurrentStatus,
    StationExternalId,
)
from ..normalization import display_name, extract_station_number, normalize_brand
from .compare import (
    MAX_CANDIDATE_DISTANCE_KM,
    CompareInput,
    CompareResult,
    compare_records,
    distance_km,
)

logger = logging.getLogger("fuelradar.dedup")

STATE_PENDING = "PENDING"
STATE_MERGED = "MERGED"
STATE_REVIEW = "REVIEW"
STATE_SPLIT = "SPLIT"


class DedupService:
    """Оркестрация дедупликации. Пороги/веса — из конфигурации (§18, §11)."""

    def __init__(
        self,
        session: Session,
        weights: dict[str, float] | None = None,
        auto_merge: float | None = None,
        needs_review: float | None = None,
    ) -> None:
        self.session = session
        self.weights = weights or dict(settings.dedup_weights)
        self.auto_merge = auto_merge if auto_merge is not None else settings.dedup_auto_merge
        self.needs_review = needs_review if needs_review is not None else settings.dedup_needs_review
        self._brand_cache: dict[str, int | None] = {}

    # ---------- основной проход ----------

    def process_pending(self, region: dict[str, Any] | None = None) -> dict[str, int]:
        """Обрабатывает PENDING-записи. Возвращает сводку {auto_merged, review, created}."""
        pending = list(
            self.session.scalars(
                select(SourceStationRecord)
                .where(SourceStationRecord.dedup_state == STATE_PENDING)
                .order_by(SourceStationRecord.id)
            )
        )
        # кандидаты: уже привязанные к станциям (локальный список пополняется по ходу)
        assigned = list(
            self.session.scalars(
                select(SourceStationRecord).where(SourceStationRecord.station_id.is_not(None))
            )
        )
        summary = {"auto_merged": 0, "review": 0, "created": 0}

        for record in pending:
            best = self._best_match(record, assigned)
            if best is not None and best[0].score >= self.auto_merge:
                self._assign(record, best[1].station_id)
                self._decision("AUTO_MERGE", record, best[1], best[0].score, best[0].components, "system")
                summary["auto_merged"] += 1
                assigned.append(record)
            elif best is not None and best[0].score >= self.needs_review:
                record.dedup_state = STATE_REVIEW
                self._decision("REVIEW", record, best[1], best[0].score, best[0].components, "system")
                summary["review"] += 1
            else:
                station = self._ensure_station(record, region)
                self._assign(record, station.id)
                summary["created"] += 1
                assigned.append(record)
            self.session.flush()

        self.session.commit()
        logger.info("dedup: %s", summary)
        return summary

    def _best_match(
        self, record: SourceStationRecord, assigned: list[SourceStationRecord]
    ) -> tuple[CompareResult, SourceStationRecord] | None:
        """Лучший кандидат среди привязанных записей (в пределах дистанции)."""
        a = self._input(record)
        best: tuple[CompareResult, SourceStationRecord] | None = None
        for other in assigned:
            if other.id == record.id:
                continue
            d = distance_km(a.latitude, a.longitude, other.latitude, other.longitude)
            if d > MAX_CANDIDATE_DISTANCE_KM:
                continue
            result = compare_records(a, self._input(other), self.weights)
            if best is None or result.score > best[0].score:
                best = (result, other)
        return best

    # ---------- создание станции и привязка ----------

    def _ensure_station(self, record: SourceStationRecord, region: dict[str, Any] | None) -> Station:
        brand_id = self._brand_id(record.brand_raw)
        number = extract_station_number(record.name_raw)
        extra = _extra(record)
        station = Station(
            id=self._next_station_id(),
            brand_id=brand_id,
            canonical_name=display_name(record.name_raw, record.brand_raw, number),
            latitude=record.latitude,
            longitude=record.longitude,
            address=record.address_raw,
            city=extra.get("city") or (region or {}).get("city", ""),
            region=(region or {}).get("region", ""),
            country="RU",
            phone=extra.get("phone", ""),
        )
        self.session.add(station)
        self.session.flush()
        return station

    def _brand_id(self, brand_raw: str) -> int | None:
        canonical = normalize_brand(brand_raw)
        if not canonical:
            return None
        if canonical in self._brand_cache:
            return self._brand_cache[canonical]
        brand = self.session.scalar(select(StationBrand).where(StationBrand.name == canonical))
        if brand is None:
            brand = StationBrand(name=canonical, canonical_name=canonical, priority=5)
            self.session.add(brand)
            self.session.flush()
        self._brand_cache[canonical] = brand.id
        return brand.id

    def _assign(self, record: SourceStationRecord, station_id: str) -> None:
        """Привязка записи к станции + внешний ID (R08), обогащение полей станции."""
        record.station_id = station_id
        record.dedup_state = STATE_MERGED
        ext = self.session.scalar(
            select(StationExternalId).where(
                StationExternalId.source_provider_id == record.source_provider_id,
                StationExternalId.external_id == record.external_id,
            )
        )
        if ext is None:
            self.session.add(
                StationExternalId(
                    station_id=station_id,
                    source_provider_id=record.source_provider_id,
                    external_id=record.external_id,
                )
            )
        station = self.session.get(Station, station_id)
        if station is not None:
            self._enrich_station(station, record)

    def _enrich_station(self, station: Station, record: SourceStationRecord) -> None:
        """Лучшие данные источника обогащают станцию (не затирая существующие)."""
        if not station.canonical_name or station.canonical_name == "АЗС":
            number = extract_station_number(record.name_raw)
            station.canonical_name = display_name(record.name_raw, record.brand_raw, number)
        if not station.address and record.address_raw:
            station.address = record.address_raw
        if station.brand_id is None:
            station.brand_id = self._brand_id(record.brand_raw)
        phone = _extra(record).get("phone", "")
        if not station.phone and phone:
            station.phone = phone

    def _next_station_id(self) -> str:
        max_id = self.session.scalar(select(func.max(Station.id)))
        suffix = int(max_id.split("_")[-1]) + 1 if max_id else 1
        return f"fr_station_{suffix:06d}"

    @staticmethod
    def _input(record: SourceStationRecord) -> CompareInput:
        extra = _extra(record)
        return CompareInput(
            latitude=record.latitude,
            longitude=record.longitude,
            brand_raw=record.brand_raw,
            name_raw=record.name_raw,
            address_raw=record.address_raw,
            phone=extra.get("phone", ""),
        )

    # ---------- журнал решений ----------

    def _decision(
        self,
        decision: str,
        left: SourceStationRecord,
        right: SourceStationRecord | None,
        score: float,
        weights: dict[str, float],
        actor: str,
    ) -> None:
        self.session.add(
            DedupDecision(
                decision=decision,
                left_record_id=left.id,
                right_record_id=right.id if right is not None else left.id,
                score=score,
                weights=weights,
                actor=actor,
            )
        )

    # ---------- очередь на подтверждение ----------

    def review_candidates(self) -> list[dict[str, Any]]:
        """Записи в REVIEW с предложением администратору (цель, score, разбор по весам)."""
        reviews = list(
            self.session.scalars(
                select(SourceStationRecord)
                .where(SourceStationRecord.dedup_state == STATE_REVIEW)
                .order_by(SourceStationRecord.id)
            )
        )
        candidates: list[dict[str, Any]] = []
        for record in reviews:
            decision = self.session.scalar(
                select(DedupDecision)
                .where(
                    DedupDecision.left_record_id == record.id,
                    DedupDecision.decision == "REVIEW",
                )
                .order_by(DedupDecision.id.desc())
            )
            target = None
            if decision is not None:
                target = self.session.get(SourceStationRecord, decision.right_record_id)
            candidates.append(
                {
                    "record_id": record.id,
                    "source": record.source_provider_id,
                    "external_id": record.external_id,
                    "brand_raw": record.brand_raw,
                    "name_raw": record.name_raw,
                    "address_raw": record.address_raw,
                    "suggested_record_id": decision.right_record_id if decision else None,
                    "suggested_station_id": target.station_id if target is not None else None,
                    "score": decision.score if decision else None,
                    "weights": decision.weights if decision else None,
                }
            )
        return candidates

    # ---------- админ-действия ----------

    def admin_merge(self, left_record_id: int, right_record_id: int, actor: str = "admin") -> str:
        """Объединить правую запись в станцию левой (R10). Возвращает station_id."""
        left = self.session.get(SourceStationRecord, left_record_id)
        right = self.session.get(SourceStationRecord, right_record_id)
        if left is None or right is None:
            raise ValueError("запись не найдена")

        if left.station_id is None:
            station = self._ensure_station(left, None)
            left.station_id = station.id
            left.dedup_state = STATE_MERGED
            self.session.flush()
        elif right.station_id is not None and right.station_id != left.station_id:
            # обе уже привязаны к разным станциям — сливаем станции целиком
            self._merge_stations(target_id=left.station_id, source_id=right.station_id)

        if right.station_id != left.station_id:
            self._assign(right, left.station_id)

        result = compare_records(self._input(left), self._input(right), self.weights)
        self._decision("MERGE", left, right, result.score, result.components, actor)
        self.session.commit()
        logger.info("admin_merge %s -> %s by %s", right_record_id, left_record_id, actor)
        return left.station_id

    def admin_split(self, record_id: int, actor: str = "admin") -> str:
        """Выделить запись в отдельную станцию (R10): прежние внешние ID сохраняются.

        Ошибочно объединённая запись получает собственную станцию; остальные записи
        остаются на старой. Возвращает station_id новой станции.
        """
        record = self.session.get(SourceStationRecord, record_id)
        if record is None or record.station_id is None:
            raise ValueError("запись не привязана к станции")

        old_station_id = record.station_id
        new_station = self._ensure_station(record, None)
        record.station_id = new_station.id
        record.dedup_state = STATE_MERGED

        # внешние ID записи следуют за ней (R08: восстановление обеих станций)
        for ext in self.session.scalars(
            select(StationExternalId).where(StationExternalId.station_id == old_station_id)
        ):
            if ext.source_provider_id == record.source_provider_id and ext.external_id == record.external_id:
                ext.station_id = new_station.id

        # разбор по весам: с кем запись была объединена раньше
        peer = self.session.scalar(
            select(SourceStationRecord).where(
                SourceStationRecord.station_id == old_station_id,
                SourceStationRecord.id != record.id,
            )
        )
        if peer is not None:
            result = compare_records(self._input(record), self._input(peer), self.weights)
            self._decision("SPLIT", record, peer, result.score, result.components, actor)
        else:
            self._decision("SPLIT", record, record, 0.0, {}, actor)

        self.session.commit()
        logger.info("admin_split %s -> %s by %s", record_id, new_station.id, actor)
        return new_station.id

    def admin_assign_new_station(self, record_id: int, actor: str = "admin") -> str:
        """Отклонение предложения слияния: REVIEW-запись получает собственную станцию."""
        record = self.session.get(SourceStationRecord, record_id)
        if record is None:
            raise ValueError("запись не найдена")
        station = self._ensure_station(record, None)
        self._assign(record, station.id)
        self._decision("SPLIT", record, record, 0.0, {}, actor)
        self.session.commit()
        logger.info("admin_assign_new_station %s -> %s by %s", record_id, station.id, actor)
        return station.id

    def _merge_stations(self, target_id: str, source_id: str) -> None:
        """Слияние двух станций: все записи/наблюдения/внешние ID переезжают в target."""
        for record in self.session.scalars(select(SourceStationRecord).where(SourceStationRecord.station_id == source_id)):
            record.station_id = target_id
        for ext in self.session.scalars(select(StationExternalId).where(StationExternalId.station_id == source_id)):
            ext.station_id = target_id
        for row in self.session.scalars(select(FuelObservation).where(FuelObservation.station_id == source_id)):
            row.station_id = target_id
        for row in self.session.scalars(select(QueueObservation).where(QueueObservation.station_id == source_id)):
            row.station_id = target_id
        for row in self.session.scalars(select(StationCurrentStatus).where(StationCurrentStatus.station_id == source_id)):
            row.station_id = target_id
        station = self.session.get(Station, source_id)
        if station is not None:
            self.session.delete(station)
        self.session.flush()


def _extra(record: SourceStationRecord) -> dict[str, Any]:
    """Структурированные поля записи (phone, city, region…) из payload-json источника.

    SourceStationRecord хранит только raw-поля (R84: сырьё не выбрасывается);
    дополнительные атрибуты SourceRecord.extra попадают в payload как JSON.
    """
    if not record.payload:
        return {}
    try:
        data = json.loads(record.payload)
    except (ValueError, TypeError):
        return {}
    if isinstance(data, dict) and "tags" in data:  # overpass element
        tags = data.get("tags") or {}
        return {
            "phone": tags.get("phone", ""),
            "city": tags.get("addr:city", ""),
            "ref": tags.get("ref", ""),
            "opening_hours": tags.get("opening_hours", ""),
        }
    if isinstance(data, dict):  # строка импорта сетей
        return {k: data.get(k, "") for k in ("phone", "city", "region", "ref")}
    return {}