"""Background collection; importing this module never starts a scheduler."""

from .service import Worker, rate_limit_floor, schedule_priority_job

__all__ = ["Worker", "rate_limit_floor", "schedule_priority_job"]
