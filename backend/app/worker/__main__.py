"""Run the independent APScheduler collector: python -m app.worker."""

import logging

from apscheduler.schedulers.blocking import BlockingScheduler

from cli.regions import resolve_region

from ..core.config import settings
from ..db.session import SessionLocal, init_db
from .service import Worker


def main() -> None:
    """Initialize persistence and coalesce ticks while a collection is running."""
    logging.basicConfig(level=logging.INFO)
    init_db()
    region = resolve_region(default_city=settings.default_region_city,
                            radius_km=settings.default_region_radius_km)
    worker = Worker(SessionLocal, region)
    scheduler = BlockingScheduler(timezone="UTC")
    scheduler.add_job(worker.run_once, "interval", seconds=settings.worker_tick_seconds,
                      id="collection", max_instances=1, coalesce=True, misfire_grace_time=None)
    worker.run_once()
    try:
        scheduler.start()
    except (KeyboardInterrupt, SystemExit):
        scheduler.shutdown(wait=True)


if __name__ == "__main__":
    main()
