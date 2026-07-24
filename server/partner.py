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


# --------------------------------------------------------- job management --
# Office actions a partner may take on their OWN jobs: move the date, hand it
# to a different crew, or call it off. Every one re-checks ownership on the
# job id from the URL — a partner token proves which company you are, never
# which job you may touch, so the id is validated against the company on each
# call rather than trusted from the client.

# Terminal states cannot be rescheduled or reassigned: a done job has been
# completed and very likely invoiced; a cancelled one is closed.
_LOCKED_STATUSES = ("done", "cancelled")


def _owned_job(session: dict, job_id) -> dict | None:
    """The job, only if it belongs to this partner's company.

    Matches maxgleam's dual ownership model (direct dispatch OR inherited from
    the managed property), exactly as the job list does, so a partner can act
    on precisely the jobs they can see and no others.
    """
    try:
        jid = int(job_id)
    except (TypeError, ValueError):
        return None
    cid = session["company"]["id"]
    return _one(
        "SELECT j.*, p.address, p.partner_company_id AS prop_partner_id "
        "  FROM jobs j JOIN properties p ON p.id = j.property_id "
        " WHERE j.id = ? AND (j.partner_company_id = ? OR p.partner_company_id = ?)",
        (jid, cid, cid))


def _log_office_action(job: dict, content: str) -> None:
    """Best-effort audit trail in comms_log. A failed write must never fail
    the action it is recording."""
    try:
        conn = _conn()
        conn.execute(
            "INSERT INTO comms_log (tenant_id, customer_id, kind, content) "
            "VALUES (?, ?, 'office_action', ?)",
            (job["tenant_id"], None, content))
        conn.commit()
    except Exception:                                       # noqa: BLE001
        pass


def _fresh_job_dto(job_id: int) -> dict | None:
    row = _one(_JOB_SELECT.replace(
        "WHERE (j.partner_company_id = ? OR p.partner_company_id = ?)",
        "WHERE j.id = ?"), (job_id,))
    return _job_dto(row) if row else None


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def reschedule_job(session: dict, job_id, body: dict) -> tuple[int, dict]:
    """Move a job to a new date. Body: {date: 'YYYY-MM-DD'}."""
    job = _owned_job(session, job_id)
    if not job:
        return 404, {"error": "that job is not on your books"}
    if job["status"] in _LOCKED_STATUSES:
        return 409, {"error": f"a {job['status']} job cannot be rescheduled"}

    date = (str(body.get("date") or body.get("scheduled_date") or "")).strip()
    if not _DATE_RE.match(date):
        return 400, {"error": "a date in YYYY-MM-DD form is required"}
    try:
        time.strptime(date, "%Y-%m-%d")                     # rejects 2026-13-40
    except ValueError:
        return 400, {"error": "that is not a real date"}

    was = job["scheduled_date"]
    if date == was:
        return 200, {"job": _fresh_job_dto(job["id"]), "unchanged": True}

    conn = _conn()
    conn.execute("UPDATE jobs SET scheduled_date = ? WHERE id = ?", (date, job["id"]))
    conn.commit()
    _log_office_action(job, f"Job {job['id']} ({job['address']}) rescheduled "
                            f"{was} → {date} by {session['company']['name']}")
    return 200, {"job": _fresh_job_dto(job["id"])}


def assign_job(session: dict, job_id, body: dict) -> tuple[int, dict]:
    """Reassign a job to a different crew. Body: {crew_id} (null to unassign)."""
    job = _owned_job(session, job_id)
    if not job:
        return 404, {"error": "that job is not on your books"}
    if job["status"] in _LOCKED_STATUSES:
        return 409, {"error": f"a {job['status']} job cannot be reassigned"}

    raw = body.get("crew_id", body.get("subcontractor_id"))
    if raw in ("", None):
        conn = _conn()
        conn.execute("UPDATE jobs SET subcontractor_id = NULL WHERE id = ?", (job["id"],))
        conn.commit()
        _log_office_action(job, f"Job {job['id']} ({job['address']}) unassigned "
                                f"by {session['company']['name']}")
        return 200, {"job": _fresh_job_dto(job["id"])}

    try:
        crew_id = int(raw)
    except (TypeError, ValueError):
        return 400, {"error": "invalid crew"}

    # The crew must be an active subcontractor on this job's tenant — a partner
    # cannot hand work to a crew from another tenant by guessing an id.
    crew = _one("SELECT id, name FROM subcontractors "
                " WHERE id = ? AND tenant_id = ? AND active = 1",
                (crew_id, job["tenant_id"]))
    if not crew:
        return 404, {"error": "that crew is not available to take this job"}

    conn = _conn()
    conn.execute("UPDATE jobs SET subcontractor_id = ? WHERE id = ?", (crew_id, job["id"]))
    conn.commit()
    _log_office_action(job, f"Job {job['id']} ({job['address']}) assigned to "
                            f"{crew['name']} by {session['company']['name']}")
    return 200, {"job": _fresh_job_dto(job["id"])}


def cancel_job(session: dict, job_id, body: dict | None = None) -> tuple[int, dict]:
    """Call a job off — status becomes 'cancelled'. A done job is left alone."""
    job = _owned_job(session, job_id)
    if not job:
        return 404, {"error": "that job is not on your books"}
    if job["status"] == "done":
        return 409, {"error": "a completed job cannot be cancelled"}
    if job["status"] == "cancelled":
        return 200, {"job": _fresh_job_dto(job["id"]), "unchanged": True}

    reason = (str((body or {}).get("reason") or "").strip())[:500]
    conn = _conn()
    conn.execute("UPDATE jobs SET status = 'cancelled' WHERE id = ?", (job["id"],))
    conn.commit()
    _log_office_action(job, f"Job {job['id']} ({job['address']}) cancelled "
                            f"by {session['company']['name']}"
                            + (f" — {reason}" if reason else ""))
    return 200, {"job": _fresh_job_dto(job["id"])}


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
