"""Внутренний кэш событийного движка (T07).

`AlertStateSnapshot` хранит последнее состояние (station, fuel), которое уже
было оценено правилами — только для diff'а (R35/R37/R38), не публичная история
наблюдений (та живёт в `fuel_observations`/`queue_observations`, R17). Отдельная
таблица, а не поле на `station_current_status`, — чтобы не трогать схему T01/T04
(зона `db` — чужая, контракт `interfaces.md`).
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from ..db.base import Base


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class AlertStateSnapshot(Base):
    __tablename__ = "alert_state_snapshots"
    __table_args__ = (UniqueConstraint("station_id", "fuel_type_id", name="uq_alert_state_snapshot"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    station_id: Mapped[str] = mapped_column(ForeignKey("stations.id"), index=True)
    fuel_type_id: Mapped[int] = mapped_column(ForeignKey("fuel_types.id"))
    status: Mapped[str] = mapped_column(String(32), default="UNKNOWN")
    confidence: Mapped[int] = mapped_column(Integer, default=0)
    queue_level: Mapped[str] = mapped_column(String(16), default="UNKNOWN")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
