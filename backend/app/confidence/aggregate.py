"""Агрегация наблюдений одного (station, fuel) → статус + confidence (T04, §8).

Модель — взвешенное голосование, а не «последнее сообщение» (R19):
  - вес наблюдения = trust источника × свежесть × (репутация × GPS для отчётов);
  - свежесть f(age) = 1 − 0.5·age/TTL — экспоненциально-линейный спад; наблюдение
    старше TTL исключается (R56: устарело → UNKNOWN, не «нет»);
  - доля лучшего статуса ≥ share_strong → прямой статус; ≥ share_likely и лучший —
    AVAILABLE → LIKELY_AVAILABLE; иначе UNCERTAIN (конфликт §23: 2:1 → 67%);
  - confidence = 100 × доля × средняя свежесть — «0–100%, доверие + давность +
    число источников + конфликт» (R18).

Примеры из брифа: единогласные свежие источники → AVAILABLE ~94–97%;
конфликт A:есть / B:нет / C:есть → LIKELY_AVAILABLE, confidence 67%.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime

from ..fuel_status import (
    AVAILABLE,
    LIKELY_AVAILABLE,
    LOW_STOCK,
    UNCERTAIN,
    UNKNOWN,
    validate_fuel_status,
)


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


@dataclass(frozen=True)
class ObservationInput:
    """Одно наблюдение для агрегации (не БД-строка — тесты без БД)."""

    status: str
    trust: float = 0.5            # source_trust (R18)
    observed_at: datetime | None = None  # факт на АЗС (R16); None → received
    received_at: datetime | None = None
    source_id: int | None = None  # source_provider_id — для разбора вкладов (R71)
    user_reliability: float | None = None  # R41 — только отчёты пользователей
    gps_confirmed: bool | None = None      # R40 — отчёт с места (< 300 м)


@dataclass(frozen=True)
class AggregationConfig:
    """Пороги и множители — конфигурация (§18), дефолты из settings."""

    ttl_minutes: int = 120
    share_strong: float = 0.80
    share_likely: float = 0.60
    min_weight: float = 0.30       # R19.1 — иначе «под вопросом»
    gps_boost: float = 1.20
    gps_penalty: float = 0.60


@dataclass(frozen=True)
class Contribution:
    """Вклад одного наблюдения — экран «почему система так считает» (R18.1/R71)."""

    status: str
    trust: float
    age_minutes: int
    freshness: float
    weight: float
    source_id: int | None = None


@dataclass(frozen=True)
class AggregateResult:
    status: str
    confidence: int                 # 0–100
    share: float                    # доля лучшего статуса 0..1
    total_weight: float
    age_minutes: int | None         # возраст лучшего наблюдения («обновлено N назад»)
    contributions: list[Contribution] = field(default_factory=list)


def freshness(age_minutes: float, ttl_minutes: float) -> float:
    """Свежесть: 1.0 сейчас → 0.5 на TTL; за TTL — 0 (наблюдение исключается)."""
    if age_minutes >= ttl_minutes:
        return 0.0
    if age_minutes <= 0:
        return 1.0
    return 1.0 - 0.5 * age_minutes / ttl_minutes


def _base_weight(obs: ObservationInput, cfg: AggregationConfig) -> float:
    """Вес без свежести: trust × (репутация × GPS для отчётов)."""
    weight = obs.trust
    if obs.user_reliability is not None:
        weight *= max(0.0, min(1.0, obs.user_reliability))
        weight *= cfg.gps_boost if obs.gps_confirmed else cfg.gps_penalty
    return weight


def aggregate(
    observations: list[ObservationInput],
    cfg: AggregationConfig | None = None,
    now: datetime | None = None,
) -> AggregateResult:
    """Взвешенная агрегация наблюдений (station, fuel). Чистая функция, без БД."""
    cfg = cfg or AggregationConfig()
    now = now or _now()

    fresh: list[tuple[ObservationInput, float, float, float]] = []  # obs, f, base, weight
    for obs in observations:
        validate_fuel_status(obs.status)
        at = obs.observed_at or obs.received_at or now
        age = max(0.0, (now - at).total_seconds() / 60.0)
        f = freshness(age, cfg.ttl_minutes)
        if f <= 0.0:
            continue  # протухло — не участвует (R56)
        base = _base_weight(obs, cfg)
        fresh.append((obs, f, base, base * f))

    if not fresh:
        # R03/R15: нет актуальных данных → UNKNOWN, а не «нет топлива»
        return AggregateResult(status=UNKNOWN, confidence=0, share=0.0, total_weight=0.0, age_minutes=None)

    per_status: dict[str, float] = {}
    for obs, _, _, weight in fresh:
        per_status[obs.status] = per_status.get(obs.status, 0.0) + weight
    total = sum(per_status.values())
    best_status = max(per_status, key=per_status.get)
    share = per_status[best_status] / total

    # R19.1: слишком мало подтверждений → «под вопросом», статус не меняется
    if total < cfg.min_weight:
        result_status = UNCERTAIN
    elif share >= cfg.share_strong:
        result_status = best_status
    elif share >= cfg.share_likely and best_status == AVAILABLE:
        result_status = LIKELY_AVAILABLE
    elif share >= cfg.share_likely and best_status == LOW_STOCK:
        result_status = LOW_STOCK
    else:
        result_status = UNCERTAIN

    # средняя свежесть по базовым весам (без повторного учёта f внутри share)
    base_total = sum(base for _, _, base, _ in fresh)
    weighted_freshness = sum(base * f for _, f, base, _ in fresh)
    avg_freshness = weighted_freshness / base_total if base_total else 0.0
    confidence = round(100.0 * share * avg_freshness)
    if result_status == UNCERTAIN:
        # «под вопросом» не бывает почти достоверным (R19.1) — не выше половины
        confidence = min(confidence, 50)

    contributions = sorted(
        (
            Contribution(
                status=obs.status,
                trust=obs.trust,
                age_minutes=round((now - (obs.observed_at or obs.received_at or now)).total_seconds() / 60),
                freshness=round(f, 3),
                weight=round(weight, 3),
                source_id=obs.source_id,
            )
            for obs, f, _, weight in fresh
        ),
        key=lambda c: c.weight,
        reverse=True,
    )

    best_age = None
    if best_status in per_status:
        best_age = min(
            round((now - (obs.observed_at or obs.received_at or now)).total_seconds() / 60)
            for obs, _, _, _ in fresh
            if obs.status == best_status
        )

    return AggregateResult(
        status=result_status,
        confidence=confidence,
        share=round(share, 3),
        total_weight=round(total, 3),
        age_minutes=best_age,
        contributions=contributions,
    )