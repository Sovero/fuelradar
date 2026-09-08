"""Background collection; importing this module never starts a scheduler."""

from .service import Worker, schedule_priority_job

__all__ = ["Worker", "schedule_priority_job"]
