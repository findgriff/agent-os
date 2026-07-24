"""Max Gleam — mobile crew view.

The surface a cleaner opens on their phone at the start of a round. It runs
against the maxgleam database (/var/lib/maxgleam/app.db), like server.partner
and server.maxgleam_portal, and shares their thread-local connection.

Crews are `subcontractors` rows, not users: they have a phone number and no
password. Sign-in is therefore a one-time code texted to the number already
on file, which proves possession of that handset without adding credentials
to a live database that another application owns:

    POST /api/maxgleam/crew/login  {phone}         → texts a 6-digit code
    POST /api/maxgleam/crew/login  {phone, code}   → returns a crew token

Codes live in memory only. They expire in CODE_TTL seconds and are burned on
first successful use, so a restart at worst costs a crew member one re-send —
cheaper than a table in someone else's schema. The token that comes back is
an HMAC over (crew_id, expiry) signed with the same key as the sign-off links
(server.maxgleam_portal), so nothing new needs provisioning on the box.

Every job route re-checks that the job is actually assigned to the calling
crew, so a valid token for crew A can never touch crew B's round.
"""
from __future__ import annotations

import hmac
import logging
import re
import secrets
import threading
import time

from server import maxgleam_portal, partner

log = logging.getLogger("agentos.maxgleam")

CODE_TTL = 10 * 60              # a texted code is good for ten minutes
CODE_RESEND_SECONDS = 60        # don't let a tap-happy thumb spam ClickSend
CODE_MAX_ATTEMPTS = 5           # wrong guesses before the code is burned
CREW_TOKEN_TTL = 12 * 3600      # a shift, not a fortnight

# Photos from the last N jobs at a property are offered as "what it should
# look like" reference shots.
PROPERTY_PHOTO_LIMIT = 12


def _conn():
    return partner._conn()


def _rows(sql: str, args=()) -> list[dict]:
    return [dict(r) for r in _conn().execute(sql, args).fetchall()]


def _one(sql: str, args=()) -> dict | None:
    r = _conn().execute(sql, args).fetchone()
    return dict(r) if r else None


def _digits(value: str) -> str:
    return re.sub(r"\D", "", value or "")


# ------------------------------------------------------------------ tokens --

def crew_token(crew_id: int, expires_at: int | None = None) -> str:
    expires_at = expires_at or int(time.time()) + CREW_TOKEN_TTL
    body = f"{crew_id}.{expires_at}"
    return f"{body}.{maxgleam_portal._sign(f'crew:{body}')}"


def crew_for_token(token: str) -> dict | None:
    try:
        cid_s, exp_s, sig = (token or "").split(".")
        cid, exp = int(cid_s), int(exp_s)
    except (ValueError, AttributeError):
        return None
    if not hmac.compare_digest(maxgleam_portal._sign(f"crew:{cid_s}.{exp_s}"), sig):
        return None
    if exp < int(time.time()):
        return None
    return _one("SELECT * FROM subcontractors WHERE id = ? AND active = 1", (cid,))


def _crew_dto(crew: dict) -> dict:
    return {"id": crew["id"], "name": crew["name"], "phone": crew["phone"],
            "company_name": crew.get("company_name")}


# ------------------------------------------------------------- sign-in code --

_codes: dict[int, dict] = {}
_codes_lock = threading.Lock()


def _crew_by_phone(phone: str) -> dict | None:
    """Match a typed number against the crew list on its last 9 digits.

    Numbers are stored inconsistently in this book ("07700 900123",
    "+447454128780"), so comparing the national significant digits is the
    only match that works across both forms.
    """
    typed = _digits(phone)
    if len(typed) < 9:
        return None
    tail = typed[-9:]
    for crew in _rows("SELECT * FROM subcontractors WHERE active = 1 AND phone IS NOT NULL"):
        if _digits(crew["phone"]).endswith(tail):
            return crew
    return None


def request_code(body: dict) -> tuple[int, dict]:
    phone = (body.get("phone") or "").strip()
    crew = _crew_by_phone(phone)
    # Deliberately vague: this endpoint is public, so it must not confirm
    # which numbers belong to a crew member.
    generic = {"ok": True, "sent": True,
               "message": "If that number is on the crew list, a code is on its way."}
    if not crew:
        log.info("maxgleam crew: sign-in code requested for unknown number %r", phone[-4:])
        return 200, generic

    now = int(time.time())
    with _codes_lock:
        existing = _codes.get(crew["id"])
        if existing and now - existing["sent_at"] < CODE_RESEND_SECONDS:
            return 429, {"error": "a code was just sent — wait a moment before asking for another"}
        code = f"{secrets.randbelow(1000000):06d}"
        _codes[crew["id"]] = {"code": code, "expires": now + CODE_TTL,
                              "sent_at": now, "attempts": 0}

    status, error = _send_sms(
        crew["phone"], f"Max Gleam: your crew sign-in code is {code}. "
                       f"It expires in {CODE_TTL // 60} minutes.")
    if status == "failed":
        with _codes_lock:
            _codes.pop(crew["id"], None)
        log.warning("maxgleam crew: could not text sign-in code: %s", error)
        return 502, {"error": "could not send the code — call the office"}

    out = dict(generic)
    if status == "dry_run":
        # KS_SMS_DRY_RUN is on: no text goes anywhere, so hand the code back
        # or the crew view would be impossible to open on this box.
        out["dry_run"] = True
        out["code"] = code
    return 200, out


def verify_code(body: dict) -> tuple[int, dict]:
    phone = (body.get("phone") or "").strip()
    typed = _digits(body.get("code") or "")
    crew = _crew_by_phone(phone)
    if not crew or not typed:
        return 401, {"error": "that code is not right"}

    now = int(time.time())
    with _codes_lock:
        pending = _codes.get(crew["id"])
        if not pending or pending["expires"] < now:
            _codes.pop(crew["id"], None)
            return 401, {"error": "that code has expired — ask for a new one"}
        pending["attempts"] += 1
        if pending["attempts"] > CODE_MAX_ATTEMPTS:
            _codes.pop(crew["id"], None)
            return 429, {"error": "too many wrong codes — ask for a new one"}
        if not hmac.compare_digest(pending["code"], typed):
            return 401, {"error": "that code is not right"}
        _codes.pop(crew["id"], None)          # single use

    log.info("maxgleam crew: %s signed in", crew["name"])
    return 200, {"token": crew_token(crew["id"]), "crew": _crew_dto(crew)}


def login(body: dict) -> tuple[int, dict]:
    """POST /api/maxgleam/crew/login — request a code, or exchange one."""
    if (body.get("code") or "").strip():
        return verify_code(body)
    return request_code(body)


def _send_sms(to_number: str, text: str) -> tuple[str, str | None]:
    from server import ks
    return ks._send_sms(to_number, text)


# -------------------------------------------------------------- today's run --

_JOB_SELECT = """
  SELECT j.id, j.tenant_id, j.scheduled_date, j.status, j.price_pence,
         j.notes, j.started_at, j.completed_at, j.signoff_status,
         j.subcontractor_id, j.partner_company_id,
         p.id AS property_id, p.address, p.postcode, p.access_notes,
         p.latitude, p.longitude, p.position, p.frequency_weeks,
         p.partner_company_id AS prop_partner_id,
         c.id AS customer_id, c.name AS customer_name, c.phone AS customer_phone,
         c.notes AS customer_notes
    FROM jobs j
    JOIN properties p ON p.id = j.property_id
    LEFT JOIN customers c ON c.id = p.customer_id
"""


def _maps_url(job: dict) -> str:
    """A tap-to-navigate link. Coordinates when we have them (they cannot be
    mis-geocoded), otherwise the postal address."""
    if job.get("latitude") is not None and job.get("longitude") is not None:
        query = f"{job['latitude']},{job['longitude']}"
    else:
        query = ", ".join(x for x in (job.get("address"), job.get("postcode")) if x)
    from urllib.parse import quote
    return f"https://www.google.com/maps/dir/?api=1&destination={quote(query)}"


def _property_photos(property_id: int) -> list[dict]:
    return _rows(
        "SELECT ph.id, ph.kind, ph.caption, ph.created_at "
        "  FROM photos ph JOIN jobs j ON j.id = ph.job_id "
        " WHERE j.property_id = ? ORDER BY ph.id DESC LIMIT ?",
        (property_id, PROPERTY_PHOTO_LIMIT))


def _job_dto(job: dict) -> dict:
    return {
        "job_id": job["id"],
        "ref": maxgleam_portal.job_ref(job["id"]),
        "property_id": job["property_id"],
        "address": job["address"],
        "postcode": job["postcode"],
        "status": job["status"],
        "started_at": job["started_at"],
        "completed_at": job["completed_at"],
        "scheduled_date": job["scheduled_date"],
        "price_pence": job["price_pence"] or 0,
        "frequency_weeks": job["frequency_weeks"],
        # What to clean: the job's own note first, falling back to the standing
        # instruction recorded against the customer.
        "job_notes": job["notes"],
        "customer_notes": job["customer_notes"],
        "access_notes": job["access_notes"],
        "customer_name": job["customer_name"],
        "customer_phone": job["customer_phone"],
        "maps_url": _maps_url(job),
        "photos": _property_photos(job["property_id"]),
    }


def today(crew: dict, date: str | None = None) -> tuple[int, dict]:
    """GET /api/maxgleam/crew/today — this crew's round, in route order."""
    date = (date or "").strip() or time.strftime("%Y-%m-%d")
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
        return 400, {"error": "invalid date"}

    rs = _rows(_JOB_SELECT +
               " WHERE j.subcontractor_id = ? AND j.scheduled_date = ?"
               " ORDER BY p.position, j.id", (crew["id"], date))
    jobs = [_job_dto(j) for j in rs]
    done = sum(1 for j in jobs if j["status"] == "done")
    return 200, {
        "crew": _crew_dto(crew),
        "date": date,
        "jobs": jobs,
        "summary": {"total": len(jobs), "done": done,
                    "remaining": len(jobs) - done,
                    "value_pence": sum(j["price_pence"] for j in jobs)},
    }


def _crew_job(crew: dict, job_id) -> dict | None:
    """A job, but only if it belongs to this crew."""
    try:
        job_id = int(job_id)
    except (TypeError, ValueError):
        return None
    return _one(_JOB_SELECT + " WHERE j.id = ? AND j.subcontractor_id = ?",
                (job_id, crew["id"]))


def start_job(crew: dict, body: dict) -> tuple[int, dict]:
    job = _crew_job(crew, body.get("job_id"))
    if not job:
        return 404, {"error": "that job is not on your round"}
    if job["status"] == "done":
        return 409, {"error": "that clean is already marked complete"}
    now = int(time.time())
    conn = _conn()
    conn.execute("UPDATE jobs SET started_at = ? WHERE id = ?", (now, job["id"]))
    conn.commit()

    # Tapping START is the crew saying "I'm on my way", so this is where the
    # customer's heads-up fires. It runs through maxgleam_notify, so every guard
    # there applies: dry-run by default, opt-out tags, and a once-per-(job,
    # trigger) log that makes a double-tap or a stop/restart harmless. A failure
    # here must never cost the crew their START, so it is caught and reported,
    # not raised.
    notified = None
    try:
        from server import maxgleam_notify
        notified = maxgleam_notify.notify_job_by_id(
            job["id"], "job_on_my_way", job["tenant_id"])
    except Exception:                                       # noqa: BLE001
        log.exception("maxgleam crew: on-my-way notify failed for job %s", job["id"])

    return 200, {"job": _job_dto(_crew_job(crew, job["id"])), "notified": notified}


def complete_job(crew: dict, body: dict) -> tuple[int, dict]:
    """POST /api/maxgleam/crew/complete-job — mark done and add notes."""
    job = _crew_job(crew, body.get("job_id"))
    if not job:
        return 404, {"error": "that job is not on your round"}
    if job["status"] == "done":
        return 409, {"error": "that clean is already marked complete"}

    note = (str(body.get("notes") or "").strip())[:1000]
    # Keep whatever the office wrote on the job; append the crew's note.
    combined = "\n".join(x for x in (job["notes"], note) if x) or None

    now = int(time.time())
    conn = _conn()
    conn.execute(
        "UPDATE jobs SET status = 'done', completed_at = ?, notes = ?, "
        "       started_at = COALESCE(started_at, ?) WHERE id = ?",
        (now, combined, now, job["id"]))
    conn.commit()

    try:
        conn.execute(
            "INSERT INTO comms_log (tenant_id, customer_id, kind, content) VALUES (?,?,?,?)",
            (job["tenant_id"], job["customer_id"], "crew_complete",
             f"{maxgleam_portal.job_ref(job['id'])} completed by {crew['name']}"
             + (f" — {note}" if note else "")))
        conn.commit()
    except Exception:                                       # noqa: BLE001
        log.exception("maxgleam crew: comms_log write failed for job %s", job["id"])

    # Completing a clean raises its invoice. maxgleam's own complete-job
    # endpoint does this itself; a crew completing here would otherwise
    # leave the job done and never billed. invoice_job is idempotent, so
    # the two paths can never double-invoice the same job.
    invoice = None
    try:
        from server import maxgleam_invoicing
        row, outcome = maxgleam_invoicing.invoice_job(job["id"], job["tenant_id"])
        if row:
            invoice = {"id": row["id"], "number": row["number"],
                       "amount_pence": row["amount_pence"], "outcome": outcome}
        elif outcome not in ("already invoiced",):
            log.info("maxgleam crew: job %s not invoiced — %s", job["id"], outcome)
    except Exception:                                       # noqa: BLE001
        # Billing must never cost a crew their completed job.
        log.exception("maxgleam crew: auto-invoice failed for job %s", job["id"])

    return 200, {"job": _job_dto(_crew_job(crew, job["id"])), "invoice": invoice}


# ----------------------------------------------------------- issue reports --

def _issue_owner(job: dict) -> tuple[int | None, int | None]:
    """(partner_company_id, submitted_by) for a work request.

    work_requests demands both columns NOT NULL, but a crew member is not a
    users row and some properties carry no partner company. Fall back to the
    tenant's single partner company and its owner user; if the tenant has
    neither, the caller gets a clear error rather than a broken row.
    """
    company_id = job["partner_company_id"] or job["prop_partner_id"]
    if not company_id:
        row = _one("SELECT id FROM partner_companies WHERE tenant_id = ? ORDER BY id LIMIT 1",
                   (job["tenant_id"],))
        company_id = row["id"] if row else None
    owner = _one("SELECT id FROM users WHERE tenant_id = ? AND role = 'owner' ORDER BY id LIMIT 1",
                 (job["tenant_id"],))
    if not owner:
        owner = _one("SELECT id FROM users WHERE tenant_id = ? ORDER BY id LIMIT 1",
                     (job["tenant_id"],))
    return company_id, (owner["id"] if owner else None)


def report_issue(crew: dict, body: dict) -> tuple[int, dict]:
    """POST /api/maxgleam/crew/report-issue — raise a work request from site."""
    job = _crew_job(crew, body.get("job_id"))
    if not job:
        return 404, {"error": "that job is not on your round"}

    description = (str(body.get("description") or body.get("text") or "").strip())[:2000]
    if not description:
        return 400, {"error": "describe what the problem is"}
    priority = (body.get("priority") or "normal").strip().lower()
    if priority not in partner.PRIORITIES:
        priority = "normal"

    company_id, submitted_by = _issue_owner(job)
    if not company_id or not submitted_by:
        return 409, {"error": "this job has no company or office contact to raise an issue with — "
                              "call it in instead"}

    photo_error = None
    photo_id = None
    data_url = body.get("photo_data_url") or ""
    if data_url:
        ok, photo_error = maxgleam_portal._save_photo(job, data_url)
        if ok:
            row = _one("SELECT id FROM photos WHERE job_id = ? ORDER BY id DESC LIMIT 1",
                       (job["id"],))
            photo_id = row["id"] if row else None
        else:
            # A rejected photo must not lose the report: record the issue and
            # tell the crew the photo did not stick.
            log.info("maxgleam crew: issue photo rejected for job %s: %s", job["id"], photo_error)

    title = f"Crew issue at {job['address']}"[:200]
    conn = _conn()
    cur = conn.execute(
        "INSERT INTO work_requests (tenant_id, partner_company_id, submitted_by, property_id, "
        "                           title, description, service_type, priority, status, job_id, notes) "
        "VALUES (?,?,?,?,?,?,?,?,'pending',?,?)",
        (job["tenant_id"], company_id, submitted_by, job["property_id"], title,
         description, "other", priority, job["id"],
         f"Reported from the crew app by {crew['name']}"))
    conn.commit()
    request_id = cur.lastrowid

    try:
        conn.execute(
            "INSERT INTO comms_log (tenant_id, customer_id, kind, content) VALUES (?,?,?,?)",
            (job["tenant_id"], job["customer_id"], "crew_issue",
             f"{crew['name']} reported an issue at {job['address']}: {description[:200]}"))
        conn.commit()
    except Exception:                                       # noqa: BLE001
        log.exception("maxgleam crew: comms_log write failed for issue on job %s", job["id"])

    log.info("maxgleam crew: %s raised work request %s for job %s",
             crew["name"], request_id, job["id"])
    return 200, {"ok": True, "work_request_id": request_id, "photo_id": photo_id,
                 "photo_error": photo_error}
