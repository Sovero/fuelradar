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