"""Заглушка воркера (T01, каркас).

Настоящий планировщик с приоритетами P1–P4, backoff и метриками — таск 06.
Здесь — чтобы docker-compose (R85) поднимался целостно.
"""

import logging
import time

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("fuelradar.worker")

if __name__ == "__main__":
    logger.info("worker stub: планировщик появится в таске 06")
    while True:
        time.sleep(60)