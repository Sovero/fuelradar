"""Газетир регионов для CLI seed (A01).

Данные, а не код: новый регион добавляется строкой в словарь (или передачей
--lat/--lon/--radius), архитектура не меняется (R04/R81).
"""

from __future__ import annotations

# имя (ключ) -> центр региона. Координаты примерные, уточняются администратором.
REGIONS: dict[str, dict] = {
    "krasnodar": {"city": "Краснодар", "lat": 45.0355, "lon": 38.9753, "radius_km": 10.0},
    "krasnodar-south": {"city": "Краснодар (юг)", "lat": 45.0000, "lon": 38.9753, "radius_km": 10.0},
    "sochi": {"city": "Сочи", "lat": 43.5855, "lon": 39.7231, "radius_km": 10.0},
    "novorossiysk": {"city": "Новороссийск", "lat": 44.7235, "lon": 37.7687, "radius_km": 10.0},
}


def resolve_region(
    region_name: str | None = None,
    *,
    lat: float | None = None,
    lon: float | None = None,
    radius_km: float | None = None,
    default_city: str = "",
) -> dict:
    """Регион из газетира или явных координат. Кидает ValueError, если нечего взять."""
    if lat is not None and lon is not None:
        return {
            "city": default_city or "произвольная точка",
            "lat": lat,
            "lon": lon,
            "radius_km": radius_km or 10.0,
        }
    key = (region_name or "").strip().lower()
    if key in REGIONS:
        region = dict(REGIONS[key])
        if radius_km is not None:
            region["radius_km"] = radius_km
        return region
    if default_city:
        match = next((r for name, r in REGIONS.items() if r["city"].lower() == default_city.lower()), None)
        if match:
            return dict(match)
    raise ValueError(
        "не указан регион: передайте --region (из gazetteer) или --lat/--lon [--radius-km]"
    )