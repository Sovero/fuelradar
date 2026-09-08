"""Durable cache shared by independently running API and scheduler processes."""

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, DateTime
from sqlalchemy.orm import Mapped, mapped_column

from ..db.base import Base


class AnalyticsSnapshot(Base):
    """Atomically replaced background analytics snapshot; never raw observation history."""

    __tablename__ = "analytics_snapshots"

    id: Mapped[int] = mapped_column(primary_key=True)
    computed_at: Mapped[datetime] = mapped_column(DateTime)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
