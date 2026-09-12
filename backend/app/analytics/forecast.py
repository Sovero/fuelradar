"""Прогноз доступности топлива (R49, §23): прозрачная эвристика по истории.

Манифест R49 (ASSUMPTION): реализуется как эвристика над историей дефицита
(R47-агрегаты), не ML — «чёрный ящик» чужд духу R42. Читает только фоновый
`AnalyticsSnapshot` (spec §23: HTTP-эндпоинт не сканирует историю на запросе).

Два честных режима:
- топливо сейчас недоступно (живой эпизод дефицита) → «появление»: вероятность
  восстановления = доля завершённых эпизодов среди всех начавшихся
  (censored-эпизоды считаются неопределённостью), ETA = остаток типичной
  длительности дефицита;
- топливо доступно → «исчезновение»: риск за окно прогноза по Пуассону из
  частоты начал эпизодов за окно наблюдений; время до исчезновения честно не
  оценивается (история восстановлений не знает расписания новых дефицитов).

Недостаток данных (R49.2): вероятность/ETA = null + русская причина.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime
from typing import Any

from ..core.config import settings

DEFINITIVE = {"AVAILABLE", "LOW_STOCK", "UNAVAILABLE"}
PRESENT = {"AVAILABLE", "LOW_STOCK"}


def forecast_for_station(
    payload: dict[str, Any],
    station_id: str,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Прогноз по станции из снэпшота; станции нет в снэпшоте → честный no_data."""
    now = now or datetime.now(UTC).replace(tzinfo=None)
    station = next((row for row in payload["stations"] if row["id"] == station_id), None)
    if station is None:
        return {
            "is_forecast": True,
            "method": "эвристика по истории дефицита (R47-агрегаты, не ML)",
            "horizon_minutes": settings.forecast_horizon_minutes,
            "direction": None,
            "probability": None,
            "eta_minutes": None,
            "completed_episodes": 0,
            "current_outage_minutes": None,
            "sufficiency": "no_data",
            "reason": "Станция ещё не попала в аналитический снэпшот — появится после фонового пересчёта",
            "sample": {"streams": 0, "episodes": 0, "completed": 0, "censored": 0,
                       "window_minutes": None, "mean_absence_minutes": None},
        }

    # Снэпшот, посчитанный кодом до T12, не содержит deficits — даём честный
    # no_data вместо KeyError/500 до первого фонового пересчёта.
    streams = station.get("deficits", [])
    method = ("эвристика по истории дефицита (R47-агрегаты, не ML): "
              "восстановление — доля завершённых эпизодов; исчезновение — "
              "Пуассон-риск по частоте эпизодов за окно наблюдений")
    base = {
        "is_forecast": True,
        "method": method,
        "horizon_minutes": settings.forecast_horizon_minutes,
        "completed_episodes": 0,
        "current_outage_minutes": None,
        "sample": {"streams": 0, "episodes": 0, "completed": 0, "censored": 0,
                   "window_minutes": None, "mean_absence_minutes": None},
    }

    if not streams:
        return {
            **base,
            "direction": None,
            "probability": None,
            "eta_minutes": None,
            "sufficiency": "no_data",
            "reason": "Наблюдений по станции нет — прогнозу не на чем основываться",
        }

    episodes = sum(row["unavailable_transitions"] for row in streams)
    completed = sum(row["completed_outages"] for row in streams)
    censored = sum(row["censored_outages"] for row in streams)
    total_absence = sum(row["total_absence_minutes"] for row in streams)
    mean_absence = round(total_absence / completed, 1) if completed else None
    current = max((row["current_outage_minutes"] for row in streams
                   if row.get("current_outage_minutes") is not None), default=None)
    window = _window_minutes(streams)

    base["completed_episodes"] = completed
    base["current_outage_minutes"] = round(current, 1) if current is not None else None
    base["sample"] = {"streams": len(streams), "episodes": episodes, "completed": completed,
                      "censored": censored, "window_minutes": window,
                      "mean_absence_minutes": mean_absence}

    if len(streams) < settings.forecast_min_streams:
        return {
            **base,
            "direction": None,
            "probability": None,
            "eta_minutes": None,
            "sufficiency": "insufficient",
            "reason": (f"Слишком мало потоков наблюдений: {len(streams)} "
                       f"(нужно не меньше {settings.forecast_min_streams})"),
        }

    if current is not None:
        # Топливо сейчас нет (по крайней мере по одному потоку) → прогноз появления.
        if completed >= settings.forecast_min_episodes and mean_absence is not None:
            probability = round(100 * completed / (completed + censored)) if completed + censored else None
            eta = round(max(mean_absence - current, 0))
            return {
                **base,
                "direction": "appearing",
                "probability": probability,
                "eta_minutes": eta,
                "sufficiency": "ok",
                "reason": None,
            }
        return {
            **base,
            "direction": "appearing",
            "probability": None,
            "eta_minutes": None,
            "sufficiency": "insufficient",
            "reason": (f"Мало завершённых эпизодов дефицита: {completed} "
                       f"(нужно не меньше {settings.forecast_min_episodes})"),
        }

    # Топливо доступно → риск исчезновения за окно прогноза.
    if window is None or window < settings.forecast_horizon_minutes:
        return {
            **base,
            "direction": "disappearing",
            "probability": None,
            "eta_minutes": None,
            "sufficiency": "insufficient",
            "reason": (f"История наблюдений короче горизонта прогноза: "
                       f"{window if window is not None else 0} мин из "
                       f"{settings.forecast_horizon_minutes} мин"),
        }
    if episodes < settings.forecast_min_episodes:
        return {
            **base,
            "direction": "disappearing",
            "probability": None,
            "eta_minutes": None,
            "sufficiency": "insufficient",
            "reason": (f"Мало эпизодов дефицита за историю: {episodes} "
                       f"(нужно не меньше {settings.forecast_min_episodes})"),
        }
    hours = window / 60.0
    rate = episodes / hours  # λ — эпизодов в час (Пуассон)
    horizon_hours = settings.forecast_horizon_minutes / 60.0
    probability = round(min(100.0, 100.0 * (1.0 - math.exp(-rate * horizon_hours))))
    return {
        **base,
        "direction": "disappearing",
        "probability": probability,
        "eta_minutes": None,
        "sufficiency": "ok",
        "reason": ("Время до исчезновения не оценивается — по истории восстановлений "
                   "предсказуем только риск за окно прогноза"),
    }


def _window_minutes(streams: list[dict[str, Any]]) -> int | None:
    """Объединённое окно наблюдений станции: max(last) − min(first), минуты."""
    spans: list[tuple[datetime, datetime]] = []
    for row in streams:
        first, last = row.get("first_observed_at"), row.get("last_observed_at")
        if first and last:
            spans.append((datetime.fromisoformat(first), datetime.fromisoformat(last)))
    if not spans:
        return None
    return round((max(last for _, last in spans) - min(first for first, _ in spans)).total_seconds() / 60)
