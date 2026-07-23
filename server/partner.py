"""Max Gleam Partner Portal — read/write access to the maxgleam database
for partner companies (e.g. Lees & Hendry) who subcontract cleaning work.

Partners are NOT AGENT OS users. They live in the maxgleam `users` table
with role='partner' and a `partner_company_id`, and their sessions are
issued into maxgleam's own `sessions` table. That keeps the partner portal
completely isolated from the AGENT OS command centre: a partner token is
useless against /api/* HQ routes and vice-versa.

Password hashing is identical in both apps (pbkdf2$iters$salt$hash), so
server.auth verifies maxgleam hashes unchanged.
"""
from __future__ import annotations
import os
import re
import sqlite3
import threading
import time

from server import auth

MAXGLEAM_DB = os.environ.get("MAXGLEAM_DB", "/var/lib/maxgleam/app.db")

# Statuses a job can carry in maxgleam: scheduled|done|skipped|missed
UPCOMING_STATUSES = ("scheduled",)
UPCOMING_DAYS = 7
COMPLETED_DAYS = 30

SERVICE_TYPES = ["window_cleaning", "gutter_clearing", "fascia_soffit",
                 "conservatory_roof", "pressure_washing", "solar_panels", "other"]
PRIORITIES = ["low", "normal", "high", "urgent"]

_pool = threading.local()


def _conn() -> sqlite3.Connection:
    """Thread-local connection to the maxgleam DB.

    Deliberately does NOT go through server.db.get_thread_conn: that helper
    keeps one connection per thread and runs the AGENT OS schema against it,
    which would both collide with the HQ database and mutate maxgleam.
    """
    conn = getattr(_pool, "mg_conn", None)
    if conn is None:
        conn = sqlite3.connect(MAXGLEAM_DB, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA busy_timeout = 5000")
        _pool.mg_conn = conn
    return conn


def _rows(sql: str, args=()) -> list[dict]:
    return [dict(r) for r in _conn().execute(sql, args).fetchall()]


def _one(sql: str, args=()) -> dict | None:
    r = _conn().execute(sql, args).fetchone()
    return dict(r) if r else None


# ---------------------------------------------------------------- identity --

def company_code(name: str) -> str:
    """Derive a login code from a company name.

    "Lees & Hendry Limited" → "LEESHENDRY". Codes are derived rather than
    stored so the partner portal needs no schema change to the live maxgleam
    database; the trailing legal suffix is dropped so partners can type the
    name they actually use.
    """
    stripped = re.sub(r"\b(limited|ltd|llp|plc|inc)\b\.?", "", name or "", flags=re.I)
    return re.sub(r"[^A-Za-z0-9]", "", stripped).upper()


def _company_for_code(code: str) -> dict | None:
    """Match a typed code against every active partner company.

    Accepts the derived code, the raw company name, or the contact email so
    a partner who only knows one of the three can still get in.
    """
    typed = (code or "").strip()
    if not typed:
        return None
    norm = re.sub(r"[^A-Za-z0-9]", "", typed).upper()
    for c in _rows("SELECT * FROM partner_companies WHERE active = 1 ORDER BY id"):
        if norm and norm in (company_code(c["name"]), re.sub(r"[^A-Za-z0-9]", "", c["name"]).upper()):
            return c
        if typed.lower() == (c["contact_email"] or "").lower():
            return c
    return None


def _partner_dto(user: dict, company: dict) -> dict:
    return {
        "id": user["id"],
        "name": user["name"],
        "email": user["email"],
        "company": {
            "id": company["id"],
            "name": company["name"],
            "code": company_code(company["name"]),
            "colour": company.get("colour") or "#1B8FD6",
            "contact_name": company.get("contact_name"),
            "contact_email": company.get("contact_email"),
            "contact_phone": company.get("contact_phone"),
        },
    }


def login(code: str, password: str) -> tuple[int, dict]:
    """Authenticate a partner by company code + password."""
    company = _company_for_code(code)
    if not company:
        return 401, {"error": "unknown company code"}
    candidates = _rows(
        "SELECT * FROM users WHERE partner_company_id = ? ORDER BY id",
        (company["id"],))
    for u in candidates:
        if auth.verify_password(password or "", u.get("password_hash")):
            token = auth.create_session(_conn(), u["id"])
            return 200, {"token": token, "partner": _partner_dto(u, company)}
    return 401, {"error": "invalid company code or password"}


def partner_for_token(token: str) -> dict | None:
    """Resolve a partner bearer token → {user, company}, or None."""
    if not token:
        return None
    user = _one(
        "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
        "WHERE s.token = ? AND s.expires_at > strftime('%s','now')", (token,))
    if not user or not user.get("partner_company_id"):
        return None
    company = _one("SELECT * FROM partner_companies WHERE id = ? AND active = 1",
                   (user["partner_company_id"],))
    if not company:
        return None
    return {"user": user, "company": company}


def me(session: dict) -> tuple[int, dict]:
    return 200, {"partner": _partner_dto(session["user"], session["company"])}


def logout(token: str) -> tuple[int, dict]:
    conn = _conn()
    conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
    conn.commit()
    return 200, {"ok": True}


# -------------------------------------------------------------------- jobs --

# A job belongs to a partner either directly (jobs.partner_company_id, set
# when work is dispatched to them) or by inheritance from the property they
# manage (properties.partner_company_id). Both are live in the data, so both
# are matched.
_JOB_SELECT = """
  SELECT j.id, j.scheduled_date, j.status, j.price_pence, j.notes,
         j.completed_at, j.started_at, j.signoff_status, j.signoff_at,
         p.address, p.postcode, p.access_notes,
         c.name AS customer_name,
         s.name AS crew_name
    FROM jobs j
    JOIN properties p ON p.id = j.property_id
    LEFT JOIN customers c ON c.id = p.customer_id
    LEFT JOIN subcontractors s ON s.id = j.subcontractor_id
   WHERE (j.partner_company_id = ? OR p.partner_company_id = ?)
"""


def _job_dto(r: dict) -> dict:
    return {
        "id": r["id"],
        "scheduled_date": r["scheduled_date"],
        "status": r["status"],
        "price_pence": r["price_pence"] or 0,
        "address": r["address"],
        "postcode": r["postcode"],
        "customer_name": r["customer_name"],
        "crew_name": r["crew_name"],
        "notes": r["notes"],
        "access_notes": r["access_notes"],
        "completed_at": r["completed_at"],
        "signoff_status": r["signoff_status"],
    }


def jobs(session: dict) -> tuple[int, dict]:
    cid = session["company"]["id"]
    today = time.strftime("%Y-%m-%d")
    horizon = time.strftime("%Y-%m-%d", time.gmtime(time.time() + UPCOMING_DAYS * 86400))
    since = time.strftime("%Y-%m-%d", time.gmtime(time.time() - COMPLETED_DAYS * 86400))

    placeholders = ",".join("?" for _ in UPCOMING_STATUSES)
    upcoming = _rows(
        _JOB_SELECT + f" AND j.scheduled_date BETWEEN ? AND ?"
        f" AND j.status IN ({placeholders})"
        " ORDER BY j.scheduled_date ASC, p.address ASC",
        (cid, cid, today, horizon, *UPCOMING_STATUSES))

    completed = _rows(
        _JOB_SELECT + " AND j.status = 'done' AND j.scheduled_date >= ?"
        " ORDER BY j.scheduled_date DESC, p.address ASC LIMIT 200",
        (cid, cid, since))

    # Anything still 'scheduled' with a date in the past needs chasing —
    # partners care about this more than the tidy 7-day window.
    overdue = _rows(
        _JOB_SELECT + f" AND j.scheduled_date < ? AND j.status IN ({placeholders})"
        " ORDER BY j.scheduled_date ASC LIMIT 100",
        (cid, cid, today, *UPCOMING_STATUSES))

    return 200, {
        "upcoming": [_job_dto(r) for r in upcoming],
        "completed": [_job_dto(r) for r in completed],
        "overdue": [_job_dto(r) for r in overdue],
        "window": {"upcoming_days": UPCOMING_DAYS, "completed_days": COMPLETED_DAYS,
                   "today": today},
    }


def properties(session: dict) -> tuple[int, dict]:
    """Properties this partner manages — the picker for a work request."""
    cid = session["company"]["id"]
    rs = _rows(
        "SELECT p.id, p.address, p.postcode, p.price_pence, c.name AS customer_name "
        "  FROM properties p "
        "  LEFT JOIN customers c ON c.id = p.customer_id "
        " WHERE p.partner_company_id = ? AND p.active = 1 "
        " ORDER BY p.address ASC", (cid,))
    return 200, {"properties": rs, "service_types": SERVICE_TYPES, "priorities": PRIORITIES}


# ----------------------------------------------------------- work requests --

def work_requests(session: dict) -> tuple[int, dict]:
    cid = session["company"]["id"]
    rs = _rows(
        "SELECT w.*, p.address, p.postcode "
        "  FROM work_requests w "
        "  LEFT JOIN properties p ON p.id = w.property_id "
        " WHERE w.partner_company_id = ? "
        " ORDER BY w.created_at DESC LIMIT 100", (cid,))
    return 200, {"work_requests": rs}


def create_work_request(session: dict, body: dict) -> tuple[int, dict]:
    company, user = session["company"], session["user"]
    title = (body.get("title") or "").strip()
    if not title:
        return 400, {"error": "title is required"}

    property_id = body.get("property_id")
    if property_id in ("", None):
        property_id = None
    else:
        try:
            property_id = int(property_id)
        except (TypeError, ValueError):
            return 400, {"error": "invalid property"}
        # A partner may only raise requests against their own properties.
        owned = _one("SELECT id FROM properties WHERE id = ? AND partner_company_id = ?",
                     (property_id, company["id"]))
        if not owned:
            return 403, {"error": "that property is not managed by your company"}

    service_type = body.get("service_type") or "window_cleaning"
    if service_type not in SERVICE_TYPES:
        return 400, {"error": "invalid service type"}
    priority = body.get("priority") or "normal"
    if priority not in PRIORITIES:
        return 400, {"error": "invalid priority"}

    conn = _conn()
    cur = conn.execute(
        "INSERT INTO work_requests (tenant_id, partner_company_id, submitted_by, "
        " property_id, title, description, service_type, priority, status) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
        (company["tenant_id"], company["id"], user["id"], property_id, title,
         (body.get("description") or "").strip(), service_type, priority))
    conn.commit()
    row = _one("SELECT w.*, p.address, p.postcode FROM work_requests w "
               "LEFT JOIN properties p ON p.id = w.property_id WHERE w.id = ?",
               (cur.lastrowid,))
    return 200, {"work_request": row}


# ---------------------------------------------------------------- payments --

def payments(session: dict) -> tuple[int, dict]:
    """Invoice position for work carried out on this partner's estate.

    maxgleam's payroll_payments table pays *subcontractors*, not partner
    companies, so it carries no partner linkage — invoices raised against
    the partner's properties are the real money view for this portal.
    """
    cid = session["company"]["id"]
    rs = _rows(
        "SELECT i.id, i.number, i.amount_pence, i.vat_pence, i.status, i.method, "
        "       i.issued_at, i.paid_at, j.scheduled_date, p.address, p.postcode "
        "  FROM invoices i "
        "  JOIN jobs j ON j.id = i.job_id "
        "  JOIN properties p ON p.id = j.property_id "
        " WHERE (j.partner_company_id = ? OR p.partner_company_id = ?) "
        "   AND i.status != 'void' "
        " ORDER BY i.issued_at DESC LIMIT 200", (cid, cid))

    paid = sum(r["amount_pence"] for r in rs if r["status"] == "paid")
    unpaid = sum(r["amount_pence"] for r in rs if r["status"] == "unpaid")

    # Value of completed work in the last 30 days, whether invoiced or not —
    # tells a partner what is coming even before an invoice is raised.
    since = time.strftime("%Y-%m-%d", time.gmtime(time.time() - COMPLETED_DAYS * 86400))
    done = _one(
        "SELECT COUNT(*) AS n, COALESCE(SUM(j.price_pence), 0) AS total "
        "  FROM jobs j JOIN properties p ON p.id = j.property_id "
        " WHERE (j.partner_company_id = ? OR p.partner_company_id = ?) "
        "   AND j.status = 'done' AND j.scheduled_date >= ?", (cid, cid, since)) or {}

    return 200, {
        "invoices": rs,
        "summary": {
            "paid_pence": paid,
            "unpaid_pence": unpaid,
            "invoice_count": len(rs),
            "completed_jobs_30d": done.get("n", 0),
            "completed_value_30d_pence": done.get("total", 0),
        },
    }
