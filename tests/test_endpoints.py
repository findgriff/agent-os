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

# /api/maxgleam/reports/profit is HQ-only: _require() runs before any maxgleam
# DB access, so an unauthenticated call 401s without needing the (absent) DB —
# unlike an authenticated maxgleam call, which would 500 here (see note above).
#
# The GPS read routes qualify too: _maxgleam_scope() first calls
# partner_for_token(), which short-circuits to None for an empty token *before*
# any query, then falls through to _require() → 401. So the wiring is provable
# here even though an authenticated GPS call needs the (absent) maxgleam DB.
PROTECTED = ["/api/me", "/api/agents", "/api/hermes/history", "/api/tenants",
             "/api/maxgleam/reports/profit",
             "/api/maxgleam/gps/active",
             "/api/maxgleam/gps/crew/1",
             "/api/maxgleam/gps/history/1",
             "/api/maxgleam/gps/retention",
             "/api/maxgleam/gps/mileage"]


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


# The GPS write route carries a crew token, not an HQ session. crew_for_token()
# rejects an empty/garbage token before any DB access (bad tokens fail the HMAC
# check), so this proves the route is wired and never logs a fix without a valid
# crew — hermetic despite the absent maxgleam DB (see note above).
def test_gps_update_requires_crew_token(client):
    body = {"job_id": 1, "lat": 51.5, "lng": -0.1}
    assert client.post("/api/maxgleam/gps/update", body=body, token=None)[0] == 401, \
        "no token must be rejected"
    assert client.post("/api/maxgleam/gps/update", body=body, token="not-a-token")[0] == 401, \
        "a malformed crew token must be rejected"


# Retention pruning is HQ-only and cron-driven. _require() gates it before any
# maxgleam DB access, so the unauthenticated path is provable in this suite.
def test_gps_prune_requires_hq_session(client):
    assert client.post("/api/maxgleam/gps/prune", token=None)[0] == 401, \
        "prune must reject an unauthenticated caller"


# A *valid* partner token must never reach the HQ-only profit route. Partners
# are a separate app: their users and sessions live in the maxgleam DB, while
# _require reads the AGENT OS DB (get_db). So a genuine partner token resolves
# to no AGENT OS user and is rejected — bare _require here is HQ-only, not a
# leak. (A past review wrongly called this exploitable by misreading partner.py
# as writing to the main users/sessions tables; it writes to maxgleam's own.)
# This mints a real partner session in an isolated in-memory maxgleam DB, proves
# partner_for_token accepts it, then proves the profit route + its CSV twin 401
# it. Hermetic: the profit handler never touches the (patched) maxgleam DB.
def test_partner_token_cannot_read_profit(client, monkeypatch):
    import sqlite3
    from server import auth, partner

    mg = sqlite3.connect(":memory:")
    mg.row_factory = sqlite3.Row
    mg.executescript(
        """CREATE TABLE partner_companies (id INTEGER PRIMARY KEY, name TEXT,
               contact_email TEXT, active INTEGER DEFAULT 1);
           CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT,
               password_hash TEXT, partner_company_id INTEGER);
           CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT,
               token TEXT, user_id INTEGER, expires_at INTEGER);""")
    mg.execute("INSERT INTO partner_companies (id, name, contact_email) "
               "VALUES (1, 'Lees & Hendry', 'ops@leeshendry.example')")
    mg.execute("INSERT INTO users (id, name, email, password_hash, "
               "partner_company_id) VALUES (1, 'Partner', 'p@leeshendry.example', ?, 1)",
               (auth.hash_password("partner-pw-12345"),))
    mg.commit()
    monkeypatch.setattr(partner, "_conn", lambda: mg)

    status, body = partner.login("LEESHENDRY", "partner-pw-12345")
    assert status == 200, f"partner login should succeed: {body}"
    ptoken = body["token"]
    # It genuinely is a valid partner credential in the maxgleam DB...
    assert partner.partner_for_token(ptoken) is not None, \
        "the minted token must be a real partner session"
    # ...yet the HQ-only profit route (and its CSV twin) reject it, because
    # _require resolves tokens against a different database entirely.
    assert client.get("/api/maxgleam/reports/profit", token=ptoken)[0] == 401, \
        "a partner token must not read estate-wide profit"
    assert client.get("/api/maxgleam/reports/profit.csv", token=ptoken)[0] == 401, \
        "a partner token must not read the profit CSV either"


# The customer invoice-PDF route is gated by a signed capability token, not an
# HQ session. A missing or malformed token is rejected before any maxgleam DB
# access (bad tokens short-circuit in customer_for_token), so this stays inside
# the hermetic suite even though authenticated maxgleam calls can't (see note
# above). It proves the route is wired and never serves a PDF without a token.
def test_customer_invoice_pdf_requires_token(client):
    path = "/api/maxgleam/customer/invoices/1/pdf"
    assert client.get(path, token=None)[0] == 401, "no token must be rejected"
    assert client.get(path, token="not-a-real-token")[0] == 401, \
        "a malformed customer token must be rejected"


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


# ── GPS retention prune — deletion logic ────────────────────────────
# The auth guard (test_gps_prune_requires_hq_session) covers who may call it;
# these pin the destructive path the daily cron actually runs
# (tools/maxgleam_gps_prune.py → maxgleam_gps.prune()). They drive an isolated
# in-memory gps_log via the module's own _ensure_schema, so the suite stays
# hermetic and never touches the live maxgleam DB while exercising the real
# prune SQL and its cutoff boundary.

def _gps_mem_conn(monkeypatch):
    import sqlite3
    from server import maxgleam_gps as gps
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    gps._ensure_schema(conn)
    monkeypatch.setattr(gps, "_conn", lambda: conn)
    return gps, conn


def _insert_point(conn, ts):
    conn.execute(
        "INSERT INTO gps_log (job_id, subcontractor_id, lat, lng, timestamp) "
        "VALUES (1, 1, 51.5, -0.1, ?)", (ts,))
    conn.commit()


def test_gps_prune_deletes_only_points_past_retention(monkeypatch):
    gps, conn = _gps_mem_conn(monkeypatch)
    now, day = 1_000_000_000, 86_400
    fresh_ts = now - (gps.RETENTION_DAYS - 1) * day   # just inside the window
    stale_ts = now - (gps.RETENTION_DAYS + 1) * day   # just past it
    _insert_point(conn, fresh_ts)
    _insert_point(conn, stale_ts)

    result = gps.prune(now=now)

    assert result["deleted"] == 1, "exactly the one stale point should be dropped"
    assert result["retention_days"] == gps.RETENTION_DAYS
    remaining = [r["timestamp"] for r in conn.execute("SELECT timestamp FROM gps_log")]
    assert remaining == [fresh_ts], "the in-window point must survive"


def test_gps_prune_is_idempotent_when_nothing_stale(monkeypatch):
    gps, conn = _gps_mem_conn(monkeypatch)
    now = 1_000_000_000
    _insert_point(conn, now)

    assert gps.prune(now=now)["deleted"] == 0
    assert gps.prune(now=now)["deleted"] == 0, "a second run deletes nothing more"
    assert conn.execute("SELECT COUNT(*) FROM gps_log").fetchone()[0] == 1
