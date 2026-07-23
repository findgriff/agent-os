"""Max Gleam referral programme.

A customer refers a friend by email. When that friend turns up in the
customers table and books their first clean, the referrer earns a discount
which is applied to their next unpaid invoice.

    pending     referral recorded, friend has not signed up
    signed_up   friend exists as a customer AND has at least one job
    rewarded    the discount has been applied to one of the referrer's invoices

Invoices are raised by the maxgleam app itself, not by AGENT OS, so there is
no invoice-creation hook to piggyback on. Instead run_sweep() promotes and
pays out: it applies the credit to the referrer's oldest unpaid invoice, and
if they have none yet the referral simply waits at 'signed_up' until they do.
Nothing is ever paid out twice — the status column is the guard.
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time

from server import partner

log = logging.getLogger("agentos")

DEFAULT_TENANT_ID = int(os.environ.get("MAXGLEAM_TENANT_ID", "2"))
DISCOUNT_PENCE = int(os.environ.get("MAXGLEAM_REFERRAL_DISCOUNT_PENCE", "2000"))  # £20

STATUSES = ("pending", "signed_up", "rewarded")

_local = threading.local()


def _conn() -> sqlite3.Connection:
    """Thread-local maxgleam connection, shared with server.partner."""
    conn = partner._conn()
    if not getattr(_local, "schema_ready", False):
        _ensure_schema(conn)
        _local.schema_ready = True
    return conn


def _ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS referrals (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id      INTEGER NOT NULL REFERENCES tenants(id),
          customer_id    INTEGER NOT NULL REFERENCES customers(id),
          referred_email TEXT NOT NULL,
          referred_name  TEXT,
          status         TEXT NOT NULL DEFAULT 'pending',
          discount_pence INTEGER NOT NULL DEFAULT 2000,
          created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )""")
    conn.execute("""CREATE INDEX IF NOT EXISTS idx_referrals_tenant
                    ON referrals(tenant_id, status)""")
    # One live referral per (referrer, friend). Stops a double-submitted form
    # from creating two credits for the same introduction.
    conn.execute("""CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_once
                    ON referrals(customer_id, lower(referred_email))""")
    # Columns added after the first release land here.
    cols = {r[1] for r in conn.execute("PRAGMA table_info(referrals)")}
    if "rewarded_invoice_id" not in cols:
        conn.execute("ALTER TABLE referrals ADD COLUMN rewarded_invoice_id INTEGER")
    if "rewarded_at" not in cols:
        conn.execute("ALTER TABLE referrals ADD COLUMN rewarded_at INTEGER")
    conn.commit()


def _rows(sql: str, args=()) -> list[dict]:
    return [dict(r) for r in _conn().execute(sql, args).fetchall()]


def _one(sql: str, args=()) -> dict | None:
    r = _conn().execute(sql, args).fetchone()
    return dict(r) if r else None


def _valid_email(email: str) -> bool:
    email = (email or "").strip()
    return "@" in email and "." in email.split("@")[-1] and len(email) <= 254


# ── Scoping ─────────────────────────────────────────────────────────

def referrer_customers(tenant_id: int, partner_company_id: int | None) -> list[dict]:
    """Customers who may be named as the referrer.

    For a partner that is only the customers behind properties they manage —
    the same estate boundary the rest of the portal enforces.
    """
    if partner_company_id is None:
        return _rows(
            "SELECT id, name, email, phone FROM customers "
            " WHERE tenant_id = ? AND archived = 0 ORDER BY name", (tenant_id,))
    return _rows(
        "SELECT DISTINCT c.id, c.name, c.email, c.phone "
        "  FROM customers c JOIN properties p ON p.customer_id = c.id "
        " WHERE c.archived = 0 AND p.partner_company_id = ? "
        " ORDER BY c.name", (partner_company_id,))


def _customer_in_scope(customer_id: int, tenant_id: int,
                       partner_company_id: int | None) -> dict | None:
    if partner_company_id is None:
        return _one("SELECT * FROM customers WHERE id = ? AND tenant_id = ?",
                    (customer_id, tenant_id))
    return _one(
        "SELECT c.* FROM customers c JOIN properties p ON p.customer_id = c.id "
        " WHERE c.id = ? AND p.partner_company_id = ? LIMIT 1",
        (customer_id, partner_company_id))


# ── Create + list ───────────────────────────────────────────────────

def create_referral(body: dict, tenant_id: int = DEFAULT_TENANT_ID,
                    partner_company_id: int | None = None) -> tuple[int, dict]:
    """Record a referral. Returns (http_status, payload)."""
    email = (body.get("referred_email") or "").strip()
    name = (body.get("referred_name") or "").strip()
    if not _valid_email(email):
        return 400, {"error": "a valid referred_email is required"}

    try:
        customer_id = int(body.get("customer_id") or 0)
    except (TypeError, ValueError):
        return 400, {"error": "customer_id must be a number"}
    if not customer_id:
        return 400, {"error": "customer_id (the referrer) is required"}

    referrer = _customer_in_scope(customer_id, tenant_id, partner_company_id)
    if not referrer:
        return 403, {"error": "that customer is not on your account"}

    # Referring yourself is not a referral.
    if (referrer.get("email") or "").strip().lower() == email.lower():
        return 400, {"error": "a customer cannot refer themselves"}

    # Someone already on the books is not a new customer.
    existing = _one("SELECT id FROM customers WHERE tenant_id = ? "
                    "AND lower(email) = lower(?) AND archived = 0",
                    (tenant_id, email))
    if existing:
        return 409, {"error": "that email already belongs to a Max Gleam customer"}

    dupe = _one("SELECT id, status FROM referrals WHERE customer_id = ? "
                "AND lower(referred_email) = lower(?)", (customer_id, email))
    if dupe:
        return 409, {"error": "you have already referred that email",
                     "referral_id": dupe["id"], "status": dupe["status"]}

    try:
        discount = int(body.get("discount_pence") or DISCOUNT_PENCE)
    except (TypeError, ValueError):
        discount = DISCOUNT_PENCE

    conn = _conn()
    cur = conn.execute(
        "INSERT INTO referrals (tenant_id, customer_id, referred_email, "
        " referred_name, status, discount_pence) VALUES (?,?,?,?,'pending',?)",
        (referrer["tenant_id"], customer_id, email, name or None, discount))
    conn.execute(
        "INSERT INTO comms_log (tenant_id, customer_id, kind, content) VALUES (?,?,?,?)",
        (referrer["tenant_id"], customer_id, "referral",
         f"Referred {name or email} ({email}) — £{discount / 100:.2f} credit when "
         f"they book their first clean"))
    conn.commit()
    return 200, {"referral": _referral_dto(_one(
        "SELECT * FROM referrals WHERE id = ?", (cur.lastrowid,)) or {})}


def _referral_dto(r: dict) -> dict:
    if not r:
        return {}
    referrer = _one("SELECT name, email FROM customers WHERE id = ?",
                    (r.get("customer_id"),)) or {}
    return {
        "id": r.get("id"),
        "customer_id": r.get("customer_id"),
        "referrer_name": referrer.get("name"),
        "referrer_email": referrer.get("email"),
        "referred_email": r.get("referred_email"),
        "referred_name": r.get("referred_name"),
        "status": r.get("status"),
        "discount_pence": r.get("discount_pence"),
        "rewarded_invoice_id": r.get("rewarded_invoice_id"),
        "rewarded_at": r.get("rewarded_at"),
        "created_at": r.get("created_at"),
    }


def list_referrals(tenant_id: int = DEFAULT_TENANT_ID,
                   partner_company_id: int | None = None,
                   limit: int = 200) -> dict:
    if partner_company_id is None:
        rows = _rows("SELECT * FROM referrals WHERE tenant_id = ? "
                     "ORDER BY created_at DESC LIMIT ?", (tenant_id, limit))
    else:
        rows = _rows(
            "SELECT DISTINCT r.* FROM referrals r "
            "  JOIN properties p ON p.customer_id = r.customer_id "
            " WHERE p.partner_company_id = ? "
            " ORDER BY r.created_at DESC LIMIT ?", (partner_company_id, limit))

    referrals = [_referral_dto(r) for r in rows]
    earned = sum(r["discount_pence"] for r in referrals if r["status"] == "rewarded")
    pending_value = sum(r["discount_pence"] for r in referrals
                        if r["status"] == "signed_up")
    return {
        "referrals": referrals,
        "referrers": referrer_customers(tenant_id, partner_company_id),
        "summary": {
            "total": len(referrals),
            "pending": sum(1 for r in referrals if r["status"] == "pending"),
            "signed_up": sum(1 for r in referrals if r["status"] == "signed_up"),
            "rewarded": sum(1 for r in referrals if r["status"] == "rewarded"),
            "earned_pence": earned,
            "awaiting_invoice_pence": pending_value,
        },
        "discount_pence": DISCOUNT_PENCE,
    }


# ── Sweep: promote sign-ups, pay out credits ────────────────────────

def _first_job(customer_id: int) -> dict | None:
    """The referred customer's first clean — booked or already done."""
    return _one(
        "SELECT j.id, j.scheduled_date, j.status FROM jobs j "
        "  JOIN properties p ON p.id = j.property_id "
        " WHERE p.customer_id = ? ORDER BY j.scheduled_date LIMIT 1", (customer_id,))


def check_signups(tenant_id: int = DEFAULT_TENANT_ID, dry_run: bool = False) -> list[dict]:
    """pending → signed_up once the friend exists AND has booked a first clean."""
    promoted = []
    conn = _conn()
    for r in _rows("SELECT * FROM referrals WHERE tenant_id = ? AND status = 'pending'",
                   (tenant_id,)):
        friend = _one("SELECT id, name FROM customers WHERE tenant_id = ? "
                      "AND lower(email) = lower(?) AND archived = 0",
                      (tenant_id, r["referred_email"]))
        if not friend:
            continue
        job = _first_job(friend["id"])
        if not job:
            continue                       # signed up but no clean booked yet
        promoted.append({"referral_id": r["id"], "referred_email": r["referred_email"],
                         "friend_customer_id": friend["id"], "first_job_id": job["id"],
                         "discount_pence": r["discount_pence"]})
        if not dry_run:
            conn.execute("UPDATE referrals SET status = 'signed_up' WHERE id = ?",
                         (r["id"],))
            conn.execute(
                "INSERT INTO comms_log (tenant_id, customer_id, kind, content) "
                "VALUES (?,?,?,?)",
                (tenant_id, r["customer_id"], "referral",
                 f"{r['referred_email']} booked their first clean — "
                 f"£{r['discount_pence'] / 100:.2f} credit due"))
    if not dry_run:
        conn.commit()
    return promoted


def apply_rewards(tenant_id: int = DEFAULT_TENANT_ID, dry_run: bool = False) -> list[dict]:
    """signed_up → rewarded by discounting the referrer's oldest unpaid invoice.

    The discount is written onto the invoice itself (amount reduced, a line
    added to items_json) so the customer sees why they are paying less. An
    invoice is never taken below zero, and a referral with no invoice to land
    on simply waits for the next one.
    """
    applied = []
    conn = _conn()
    for r in _rows("SELECT * FROM referrals WHERE tenant_id = ? AND status = 'signed_up' "
                   "ORDER BY created_at", (tenant_id,)):
        invoice = _one(
            "SELECT * FROM invoices WHERE tenant_id = ? AND customer_id = ? "
            "  AND status = 'unpaid' AND amount_pence > 0 "
            " ORDER BY issued_at LIMIT 1", (tenant_id, r["customer_id"]))
        if not invoice:
            continue

        discount = min(r["discount_pence"], invoice["amount_pence"])
        new_amount = invoice["amount_pence"] - discount
        try:
            items = json.loads(invoice.get("items_json") or "[]")
            if not isinstance(items, list):
                items = []
        except (json.JSONDecodeError, TypeError):
            items = []
        items.append({
            "description": f"Referral credit — thank you for introducing "
                           f"{r['referred_name'] or r['referred_email']}",
            "amount_pence": -discount,
        })

        applied.append({
            "referral_id": r["id"], "customer_id": r["customer_id"],
            "invoice_id": invoice["id"], "invoice_number": invoice["number"],
            "discount_pence": discount,
            "was_pence": invoice["amount_pence"], "now_pence": new_amount,
            "partial": discount < r["discount_pence"],
        })
        if dry_run:
            continue

        conn.execute("UPDATE invoices SET amount_pence = ?, items_json = ? WHERE id = ?",
                     (new_amount, json.dumps(items), invoice["id"]))
        conn.execute(
            "UPDATE referrals SET status = 'rewarded', rewarded_invoice_id = ?, "
            " rewarded_at = ? WHERE id = ?",
            (invoice["id"], int(time.time()), r["id"]))
        conn.execute(
            "INSERT INTO comms_log (tenant_id, customer_id, kind, content) VALUES (?,?,?,?)",
            (tenant_id, r["customer_id"], "referral",
             f"£{discount / 100:.2f} referral credit applied to {invoice['number']} "
             f"(was £{invoice['amount_pence'] / 100:.2f}, now £{new_amount / 100:.2f})"))
    if not dry_run:
        conn.commit()
    return applied


def run_sweep(tenant_id: int = DEFAULT_TENANT_ID, dry_run: bool = False) -> dict:
    promoted = check_signups(tenant_id, dry_run)
    applied = apply_rewards(tenant_id, dry_run)
    return {
        "dry_run": dry_run,
        "signed_up": promoted, "signed_up_count": len(promoted),
        "rewarded": applied, "rewarded_count": len(applied),
        "credit_applied_pence": sum(a["discount_pence"] for a in applied),
    }
