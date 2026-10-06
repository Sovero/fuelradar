def test_health_ok(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["uptime_seconds"] >= 0


def test_ready_ok_with_db(client):
    """БД отвечает — /ready отдаёт db=ok и честный сигнал о сборе рядом.

    Сам статус может быть `degraded` — это зависит от состояния сбора в общей
    тестовой БД, и он не должен вводить в заблуждение: `db` и `collection`
    проверяются отдельно (R58: статус процесса и свежесть данных — разные вещи).
    """
    resp = client.get("/ready")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] in {"ready", "degraded"}
    assert body["db"] == "ok"
    collection = body["collection"]
    assert collection["state"] in {"ok", "disabled", "overdue", "stalled", "unplanned", "unknown"}
    assert collection["warning"] == (collection["state"] != "ok")
    if collection["warning"]:
        assert body["status"] == "degraded"
    else:
        assert body["status"] == "ready"


def test_ready_degraded_when_collection_warns(client, monkeypatch):
    """Простой сбора виден в /ready (R58): процесс жив, но данные не обновляются."""
    from app import main as app_main

    monkeypatch.setattr(
        app_main,
        "collection_report",
        lambda session: {"state": "stalled", "warning": True, "reason": "no_success", "mode": "external"},
    )
    body = client.get("/ready").json()
    assert body["status"] == "degraded"
    assert body["db"] == "ok"
    assert body["collection"]["reason"] == "no_success"


def test_ready_not_ready_and_unknown_collection_when_db_is_down(client, monkeypatch):
    """БД упала: not_ready и честное unknown вместо выдуманного сигнала."""
    from app import main as app_main

    class _BrokenSession:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def execute(self, *args, **kwargs):
            raise RuntimeError("db down")

    monkeypatch.setattr(app_main, "SessionLocal", lambda: _BrokenSession())
    monkeypatch.setattr(
        app_main,
        "collection_report",
        lambda session: {"state": "ok", "warning": False, "reason": None, "mode": "external"},
    )
    body = client.get("/ready").json()
    assert body["status"] == "not_ready"
    assert body["db"] == "error"
    # Сигнал о сборе не вычислялся (БД недоступна) — это состояние `unknown`, а не «всё хорошо».
    assert body["collection"] == {"state": "unknown", "warning": False, "reason": None, "mode": None}


def test_metrics_endpoint(client):
    resp = client.get("/metrics")
    assert resp.status_code == 200
    assert isinstance(resp.json(), dict)


def test_metrics_inc_and_snapshot():
    from app.core.metrics import inc, snapshot

    inc("tests.requests", 2)
    assert snapshot().get("tests.requests") == 2


class _FakeRedis:
    """Заглушка redis-клиента — без реального сервера (in-memory хэш)."""

    def __init__(self):
        self.hash: dict[str, str] = {}

    def ping(self):
        return True

    def hincrby(self, key, field, by):
        self.hash[field] = str(int(self.hash.get(field, "0")) + by)

    def hset(self, key, field, value):
        self.hash[field] = str(value)

    def hgetall(self, key):
        return dict(self.hash)


def test_metrics_uses_redis_when_configured(monkeypatch):
    """R70: два процесса (api/worker) видят общие счётчики через Redis, если он задан."""
    from app.core import metrics

    fake = _FakeRedis()
    monkeypatch.setattr(metrics, "_redis_client", lambda: fake)
    try:
        metrics.inc("tests.redis_requests", 3)
        metrics.set_gauge("tests.redis_gauge", 7)
        snap = metrics.snapshot()
        assert snap["tests.redis_requests"] == 3
        assert snap["tests.redis_gauge"] == 7
    finally:
        metrics.reset_for_tests()


def test_metrics_falls_back_to_memory_when_redis_unavailable(monkeypatch):
    """Недоступный Redis не должен ронять запись метрик — тихий откат на in-memory."""
    from app.core import metrics

    monkeypatch.setattr(metrics, "_redis_client", lambda: None)
    metrics.reset_for_tests()
    metrics.inc("tests.fallback", 1)
    assert metrics.snapshot().get("tests.fallback") == 1
    metrics.reset_for_tests()