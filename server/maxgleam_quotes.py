"""Max Gleam quotes — the front of the sales funnel.

Before a prospect becomes a paying customer the office prices up their windows:
a one-off first/deep clean plus the ongoing regular price and how often it
recurs. That estimate is a *quote*. A quote is sent, the prospect accepts or
declines, and an accepted quote is **converted** into a real customer +
property (and, if a first-clean date is given, a first job) in one click.

    draft      priced up, not yet sent
    sent       sent to the prospect, awaiting a decision
    accepted   prospect said yes — ready to convert
    declined   prospect said no
    converted  turned into a customer + property (terminal, idempotent)

Scoping mirrors the rest of the Max Gleam surface: an HQ user sees the whole
tenant; a partner token is boxed to quotes carrying their own company id.
Everything runs against the maxgleam app DB via server.partner's connection,
exactly like server.maxgleam_referrals.
"""
from __future__ import annotations

import os
import re
import sqlite3
import threading
import time

from server import partner

DEFAULT_TENANT_ID = int(os.environ.get("MAXGLEAM_TENANT_ID", "2"))

STATUSES = ("draft", "sent", "accepted", "declined", "converted")
# Once a quote is converted it is spent — it already produced a customer, so
# it must never be edited or converted a second time.
_LOCKED = ("converted",)

_local = threading.local()


def _conn() -> sqlite3.Connection:
    """Thread-local maxgleam connection, shared with server.partner."""
    conn = partner._conn()
    if not getattr(_local, "quotes_schema_ready", False):
        _ensure_schema(conn)
        _local.quotes_schema_ready = True
    return conn


def _ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS quotes (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id          INTEGER NOT NULL REFERENCES tenants(id),
          partner_company_id INTEGER REFERENCES partner_companies(id),
          customer_id        INTEGER REFERENCES customers(id),
          prospect_name      TEXT NOT NULL,
          prospect_email     TEXT,
          prospect_phone     TEXT,
          address            TEXT NOT NULL,
          postcode           TEXT,
          first_clean_pence  INTEGER NOT NULL DEFAULT 0,
          recurring_pence    INTEGER NOT NULL DEFAULT 0,
          frequency_weeks    INTEGER NOT NULL DEFAULT 6,
          notes              TEXT,
          status             TEXT NOT NULL DEFAULT 'draft',
          created_at         INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          sent_at            INTEGER,
          decided_at         INTEGER,
          converted_at       INTEGER,
          converted_property_id INTEGER REFERENCES properties(id)
        )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_quotes_tenant "
                 "ON quotes(tenant_id, status)")
    conn.commit()


def _rows(sql: str, args=()) -> list[dict]:
    return [dict(r) for r in _conn().execute(sql, args).fetchall()]


def _one(sql: str, args=()) -> dict | None:
    r = _conn().execute(sql, args).fetchone()
    return dict(r) if r else None


def _valid_email(email: str) -> bool:
    email = (email or "").strip()
    if not email:
        return True                     # email is optional on a quote
    return "@" in email and "." in email.split("@")[-1] and len(email) <= 254


def _int(v, default: int = 0) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


# ── DTO ─────────────────────────────────────────────────────────────

def _dto(r: dict) -> dict:
    if not r:
        return {}
    return {
        "id": r.get("id"),
        "customer_id": r.get("customer_id"),
        "prospect_name": r.get("prospect_name"),
        "prospect_email": r.get("prospect_email"),
        "prospect_phone": r.get("prospect_phone"),
        "address": r.get("address"),
        "postcode": r.get("postcode"),
        "first_clean_pence": r.get("first_clean_pence") or 0,
        "recurring_pence": r.get("recurring_pence") or 0,
        "frequency_weeks": r.get("frequency_weeks") or 0,
        "notes": r.get("notes"),
        "status": r.get("status"),
        "created_at": r.get("created_at"),
        "sent_at": r.get("sent_at"),
        "decided_at": r.get("decided_at"),
        "converted_at": r.get("converted_at"),
        "converted_property_id": r.get("converted_property_id"),
    }


# ── Scoped fetch ────────────────────────────────────────────────────

def _owned(quote_id: int, tenant_id: int, company_id: int | None) -> dict | None:
    """A quote, only if the caller may touch it."""
    if company_id is None:
        return _one("SELECT * FROM quotes WHERE id = ? AND tenant_id = ?",
                    (quote_id, tenant_id))
    return _one("SELECT * FROM quotes WHERE id = ? AND partner_company_id = ?",
                (quote_id, company_id))


# ── List ────────────────────────────────────────────────────────────

def list_quotes(tenant_id: int = DEFAULT_TENANT_ID,
                company_id: int | None = None, limit: int = 300) -> tuple[int, dict]:
    if company_id is None:
        rows = _rows("SELECT * FROM quotes WHERE tenant_id = ? "
                     "ORDER BY created_at DESC LIMIT ?", (tenant_id, limit))
    else:
        rows = _rows("SELECT * FROM quotes WHERE partner_company_id = ? "
                     "ORDER BY created_at DESC LIMIT ?", (company_id, limit))
    quotes = [_dto(r) for r in rows]

    # Pipeline value = annualised recurring revenue of everything still live
    # (sent or accepted), plus the first-clean cash it would bring in.
    def annual(q):
        weeks = q["frequency_weeks"] or 0
        per_year = (52 // weeks) if weeks else 0
        return q["recurring_pence"] * per_year
    live = [q for q in quotes if q["status"] in ("sent", "accepted")]
    won = [q for q in quotes if q["status"] == "converted"]
    return 200, {
        "quotes": quotes,
        "summary": {
            "total": len(quotes),
            "draft": sum(1 for q in quotes if q["status"] == "draft"),
            "sent": sum(1 for q in quotes if q["status"] == "sent"),
            "accepted": sum(1 for q in quotes if q["status"] == "accepted"),
            "declined": sum(1 for q in quotes if q["status"] == "declined"),
            "converted": len(won),
            "open_first_clean_pence": sum(q["first_clean_pence"] for q in live),
            "open_annual_pence": sum(annual(q) for q in live),
            "won_annual_pence": sum(annual(q) for q in won),
        },
    }


# ── Create ──────────────────────────────────────────────────────────

def create_quote(body: dict, tenant_id: int = DEFAULT_TENANT_ID,
                 company_id: int | None = None) -> tuple[int, dict]:
    name = (body.get("prospect_name") or "").strip()
    address = (body.get("address") or "").strip()
    email = (body.get("prospect_email") or "").strip()
    if not name:
        return 400, {"error": "the prospect's name is required"}
    if not address:
        return 400, {"error": "a property address is required"}
    if not _valid_email(email):
        return 400, {"error": "that email address doesn't look right"}

    first = max(0, _int(body.get("first_clean_pence")))
    recurring = max(0, _int(body.get("recurring_pence")))
    if first == 0 and recurring == 0:
        return 400, {"error": "give a first-clean price, a regular price, or both"}
    freq = _int(body.get("frequency_weeks"), 6)
    freq = min(52, max(0, freq))

    # A quote may be raised against an existing customer; if so it must be one
    # the caller can actually see.
    customer_id = body.get("customer_id")
    if customer_id:
        cust = _customer_in_scope(_int(customer_id), tenant_id, company_id)
        if not cust:
            return 403, {"error": "that customer is not on your account"}
        customer_id = cust["id"]
        name = name or cust["name"]
    else:
        customer_id = None

    status = "sent" if body.get("send") else "draft"
    now = int(time.time())
    conn = _conn()
    cur = conn.execute(
        "INSERT INTO quotes (tenant_id, partner_company_id, customer_id, "
        " prospect_name, prospect_email, prospect_phone, address, postcode, "
        " first_clean_pence, recurring_pence, frequency_weeks, notes, status, sent_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (tenant_id, company_id, customer_id, name, email or None,
         (body.get("prospect_phone") or "").strip() or None, address,
         (body.get("postcode") or "").strip().upper() or None,
         first, recurring, freq, (body.get("notes") or "").strip() or None,
         status, now if status == "sent" else None))
    conn.commit()
    return 200, {"quote": _dto(_one("SELECT * FROM quotes WHERE id = ?", (cur.lastrowid,)))}


def _customer_in_scope(customer_id: int, tenant_id: int,
                       company_id: int | None) -> dict | None:
    if company_id is None:
        return _one("SELECT * FROM customers WHERE id = ? AND tenant_id = ?",
                    (customer_id, tenant_id))
    return _one(
        "SELECT c.* FROM customers c JOIN properties p ON p.customer_id = c.id "
        " WHERE c.id = ? AND p.partner_company_id = ? LIMIT 1",
        (customer_id, company_id))


# ── Update: edit fields and/or move status ──────────────────────────

def update_quote(quote_id: int, body: dict, tenant_id: int = DEFAULT_TENANT_ID,
                 company_id: int | None = None) -> tuple[int, dict]:
    q = _owned(_int(quote_id), tenant_id, company_id)
    if not q:
        return 404, {"error": "that quote is not on your books"}
    if q["status"] in _LOCKED:
        return 409, {"error": "a converted quote can no longer be changed"}

    sets, args = [], []
    # Editable pricing / detail fields (only when supplied).
    for field, key, transform in (
        ("prospect_name", "prospect_name", lambda v: v.strip()),
        ("prospect_email", "prospect_email", lambda v: v.strip() or None),
        ("prospect_phone", "prospect_phone", lambda v: v.strip() or None),
        ("address", "address", lambda v: v.strip()),
        ("postcode", "postcode", lambda v: (v.strip().upper() or None)),
        ("notes", "notes", lambda v: v.strip() or None),
    ):
        if key in body and isinstance(body[key], str):
            sets.append(f"{field} = ?")
            args.append(transform(body[key]))
    for field in ("first_clean_pence", "recurring_pence"):
        if field in body:
            sets.append(f"{field} = ?")
            args.append(max(0, _int(body[field])))
    if "frequency_weeks" in body:
        sets.append("frequency_weeks = ?")
        args.append(min(52, max(0, _int(body["frequency_weeks"]))))

    # Status transitions. draft→sent, sent→accepted/declined, and re-opening a
    # declined quote back to sent are the sane moves; 'converted' is only ever
    # reached through convert_quote(), never a bare status write.
    now = int(time.time())
    new_status = (body.get("status") or "").strip()
    if new_status:
        if new_status not in ("draft", "sent", "accepted", "declined"):
            return 400, {"error": "that status change isn't allowed here"}
        sets.append("status = ?")
        args.append(new_status)
        if new_status == "sent" and not q["sent_at"]:
            sets.append("sent_at = ?"); args.append(now)
        if new_status in ("accepted", "declined"):
            sets.append("decided_at = ?"); args.append(now)

    if not sets:
        return 200, {"quote": _dto(q)}
    args.append(q["id"])
    conn = _conn()
    conn.execute(f"UPDATE quotes SET {', '.join(sets)} WHERE id = ?", args)
    conn.commit()
    return 200, {"quote": _dto(_one("SELECT * FROM quotes WHERE id = ?", (q["id"],)))}


# ── Convert: quote → customer + property (+ optional first job) ──────

_DATE_OK = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def convert_quote(quote_id: int, body: dict | None = None,
                  tenant_id: int = DEFAULT_TENANT_ID,
                  company_id: int | None = None) -> tuple[int, dict]:
    """Turn an accepted quote into a live customer + property.

    Idempotent: a quote already converted returns its existing property rather
    than creating a duplicate customer. If ``first_clean_date`` (YYYY-MM-DD) is
    given and the quote carries a first-clean price, a one-off job is scheduled
    for that date so the round actually gets the work.
    """
    body = body or {}
    q = _owned(_int(quote_id), tenant_id, company_id)
    if not q:
        return 404, {"error": "that quote is not on your books"}
    if q["status"] == "converted":
        return 409, {"error": "that quote has already been converted",
                     "property_id": q["converted_property_id"]}
    if q["status"] == "declined":
        return 409, {"error": "a declined quote can't be converted — re-open it first"}

    conn = _conn()
    now = int(time.time())

    # 1. Customer — reuse the linked one, else an existing match on email, else new.
    customer_id = q["customer_id"]
    if not customer_id and q["prospect_email"]:
        match = _one("SELECT id FROM customers WHERE tenant_id = ? "
                     "AND lower(email) = lower(?) AND archived = 0",
                     (q["tenant_id"], q["prospect_email"]))
        customer_id = match["id"] if match else None
    if not customer_id:
        customer_id = conn.execute(
            "INSERT INTO customers (tenant_id, name, email, phone, notes) "
            "VALUES (?,?,?,?,?)",
            (q["tenant_id"], q["prospect_name"], q["prospect_email"],
             q["prospect_phone"], q["notes"])).lastrowid

    # 2. Property carrying the agreed regular price + frequency.
    prop_id = conn.execute(
        "INSERT INTO properties (tenant_id, customer_id, address, postcode, "
        " price_pence, frequency_weeks, access_notes, partner_company_id) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (q["tenant_id"], customer_id, q["address"], q["postcode"],
         q["recurring_pence"], q["frequency_weeks"] or 6, q["notes"],
         q["partner_company_id"])).lastrowid

    # 3. Optional first clean, scheduled as a one-off job.
    first_job_id = None
    first_date = (body.get("first_clean_date") or "").strip()
    if first_date and _DATE_OK.match(first_date) and q["first_clean_pence"] > 0:
        first_job_id = conn.execute(
            "INSERT INTO jobs (tenant_id, property_id, scheduled_date, status, "
            " price_pence, notes, partner_company_id) "
            "VALUES (?,?,?,'scheduled',?,?,?)",
            (q["tenant_id"], prop_id, first_date, q["first_clean_pence"],
             "First clean (from quote)", q["partner_company_id"])).lastrowid

    conn.execute(
        "UPDATE quotes SET status = 'converted', converted_at = ?, "
        " customer_id = ?, converted_property_id = ? WHERE id = ?",
        (now, customer_id, prop_id, q["id"]))
    conn.execute(
        "INSERT INTO comms_log (tenant_id, customer_id, kind, content) VALUES (?,?,?,?)",
        (q["tenant_id"], customer_id, "quote",
         f"Quote for {q['address']} accepted and converted — regular "
         f"£{(q['recurring_pence'] or 0) / 100:.2f} every {q['frequency_weeks'] or 6}w"
         + (f", first clean {first_date}" if first_job_id else "")))
    conn.commit()
    return 200, {
        "quote": _dto(_one("SELECT * FROM quotes WHERE id = ?", (q["id"],))),
        "customer_id": customer_id,
        "property_id": prop_id,
        "first_job_id": first_job_id,
    }
