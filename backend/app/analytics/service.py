"""Analytics definitions and background computation.

Index assumption (brief supplies examples but no formula): AVAILABLE / definitive
fresh readings (AVAILABLE, LOW_STOCK, UNAVAILABLE). Missing and ambiguous readings
are excluded, with coverage and excluded counts always returned. Empty = null.
Coverage uses the fuel types tracked for each station, not every fuel in the global
dictionary: all tracked readings known = complete, some = partial, none = no data.
Deficit statistics describe individual source observation streams, not inferred
historical consensus. Unknowns and TTL gaps censor outages, never imply recovery.

T15/R79: `deficit_by_region()` regroups the same deficit arithmetic by city/region
instead of brand ("районы дефицита") -- honest on a small pilot catalog, not yet
statistically meaningful until the catalog grows (spec §61), by brief design.
T15/R49: `deficit_statistics(..., now=...)` additionally reports
`current_outage_minutes` for a still-open outage, consumed by `analytics.forecast`
to produce an explainable probability heuristic -- see that module's docstring.
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


def deficit_statistics(
    observations: list[dict[str, Any]], *, now: datetime | None = None,
) -> dict[str, Any]:
    """Count source-reported transitions and completed, continuously observed outages.

    Streams must describe one station/fuel/source. Duplicate readings and repeated
    UNAVAILABLE do not count as new outages. Initial UNAVAILABLE is left censored.

    When `now` is given, also reports `current_outage_minutes` (R49): the elapsed
    time of a still-open outage as of `now`, but only when the last observation's
    TTL still covers `now` (an expired trailing episode is left censored, same as
    any other TTL gap -- we don't claim to know the station is still unavailable).
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
    current_outage_minutes: float | None = None
    if start is not None and now is not None and (expires is None or now <= expires):
        current_outage_minutes = (now - start).total_seconds() / 60
    return {
        "unavailable_transitions": transitions,
        "completed_outages": completed,
        "censored_outages": censored + int(start is not None),
        "duration_minutes": durations,
        "current_outage_minutes": current_outage_minutes,
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
        statistics = deficit_statistics(observations, now=now)
        statistics["total_absence_minutes"] = sum(statistics.pop("duration_minutes"))
        # Границы окна потока — для прогноза R49 (окно наблюдений), не для R47-агрегатов.
        stations[station_id]["deficits"].append({
            "fuel": fuels[fuel_id], "source_id": source_id,
            "first_observed_at": min(row["observed_at"] for row in observations).isoformat(),
            "last_observed_at": max(row["observed_at"] for row in observations).isoformat(),
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


def _within_bbox(row: dict[str, Any], bbox: tuple[float, float, float, float] | None) -> bool:
    return bbox is None or (bbox[0] <= row["longitude"] <= bbox[2]
                           and bbox[1] <= row["latitude"] <= bbox[3])


def _filter_stations(
    payload: dict[str, Any], *, city: str | None = None, region: str | None = None,
    bbox: tuple[float, float, float, float] | None = None,
) -> list[dict[str, Any]]:
    return [row for row in payload["stations"]
            if (not city or row["city"].casefold() == city.casefold())
            and (not region or row["region"].casefold() == region.casefold())
            and _within_bbox(row, bbox)]


def _deficit_group_totals(rows: list[dict[str, Any]]) -> dict[str, Any]:
    completed = sum(row["completed_outages"] for row in rows)
    duration = sum(row["total_absence_minutes"] for row in rows)
    average = round(duration / completed, 2) if completed else None
    return {
        "observed_source_streams": len(rows),
        "unavailable_transitions": sum(row["unavailable_transitions"] for row in rows),
        "completed_outages": completed,
        "censored_outages": sum(row["censored_outages"] for row in rows),
        "mean_absence_minutes": average,
        "mean_recovery_minutes": average,
    }


def heat_cells(
    payload: dict[str, Any], *, fuels: list[str] | None = None,
    city: str | None = None, region: str | None = None,
    bbox: tuple[float, float, float, float] | None = None,
) -> list[dict[str, Any]]:
    """R50: компактные точки heatmap из текущего снэпшота (не сканируем историю).

    Доступность ячейки = доля доступных (AVAILABLE/LOW_STOCK) среди определённых
    (definitive) статусов выбранных топлив; неоднозначные (LIKELY/UNCERTAIN) и
    UNKNOWN не голосуют ни в числителе, ни в знаменателе. Нет определённых
    статусов → ячейка без уровня (null) — фронтенд её не рисует, «нет данных»
    остаётся честным отсутствием, а не серым «покрашенным».
    """
    cells: list[dict[str, Any]] = []
    for station in _filter_stations(payload, city=city, region=region, bbox=bbox):
        statuses = [
            status for fuel, status in station["fuels"].items()
            if fuels is None or fuel in fuels
        ]
        present = sum(status in PRESENT for status in statuses)
        definitive = sum(status in DEFINITIVE for status in statuses)
        cells.append({
            "station_id": station["id"],
            "lat": station["latitude"],
            "lon": station["longitude"],
            "known": definitive,
            "availability": round(present / definitive, 3) if definitive else None,
        })
    return cells


def deficit_by_region(
    payload: dict[str, Any], *, dimension: str = "region",
    city: str | None = None, region: str | None = None,
    bbox: tuple[float, float, float, float] | None = None,
) -> dict[str, Any]:
    """R79: same deficit arithmetic as the per-network view in `summarize()`
    (R47 -- source observation streams, TTL gaps censored not invented), grouped
    by city/region instead of brand, to compare where fuel deficits are more
    frequent or longer-lasting ("районы дефицита").

    Honest limitation (spec §61, brief: "после накопления данных"): on a small
    pilot-scale catalog most groups will hold only one or two stations, so the
    numbers are correct but not yet statistically meaningful -- this is expected,
    not a bug, and improves automatically as the catalog and history grow.
    """
    if dimension not in {"city", "region"}:
        raise ValueError("dimension must be 'city' or 'region'")
    stations = _filter_stations(payload, city=city, region=region, bbox=bbox)
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    station_ids: dict[tuple[str, str], set[str]] = defaultdict(set)
    for station in stations:
        area = station.get(dimension) or "UNKNOWN"
        for row in station["deficits"]:
            key = (area, row["fuel"])
            grouped[key].append(row)
            station_ids[key].add(station["id"])
    items = [
        {dimension: area, "fuel": fuel, "stations_observed": len(station_ids[(area, fuel)]),
         **_deficit_group_totals(rows)}
        for (area, fuel), rows in sorted(grouped.items())
    ]
    return {
        "items": items,
        "dimension": dimension,
        "basis": "source observation streams grouped by city/region instead of network; "
                 "same TTL-censoring semantics as deficit_stats (R47)",
        "note": "small groups on a pilot-scale catalog are honest but not yet "
                "statistically meaningful -- expected per brief §61 until data accumulates",
    }


def summarize(
    payload: dict[str, Any], *, city: str | None = None, region: str | None = None,
    bbox: tuple[float, float, float, float] | None = None,
) -> dict[str, Any]:
    """Filter compact cached station aggregates; never query history from the API."""
    stations = _filter_stations(payload, city=city, region=region, bbox=bbox)
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
                        (not city and not region and row["station_id"] is None and _within_bbox(row, bbox)))]
        source_rows.append({**source, "records_before_dedup": len(records),
                            "unique_stations": len({row["station_id"] for row in records
                                                    if row["station_id"] in ids}),
                            "unlinked_records": sum(row["station_id"] is None for row in records)})
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for station in stations:
        for row in station["deficits"]:
            grouped[(station["brand"], row["fuel"])].append(row)
    deficits = [{"brand": brand, "fuel": fuel, **_deficit_group_totals(rows)}
                for (brand, fuel), rows in sorted(grouped.items())]
    return {
        "coverage": coverage,
        "coverage_by_source": {"sources": source_rows, "unique_stations_after_dedup": total,
                               "city_region_scope": "linked records only"},
        "fuel_index": {"items": indices, "definition": "100 * AVAILABLE / (AVAILABLE + LOW_STOCK + UNAVAILABLE)"},
        "deficit_stats": {"items": deficits, "basis": "source observation streams; unknown/TTL gaps censored"},
    }
