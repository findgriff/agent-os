"""Shared fixtures for the AGENT OS smoke suite.

Everything here is hermetic: the app is booted IN-PROCESS against a throwaway
SQLite DB in a temp dir, on an ephemeral port. The live database
(/var/lib/agent-os/data.db) and the live service on :8100 are never touched.

The env vars must be set BEFORE `server.app` is imported, because the module
reads AGENTOS_DB / MAXGLEAM_DB into constants at import time — so this happens
at the very top, ahead of the server imports.
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

# Throwaway DB + a maxgleam path that doesn't exist, so bootstrap's optional
# "copy owner users from maxgleam" step is skipped and the suite stays hermetic.
_TMP = tempfile.mkdtemp(prefix="agentos-smoke-")
os.environ["AGENTOS_DB"] = os.path.join(_TMP, "test.db")
os.environ["MAXGLEAM_DB"] = os.path.join(_TMP, "absent-maxgleam.db")
os.environ.setdefault("AGENTOS_PORT", "0")

from http.server import ThreadingHTTPServer            # noqa: E402
from server import app as appmod                        # noqa: E402
from server import auth as authmod                      # noqa: E402
from server import db as dbmod                          # noqa: E402

TEST_EMAIL = "smoketest@agent-os.local"


class Client:
    """Tiny JSON HTTP client. Returns (status, parsed_body); never raises on
    non-2xx (HTTPError is caught and its status/body returned instead)."""

    def __init__(self, base_url: str, token: str | None = None):
        self.base_url = base_url
        self.token = token

    _DEFAULT = object()

    def request(self, method, path, body=None, token=_DEFAULT):
        tok = self.token if token is Client._DEFAULT else token
        headers = {}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        if tok:
            headers["Authorization"] = f"Bearer {tok}"
        req = urllib.request.Request(self.base_url + path, data=data,
                                     headers=headers, method=method)
        try:
            resp = urllib.request.urlopen(req, timeout=30)
            status, raw = resp.status, resp.read().decode()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read().decode()
        try:
            parsed = json.loads(raw) if raw else {}
        except ValueError:
            parsed = {}
        return status, parsed

    def get(self, path, **kw):
        return self.request("GET", path, **kw)

    def post(self, path, body=None, **kw):
        return self.request("POST", path, body=body, **kw)


@pytest.fixture(scope="session", autouse=True)
def _cleanup_tmp():
    yield
    shutil.rmtree(_TMP, ignore_errors=True)


@pytest.fixture(scope="session")
def seeded_db():
    """Boot the app's schema + a guaranteed tenant and test user."""
    conn = appmod.get_db()
    # Realistic boot (seeds tenants, vault, demo). Guarded so a missing
    # optional dependency can't sink the whole suite.
    try:
        appmod.bootstrap(conn)
    except Exception:                                    # noqa: BLE001
        pass
    tenant = dbmod.one(conn, "SELECT id FROM tenants ORDER BY id LIMIT 1")
    tid = tenant["id"] if tenant else dbmod.insert(
        conn, "tenants",
        {"name": "Smoke Co", "slug": "smoke-co", "brand_colour": "#19C3E6"})
    user = dbmod.one(conn, "SELECT id FROM users WHERE email = ?", (TEST_EMAIL,))
    uid = user["id"] if user else dbmod.insert(conn, "users", {
        "tenant_id": tid, "email": TEST_EMAIL, "name": "Smoke Test",
        "role": "owner", "password_hash": authmod.hash_password("smoke-pw-12345")})
    return {"tenant_id": tid, "user_id": uid}


@pytest.fixture(scope="session")
def token(seeded_db):
    return authmod.create_session(appmod.get_db(), seeded_db["user_id"])


@pytest.fixture(scope="session")
def server(seeded_db):
    """A real ThreadingHTTPServer on an ephemeral port, torn down at end."""
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), appmod.Handler)
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    for _ in range(50):                                  # wait for readiness
        try:
            urllib.request.urlopen(base + "/healthz", timeout=1).read()
            break
        except Exception:                                # noqa: BLE001
            time.sleep(0.1)
    yield base
    httpd.shutdown()


@pytest.fixture
def client(server, token):
    return Client(server, token)
