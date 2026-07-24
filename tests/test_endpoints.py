"""Live endpoint smoke tests against an in-process server + throwaway DB.

Two tiers:
  * CORE_200 — endpoints that must return exactly 200 for a signed-in user on
    an empty database.
  * NO_5XX  — a wider sweep that must merely not fault (any 2xx/4xx is fine;
    a 5xx is a bug). Data-dependent or externally-backed endpoints live here.

The Hermes /chat endpoint is only exercised on its validation path (empty
message → 400) so the suite never shells out to the real Hermes CLI.
"""
import pytest

CORE_200 = [
    "/api/me",
    "/api/tenants",
    "/api/agents",
    "/api/bridges",
    "/api/pipelines",
    "/api/kanban/tasks",
    "/api/chat/rooms",
    "/api/leads",
    "/api/campaigns",
    "/api/email/inbox",
    "/api/hermes/history",
]

NO_5XX = [
    "/api/overview",
    "/api/metrics",
    "/api/mission-control",
    "/api/vault/memories",
    "/api/oracle/history",
    "/api/oracle/sources",
    "/api/apollo/history",
    "/api/investments/lists",
    "/api/investments/prices",
]

# NOTE: /api/maxgleam/* endpoints are intentionally NOT covered here. They are
# backed by the SEPARATE maxgleam database (partner.py has its own connection),
# which this hermetic suite points at a nonexistent path — so they 500 with
# "no such table: sessions" under test even though they are healthy in prod.
# Smoke-testing them would require standing up the maxgleam schema too.

PROTECTED = ["/api/me", "/api/agents", "/api/hermes/history", "/api/tenants"]


# ── liveness & routing ──────────────────────────────────────────────

def test_healthz(client):
    status, body = client.get("/healthz", token=None)
    assert status == 200
    assert body == {"ok": True}


def test_unknown_api_route_404(client):
    status, _ = client.get("/api/does-not-exist")
    assert status == 404


# ── auth gate ───────────────────────────────────────────────────────

@pytest.mark.parametrize("path", PROTECTED)
def test_requires_auth(client, path):
    status, _ = client.get(path, token=None)
    assert status == 401, f"{path} should reject an unauthenticated caller"


# ── authenticated smoke ─────────────────────────────────────────────

@pytest.mark.parametrize("path", CORE_200)
def test_core_endpoint_ok(client, path):
    status, _ = client.get(path)
    assert status == 200, f"{path} returned {status}, expected 200"


@pytest.mark.parametrize("path", NO_5XX)
def test_endpoint_no_5xx(client, path):
    status, _ = client.get(path)
    assert status < 500, f"{path} faulted with {status}"


# ── Hermes wiring (validation only — never invokes the CLI) ─────────

def test_hermes_chat_rejects_empty(client):
    status, body = client.post("/api/hermes/chat", {"message": "   "})
    assert status == 400
    assert "error" in body


def test_hermes_history_shape(client):
    status, body = client.get("/api/hermes/history")
    assert status == 200
    assert isinstance(body.get("messages"), list)
