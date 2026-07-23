"""SumUp hosted checkouts for Max Gleam invoices.

A stdlib mirror of /opt/maxgleam/server/sumup.py. The two applications share
one database and one set of per-tenant SumUp credentials, but they are
separate services with separate Python paths, so agent-os carries its own
copy of the transport rather than importing across the boundary. Keep the
request shapes here in step with that file.

Auth is a per-tenant secret key (sup_sk_*/sk_live_*/sk_test_*) held in
tenants.sumup_api_key. Nothing here ever takes a card number: the customer
is sent to a SumUp-hosted page and we only ever read back a status.

Docs: https://developer.sumup.com/api
"""
from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request

log = logging.getLogger("agentos.sumup")

API = "https://api.sumup.com"
USER_AGENT = "agent-os/1.0"
TIMEOUT = 20


class SumUpError(RuntimeError):
    pass


def _request(method: str, path: str, *, api_key: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        API + path, data=data, method=method,
        headers={"Authorization": f"Bearer {api_key}",
                 "Content-Type": "application/json",
                 "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:300]
        raise SumUpError(f"sumup HTTP {e.code}: {detail}") from e
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
        raise SumUpError(f"sumup unreachable: {type(e).__name__}") from e


def merchant_profile(api_key: str) -> dict:
    """Validate a key and return the merchant profile (incl. merchant_code)."""
    return _request("GET", "/v0.1/me", api_key=api_key)


def merchant_code(api_key: str) -> str:
    return (merchant_profile(api_key).get("merchant_profile") or {}).get("merchant_code") or ""


def create_hosted_checkout(*, api_key: str, merchant_code: str,
                           amount_pence: int, currency: str,
                           reference: str, description: str,
                           redirect_url: str | None = None) -> dict:
    """Create a hosted checkout. `hosted_checkout_url` is the customer pay link."""
    body = {
        "checkout_reference": reference,
        "amount": round(amount_pence / 100, 2),
        "currency": currency,
        "merchant_code": merchant_code,
        "description": description,
        "hosted_checkout": {"enabled": True},
    }
    if redirect_url:
        body["redirect_url"] = redirect_url
    return _request("POST", "/v0.1/checkouts", api_key=api_key, body=body)


def checkout_status(*, api_key: str, checkout_id: str) -> dict:
    return _request("GET", f"/v0.1/checkouts/{checkout_id}", api_key=api_key)
