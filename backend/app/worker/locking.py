"""Process lifetime locks: OS releases these on crashes, without unsafe lease expiry."""

from __future__ import annotations

import os
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import Engine, text

_memory_lock = threading.Lock()


@contextmanager
def worker_lock(engine: Engine) -> Iterator[bool]:
    """Hold a database-wide collector lock across all transaction commits."""
    if engine.dialect.name == "postgresql":
        with engine.connect() as connection:
            acquired = bool(connection.scalar(text("SELECT pg_try_advisory_lock(738204619)")))
            try:
                yield acquired
            finally:
                if acquired:
                    connection.execute(text("SELECT pg_advisory_unlock(738204619)"))
        return
    if engine.dialect.name != "sqlite":
        raise RuntimeError("Worker locks support PostgreSQL and SQLite only")
    database = engine.url.database
    if not database or database == ":memory:":
        acquired = _memory_lock.acquire(blocking=False)
        try:
            yield acquired
        finally:
            if acquired:
                _memory_lock.release()
        return
    path = Path(database).resolve().with_suffix(".worker.lock")
    with path.open("a+b") as handle:
        handle.seek(0, 2)
        if not handle.tell():
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            yield False
            return
        try:
            yield True
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)
