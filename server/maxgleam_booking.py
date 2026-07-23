"""Max Gleam — client self-serve booking.

The public surface at /book. A customer types their postcode, picks a service
and a date, and a job lands in the round with status='requested' for the
office to confirm.

Three deliberate constraints shape this module:

  * It only books *known* properties. Postcode lookup matches the existing
    `properties` book, so a booking always attaches to a real address with a
    real price and a real round position. Winning brand-new customers is a
    sales job, not a form — an unknown postcode is told to call instead.

  * 'requested' is a new job status. Everything else in maxgleam reads
    scheduled|done|skipped|missed, so a requested job is invisible to the
    crew round (which selects on scheduled_date + subcontractor_id, and a
    requested job has no crew) until someone in the office confirms it.

  * The partner who services that property is told, through the same
    `work_requests` queue they already watch. No new notification surface.

Rate limiting is per-IP and in memory: a restart at worst gives a spammer a
fresh window, which is cheaper than a table for something this cheap to redo.
"""
from __future__ import annotations

import logging
import re
import threading
import time

from server import maxgleam_notify, maxgleam_portal, partner

log = logging.getLogger("agentos.maxgleam")

DEFAULT_TENANT_ID = maxgleam_notify.DEFAULT_TENANT_ID

# How far ahead the form offers, and how much work fits in one day. The cap
# counts jobs already committed for that date (scheduled + requested), so the
# form stops offering a day the round cannot absorb.
BOOKING_DAYS = 14
DAILY_CAPACITY = 12
LEAD_DAYS = 1                    # nothing bookable for today — vans are loaded
CLOSED_WEEKDAYS = {6}            # Sunday (Monday=0)

# Services offered on the public form. The multiplier applies to the
# property's standing clean price; the floor stops a £20 round price turning
# into a £20 deep clean.
SERVICES = {
    "standard_clean": {"label": "Standard clean", "multiplier": 1.2, "floor_pence": 2500,
                       "blurb": "Exterior windows, frames and sills."},
    "deep_clean":     {"label": "Deep clean", "multiplier": 2.5, "floor_pence": 6000,
                       "blurb": "Full restorative clean, inside and out."},
    "window_clean":   {"label": "Window clean", "multiplier": 1.0, "floor_pence": 2000,
                       "blurb": "Your usual round clean, on a date you pick."},
}

# Per-IP throttle on the write endpoint.
BOOKING_WINDOW = 3600
BOOKING_MAX_PER_WINDOW = 5

_ip_log: dict[str, list[float]] = {}
_ip_lock = threading.Lock()
_local = threading.local()


def _conn():
    conn = partner._conn()
    if not getattr(_local, "schema_ready", False):
        _ensure_schema(conn)
        _local.schema_ready = True
    return conn


def _ensure_schema(conn) -> None:
    """Record who booked, which the jobs table has nowhere to put.

    A requested job carries the booker's own name and number, which may differ
    from the account holder on the property (a tenant booking their landlord's
    house, an adult child booking for a parent). Overwriting the customer
    record with those details would corrupt the round, so they live here.
    """
    conn.execute("""
        CREATE TABLE IF NOT EXISTS booking_requests (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id     INTEGER NOT NULL,
          job_id        INTEGER REFERENCES jobs(id),
          property_id   INTEGER REFERENCES properties(id),
          service       TEXT NOT NULL,
          contact_name  TEXT NOT NULL,
          contact_email TEXT,
          contact_phone TEXT,
          notes         TEXT,
          source_ip     TEXT,
          created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )""")
    conn.execute("""CREATE INDEX IF NOT EXISTS idx_booking_requests_job
                    ON booking_requests(job_id)""")
    conn.commit()


def _rows(sql: str, args=()) -> list[dict]:
    return [dict(r) for r in _conn().execute(sql, args).fetchall()]


def _one(sql: str, args=()) -> dict | None:
    r = _conn().execute(sql, args).fetchone()
    return dict(r) if r else None


# ── Postcode + pricing ──────────────────────────────────────────────

def _norm_postcode(value: str) -> str:
    """Compare postcodes on their letters and digits only.

    The book holds "CH2 4BD", people type "ch24bd". Neither is wrong, so
    neither is what we match on.
    """
    return re.sub(r"[^A-Z0-9]", "", (value or "").upper())


def _outward(value: str) -> str:
    """The postcode district — 'CH2' from 'CH2 4BD'. Used as the fallback
    search when a full postcode finds nothing."""
    norm = _norm_postcode(value)
    m = re.match(r"^([A-Z]{1,2}\d{1,2}[A-Z]?)", norm)
    return m.group(1) if m else norm


def price_for(property_row: dict, service: str) -> int:
    spec = SERVICES[service]
    base = int(property_row.get("price_pence") or 0)
    return max(int(round(base * spec["multiplier"])), spec["floor_pence"])


def _property_dto(p: dict) -> dict:
    return {
        "property_id": p["id"],
        "address": p["address"],
        "postcode": p["postcode"],
        "prices": {key: price_for(p, key) for key in SERVICES},
    }


# ── Slots ───────────────────────────────────────────────────────────

def _date_at(days_ahead: int) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(time.time() + days_ahead * 86400))


def _weekday(iso: str) -> int:
    return time.strptime(iso, "%Y-%m-%d").tm_wday


def _committed_by_date(tenant_id: int, dates: list[str]) -> dict[str, int]:
    """How many jobs are already on the book for each candidate date."""
    if not dates:
        return {}
    marks = ",".join("?" * len(dates))
    rs = _rows(
        f"SELECT scheduled_date, COUNT(*) AS n FROM jobs "
        f" WHERE tenant_id = ? AND scheduled_date IN ({marks}) "
        f"   AND status IN ('scheduled','requested') GROUP BY scheduled_date",
        (tenant_id, *dates))
    return {r["scheduled_date"]: r["n"] for r in rs}


def _slots(tenant_id: int) -> list[dict]:
    """The next BOOKING_DAYS days, each marked open or full."""
    candidates = [_date_at(d) for d in range(LEAD_DAYS, LEAD_DAYS + BOOKING_DAYS)]
    committed = _committed_by_date(tenant_id, candidates)
    out = []
    for iso in candidates:
        wday = _weekday(iso)
        booked = committed.get(iso, 0)
        closed = wday in CLOSED_WEEKDAYS
        out.append({
            "date": iso,
            "weekday": time.strftime("%a", time.strptime(iso, "%Y-%m-%d")),
            "label": time.strftime("%a %-d %b", time.strptime(iso, "%Y-%m-%d")),
            "available": not closed and booked < DAILY_CAPACITY,
            "remaining": 0 if closed else max(0, DAILY_CAPACITY - booked),
            "reason": "closed" if closed else ("full" if booked >= DAILY_CAPACITY else None),
        })
    return out


def available_slots(postcode: str, tenant_id: int = DEFAULT_TENANT_ID) -> tuple[int, dict]:
    """GET /api/maxgleam/book/available-slots?postcode=X

    Matches the postcode against the property book, exactly first and then by
    district, and returns the matches alongside the bookable dates.
    """
    norm = _norm_postcode(postcode)
    if len(norm) < 3:
        return 400, {"error": "enter your full postcode"}

    rs = _rows(
        "SELECT id, address, postcode, price_pence FROM properties "
        " WHERE tenant_id = ? AND active = 1 AND postcode IS NOT NULL "
        " ORDER BY address", (tenant_id,))

    exact = [p for p in rs if _norm_postcode(p["postcode"]) == norm]
    matches = exact
    matched_on = "postcode"
    if not matches:
        district = _outward(norm)
        matches = [p for p in rs if _outward(p["postcode"]) == district]
        matched_on = "district"

    if not matches:
        return 200, {
            "found": False, "postcode": postcode, "properties": [],
            "slots": [], "services": _services_dto(),
            "message": "We don't cover that postcode yet — call the office and "
                       "we'll see what we can do.",
        }

    return 200, {
        "found": True,
        "postcode": postcode,
        "matched_on": matched_on,
        "properties": [_property_dto(p) for p in matches],
        "slots": _slots(tenant_id),
        "services": _services_dto(),
    }


def _services_dto() -> list[dict]:
    return [{"key": k, "label": v["label"], "blurb": v["blurb"]} for k, v in SERVICES.items()]


# ── Booking ─────────────────────────────────────────────────────────

def _throttled(ip: str) -> bool:
    now = time.time()
    with _ip_lock:
        hits = [t for t in _ip_log.get(ip or "?", []) if now - t < BOOKING_WINDOW]
        if len(hits) >= BOOKING_MAX_PER_WINDOW:
            _ip_log[ip or "?"] = hits
            return True
        hits.append(now)
        _ip_log[ip or "?"] = hits
    return False


def _valid_email(value: str) -> bool:
    return bool(re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", value or ""))


def _notify_partner(job_id: int, prop: dict, service: str, contact: dict,
                    date: str, tenant_id: int) -> int | None:
    """Put the request in front of whoever services that address.

    work_requests demands a company and a submitting user. The property's own
    partner company is the right owner; failing that the tenant's only active
    one. If neither exists the booking still stands — the office sees it in the
    round — so a missing partner must not cost us the job.
    """
    company_id = prop.get("partner_company_id")
    if not company_id:
        row = _one("SELECT id FROM partner_companies WHERE tenant_id = ? AND active = 1 "
                   "ORDER BY id LIMIT 1", (tenant_id,))
        company_id = row["id"] if row else None
    if not company_id:
        return None

    owner = _one("SELECT id FROM users WHERE partner_company_id = ? ORDER BY id LIMIT 1",
                 (company_id,)) or \
        _one("SELECT id FROM users WHERE tenant_id = ? AND role = 'owner' ORDER BY id LIMIT 1",
             (tenant_id,))
    if not owner:
        return None

    label = SERVICES[service]["label"]
    description = (f"Online booking from {contact['name']} for {date}.\n"
                   f"Service: {label}\n"
                   f"Contact: {contact.get('phone') or '—'} / {contact.get('email') or '—'}")
    if contact.get("notes"):
        description += f"\nCustomer note: {contact['notes']}"

    conn = _conn()
    cur = conn.execute(
        "INSERT INTO work_requests (tenant_id, partner_company_id, submitted_by, property_id, "
        "                           title, description, service_type, priority, status, "
        "                           scheduled_date, job_id, notes) "
        "VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?)",
        (tenant_id, company_id, owner["id"], prop["id"],
         f"Booking request — {label} at {prop['address']}"[:200],
         description, "window_cleaning", "normal", date, job_id,
         "Raised automatically by the online booking form"))
    conn.commit()
    return cur.lastrowid


def _confirm_sms(contact: dict, prop: dict, service: str, date: str,
                 price_pence: int, ref: str, tenant_id: int) -> dict:
    """Text the booker their confirmation, through the notify transport so
    MAXGLEAM_NOTIFY_DRY_RUN still governs whether anything leaves the box."""
    phone = (contact.get("phone") or "").strip()
    body = (f"Thanks {contact['name'].split()[0]}! Max Gleam has your request for a "
            f"{SERVICES[service]['label'].lower()} at {prop['address']} on "
            f"{maxgleam_notify._pretty_date(date)} "
            f"(£{price_pence / 100:.2f}). Ref {ref}. "
            f"We'll confirm shortly.")
    status, error = maxgleam_notify._send_sms(phone, body)

    conn = _conn()
    try:
        conn.execute(
            "INSERT INTO comms_log (tenant_id, customer_id, kind, content) VALUES (?,?,?,?)",
            (tenant_id, prop.get("customer_id"), "booking_request",
             f"sms {status} to {phone or '—'}: {body[:160]}"))
        conn.commit()
    except Exception:                                       # noqa: BLE001
        log.exception("maxgleam booking: comms_log write failed for %s", ref)
    return {"status": status, "error": error, "body": body}


def create_booking(body: dict, ip: str = "",
                   tenant_id: int = DEFAULT_TENANT_ID) -> tuple[int, dict]:
    """POST /api/maxgleam/book — create a job with status='requested'."""
    if _throttled(ip):
        return 429, {"error": "too many booking requests from here — call the office"}

    try:
        property_id = int(body.get("property_id"))
    except (TypeError, ValueError):
        return 400, {"error": "choose your address"}

    service = (body.get("service") or "").strip()
    if service not in SERVICES:
        return 400, {"error": "choose a service"}

    date = (body.get("date") or "").strip()
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
        return 400, {"error": "choose a date"}

    name = (body.get("name") or "").strip()[:120]
    email = (body.get("email") or "").strip()[:200]
    phone = (body.get("phone") or "").strip()[:40]
    notes = (body.get("notes") or "").strip()[:500]
    if len(name) < 2:
        return 400, {"error": "tell us your name"}
    if not phone and not email:
        return 400, {"error": "leave a phone number or an email so we can confirm"}
    if email and not _valid_email(email):
        return 400, {"error": "that email address doesn't look right"}
    if phone and len(re.sub(r"\D", "", phone)) < 10:
        return 400, {"error": "that phone number doesn't look right"}

    prop = _one("SELECT * FROM properties WHERE id = ? AND tenant_id = ? AND active = 1",
                (property_id, tenant_id))
    if not prop:
        return 404, {"error": "we don't have that address on the book"}

    # The date has to be one the form actually offered. Re-deriving the slots
    # here rather than trusting the posted date is what stops a hand-rolled
    # POST from booking a Sunday, yesterday, or a day that is already full.
    slot = next((s for s in _slots(tenant_id) if s["date"] == date), None)
    if not slot:
        return 400, {"error": f"we only book up to {BOOKING_DAYS} days ahead"}
    if not slot["available"]:
        return 409, {"error": "that day just filled up — please pick another"}

    dupe = _one("SELECT id FROM jobs WHERE property_id = ? AND scheduled_date = ? "
                "AND status IN ('requested','scheduled')", (property_id, date))
    if dupe:
        return 409, {"error": "there's already a clean booked for that address on that day"}

    price_pence = price_for(prop, service)
    label = SERVICES[service]["label"]
    job_notes = f"{label} — booked online by {name}."
    if notes:
        job_notes += f" Customer note: {notes}"

    conn = _conn()
    cur = conn.execute(
        "INSERT INTO jobs (tenant_id, property_id, scheduled_date, status, price_pence, "
        "                  notes, partner_company_id) VALUES (?,?,?,'requested',?,?,?)",
        (tenant_id, property_id, date, price_pence, job_notes,
         prop.get("partner_company_id")))
    conn.commit()
    job_id = cur.lastrowid

    contact = {"name": name, "email": email, "phone": phone, "notes": notes}
    conn.execute(
        "INSERT INTO booking_requests (tenant_id, job_id, property_id, service, "
        " contact_name, contact_email, contact_phone, notes, source_ip) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (tenant_id, job_id, property_id, service, name, email, phone, notes, ip))
    conn.commit()

    # Fill blanks on the customer record, never overwrite: the booker may not
    # be the account holder, and the round's contact details are load-bearing.
    _backfill_customer(prop.get("customer_id"), email, phone)

    ref = maxgleam_portal.job_ref(job_id)
    try:
        work_request_id = _notify_partner(job_id, prop, service, contact, date, tenant_id)
    except Exception:                                       # noqa: BLE001
        log.exception("maxgleam booking: partner notification failed for job %s", job_id)
        work_request_id = None

    try:
        sms = _confirm_sms(contact, prop, service, date, price_pence, ref, tenant_id)
    except Exception:                                       # noqa: BLE001
        log.exception("maxgleam booking: confirmation sms failed for job %s", job_id)
        sms = {"status": "failed", "error": "sms failed", "body": ""}

    log.info("maxgleam booking: job %s (%s) requested at %s for %s",
             job_id, ref, prop["address"], date)
    return 200, {
        "ok": True,
        "job_id": job_id,
        "ref": ref,
        "status": "requested",
        "date": date,
        "service": service,
        "service_label": label,
        "address": prop["address"],
        "postcode": prop["postcode"],
        "price_pence": price_pence,
        "work_request_id": work_request_id,
        "sms_status": sms["status"],
        "confirmation": (f"Thanks {name.split()[0]} — we've got your request for "
                         f"{label.lower()} on {maxgleam_notify._pretty_date(date)}. "
                         f"The office will confirm shortly."),
    }


def _backfill_customer(customer_id: int | None, email: str, phone: str) -> None:
    if not customer_id:
        return
    cust = _one("SELECT id, email, phone FROM customers WHERE id = ?", (customer_id,))
    if not cust:
        return
    sets, args = [], []
    if email and not (cust["email"] or "").strip():
        sets.append("email = ?")
        args.append(email)
    if phone and not (cust["phone"] or "").strip():
        sets.append("phone = ?")
        args.append(phone)
    if not sets:
        return
    conn = _conn()
    conn.execute(f"UPDATE customers SET {', '.join(sets)} WHERE id = ?", (*args, customer_id))
    conn.commit()


# ── Office side ─────────────────────────────────────────────────────

def pending_bookings(tenant_id: int = DEFAULT_TENANT_ID) -> tuple[int, dict]:
    """GET /api/maxgleam/book/requests — what the office still has to confirm."""
    rs = _rows(
        "SELECT j.id AS job_id, j.scheduled_date, j.price_pence, j.notes, j.created_at, "
        "       p.address, p.postcode, "
        "       b.service, b.contact_name, b.contact_email, b.contact_phone, b.notes AS booking_notes "
        "  FROM jobs j "
        "  JOIN properties p ON p.id = j.property_id "
        "  LEFT JOIN booking_requests b ON b.job_id = j.id "
        " WHERE j.tenant_id = ? AND j.status = 'requested' "
        " ORDER BY j.scheduled_date, j.id", (tenant_id,))
    for r in rs:
        r["ref"] = maxgleam_portal.job_ref(r["job_id"])
        r["service_label"] = SERVICES.get(r.get("service") or "", {}).get("label")
    return 200, {"requests": rs, "count": len(rs)}


def confirm_booking(body: dict, tenant_id: int = DEFAULT_TENANT_ID) -> tuple[int, dict]:
    """POST /api/maxgleam/book/confirm — requested → scheduled, optionally
    assigning the crew who will do it."""
    try:
        job_id = int(body.get("job_id"))
    except (TypeError, ValueError):
        return 400, {"error": "which booking?"}

    job = _one("SELECT * FROM jobs WHERE id = ? AND tenant_id = ?", (job_id, tenant_id))
    if not job:
        return 404, {"error": "no such booking"}
    if job["status"] != "requested":
        return 409, {"error": f"that job is already {job['status']}"}

    crew_id = body.get("subcontractor_id")
    conn = _conn()
    if crew_id:
        try:
            crew_id = int(crew_id)
        except (TypeError, ValueError):
            return 400, {"error": "subcontractor_id must be a number"}
        conn.execute("UPDATE jobs SET status = 'scheduled', subcontractor_id = ? WHERE id = ?",
                     (crew_id, job_id))
    else:
        conn.execute("UPDATE jobs SET status = 'scheduled' WHERE id = ?", (job_id,))
    conn.execute("UPDATE work_requests SET status = 'scheduled' WHERE job_id = ? "
                 "AND status = 'pending'", (job_id,))
    conn.commit()
    log.info("maxgleam booking: job %s confirmed", job_id)
    return 200, {"ok": True, "job_id": job_id, "status": "scheduled"}


def decline_booking(body: dict, tenant_id: int = DEFAULT_TENANT_ID) -> tuple[int, dict]:
    """POST /api/maxgleam/book/decline — turn a request down."""
    try:
        job_id = int(body.get("job_id"))
    except (TypeError, ValueError):
        return 400, {"error": "which booking?"}

    job = _one("SELECT * FROM jobs WHERE id = ? AND tenant_id = ? AND status = 'requested'",
               (job_id, tenant_id))
    if not job:
        return 404, {"error": "no such pending booking"}

    reason = (body.get("reason") or "").strip()[:300]
    notes = f"{job['notes'] or ''}\nDeclined: {reason}".strip() if reason else job["notes"]
    conn = _conn()
    conn.execute("UPDATE jobs SET status = 'skipped', notes = ? WHERE id = ?", (notes, job_id))
    conn.execute("UPDATE work_requests SET status = 'declined' WHERE job_id = ? "
                 "AND status = 'pending'", (job_id,))
    conn.commit()
    log.info("maxgleam booking: job %s declined", job_id)
    return 200, {"ok": True, "job_id": job_id, "status": "skipped"}
