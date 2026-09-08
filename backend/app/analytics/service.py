"""Analytics definitions and background computation.

Index assumption (brief supplies examples but no formula): AVAILABLE / definitive
fresh readings (AVAILABLE, LOW_STOCK, UNAVAILABLE). Missing and ambiguous readings
are excluded, with coverage and excluded counts always returned. Empty = null.
Coverage uses the fuel types tracked for each station, not every fuel in the global
dictionary: all tracked readings known = complete, some = partial, none = no data.
Deficit statistics describe individual source observation streams, not inferred
historical consensus. Unknowns and TTL gaps censor outages, never imply recovery.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db.models import (
    FuelObservation,
    FuelType,
    SourceProvider,
    SourceStationRecord,
    Station,
    StationBrand,
    StationCurrentStatus,
)
from .models import AnalyticsSnapshot

DEFINITIVE = {"AVAILABLE", "LOW_STOCK", "UNAVAILABLE"}
PRESENT = {"AVAILABLE", "LOW_STOCK"}


def deficit_statistics(observations: list[dict[str, Any]]) -> dict[str, Any]:
    """Count source-reported transitions and completed, continuously observed outages.

    Streams must describe one station/fuel/source. Duplicate readings and repeated
    UNAVAILABLE do not count as new outages. Initial UNAVAILABLE is left censored.
    """
    ordered = sorted(observations, key=lambda item: item["observed_at"])
    previous: str | None = None
    expires: datetime | None = None
    start: datetime | None = None
    transitions = completed = censored = 0
    durations: list[float] = []
    for row in ordered:
        at, status = row["observed_at"], row["status"]
        if expires is not None and at > expires:
            censored += int(start is not None)
            previous, start = None, None
        if status not in DEFINITIVE:
            censored += int(start is not None)
            previous, start = None, None
        else:
            if status == "UNAVAILABLE" and previous in PRESENT:
                transitions += 1
                start = at
            elif status in PRESENT and start is not None:
                durations.append((at - start).total_seconds() / 60)
                completed += 1
                start = None
            previous = status
        expires = row["expires_at"]
    return {
        "unavailable_transitions": transitions,
        "completed_outages": completed,
        "censored_outages": censored + int(start is not None),
        "duration_minutes": durations,
    }


def refresh_analytics(db: Session, *, now: datetime | None = None) -> dict[str, Any]:
    """Compute a durable snapshot in the worker transaction; caller commits."""
    now = now or datetime.now(UTC).replace(tzinfo=None)
    if now.tzinfo is not None:
        now = now.astimezone(UTC).replace(tzinfo=None)
    fuels = {row.id: row.code for row in db.scalars(select(FuelType))}
    brands = {row.id: row.name for row in db.scalars(select(StationBrand))}
    stations: dict[str, dict[str, Any]] = {
        row.id: {
            "id": row.id, "city": row.city, "region": row.region,
            "latitude": row.latitude, "longitude": row.longitude,
            "brand": brands.get(row.brand_id, "UNKNOWN"), "fuels": {}, "deficits": [],
        }
        for row in db.scalars(select(Station).where(Station.is_active.is_(True)))
    }
    for row in db.scalars(select(StationCurrentStatus)):
        if row.station_id in stations and fuels[row.fuel_type_id] not in {"UNKNOWN", "OTHER"}:
            stations[row.station_id]["fuels"][fuels[row.fuel_type_id]] = (
                row.status if row.expires_at > now else "UNKNOWN"
            )
    streams: dict[tuple[str, int, int], list[dict[str, Any]]] = defaultdict(list)
    for row in db.scalars(select(FuelObservation).where(FuelObservation.observed_at <= now)):
        if row.station_id in stations:
            streams[(row.station_id, row.fuel_type_id, row.source_provider_id)].append({
                "status": row.status, "observed_at": row.observed_at,
                "expires_at": row.expires_at,
            })
    for (station_id, fuel_id, source_id), observations in streams.items():
        statistics = deficit_statistics(observations)
        statistics["total_absence_minutes"] = sum(statistics.pop("duration_minutes"))
        stations[station_id]["deficits"].append({
            "fuel": fuels[fuel_id], "source_id": source_id,
            **statistics,
        })
    providers = {row.id: {"code": row.code, "name": row.name}
                 for row in db.scalars(select(SourceProvider))}
    # Count distinct external records, not repeated collection history rows.
    records = {
        (row.source_provider_id, row.external_id): {
            "source_id": row.source_provider_id, "external_id": row.external_id,
            "station_id": row.station_id, "latitude": row.latitude, "longitude": row.longitude,
        }
        for row in db.scalars(select(SourceStationRecord).order_by(SourceStationRecord.id))
    }
    payload = {
        "stations": list(stations.values()), "sources": list(providers.values()),
        "source_records": [{**row, **providers[row["source_id"]]} for row in records.values()],
        "fuel_types": [code for code in fuels.values() if code not in {"UNKNOWN", "OTHER"}],
    }
    snapshot = db.get(AnalyticsSnapshot, 1)
    if snapshot is None:
        db.add(AnalyticsSnapshot(id=1, computed_at=now, payload=payload))
    else:
        snapshot.computed_at, snapshot.payload = now, payload
    db.flush()
    return {"computed_at": now.isoformat(), **summarize(payload)}


def summarize(
    payload: dict[str, Any], *, city: str | None = None, region: str | None = None,
    bbox: tuple[float, float, float, float] | None = None,
) -> dict[str, Any]:
    """Filter compact cached station aggregates; never query history from the API."""
    def inside(row: dict[str, Any]) -> bool:
        return bbox is None or (bbox[0] <= row["longitude"] <= bbox[2]
                               and bbox[1] <= row["latitude"] <= bbox[3])

    stations = [row for row in payload["stations"]
                if (not city or row["city"].casefold() == city.casefold())
                and (not region or row["region"].casefold() == region.casefold()) and inside(row)]
    ids = {row["id"] for row in stations}
    complete = partial = 0
    for row in stations:
        states = list(row["fuels"].values())
        known = sum(state != "UNKNOWN" for state in states)
        complete += int(bool(states) and known == len(states))
        partial += int(0 < known < len(states))
    total = len(stations)
    coverage = {
        "stations_discovered": total, "with_fuel_data": complete,
        "partial_data": partial, "no_data": total - complete - partial,
        "coverage_percent": round(100 * (complete + partial) / total, 2) if total else None,
        "definition": "known readings among each station's tracked fuel types",
    }
    indices = []
    for fuel in payload["fuel_types"]:
        statuses = [station["fuels"].get(fuel, "UNKNOWN") for station in stations]
        known = sum(status in DEFINITIVE for status in statuses)
        available = statuses.count("AVAILABLE")
        indices.append({
            "fuel": fuel, "index": round(100 * available / known, 2) if known else None,
            "available": available, "denominator": known, "stations_total": total,
            "excluded_unknown": statuses.count("UNKNOWN"),
            "excluded_ambiguous": sum(status in {"UNCERTAIN", "LIKELY_AVAILABLE"} for status in statuses),
            "coverage_percent": round(100 * known / total, 2) if total else None,
        })
    source_rows = []
    for source in payload["sources"]:
        records = [row for row in payload["source_records"] if row["code"] == source["code"]
                   and (row["station_id"] in ids or
                        (not city and not region and row["station_id"] is None and inside(row)))]
        source_rows.append({**source, "records_before_dedup": len(records),
                            "unique_stations": len({row["station_id"] for row in records
                                                    if row["station_id"] in ids}),
                            "unlinked_records": sum(row["station_id"] is None for row in records)})
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for station in stations:
        for row in station["deficits"]:
            grouped[(station["brand"], row["fuel"])].append(row)
    deficits = []
    for (brand, fuel), rows in sorted(grouped.items()):
        completed = sum(row["completed_outages"] for row in rows)
        duration = sum(row["total_absence_minutes"] for row in rows)
        average = round(duration / completed, 2) if completed else None
        deficits.append({
            "brand": brand, "fuel": fuel,
            "observed_source_streams": len(rows),
            "unavailable_transitions": sum(row["unavailable_transitions"] for row in rows),
            "completed_outages": completed,
            "censored_outages": sum(row["censored_outages"] for row in rows),
            "mean_absence_minutes": average,
            "mean_recovery_minutes": average,
        })
    return {
        "coverage": coverage,
        "coverage_by_source": {"sources": source_rows, "unique_stations_after_dedup": total,
                               "city_region_scope": "linked records only"},
        "fuel_index": {"items": indices, "definition": "100 * AVAILABLE / (AVAILABLE + LOW_STOCK + UNAVAILABLE)"},
        "deficit_stats": {"items": deficits, "basis": "source observation streams; unknown/TTL gaps censored"},
    }
