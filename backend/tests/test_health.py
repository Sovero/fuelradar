def test_health_ok(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["uptime_seconds"] >= 0


def test_ready_ok_with_db(client):
    resp = client.get("/ready")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ready"
    assert body["db"] == "ok"


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