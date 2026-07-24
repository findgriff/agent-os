"""Max Gleam — customer-facing digital sign-off and customer portal.

Two public surfaces, both on the maxgleam database:

  /signoff/<job_id>?t=…   a one-tap sign-off page texted to the customer
                          after a clean is completed
  /customer/login         a light portal where a customer can see their
                          cleans, sign-off history and payments

Neither uses a password. Access is granted by capability:

  * sign-off links carry an HMAC token bound to the job id, so a customer
    can only ever open their own job and the sequential job ids in the URL
    are not guessable;
  * the customer portal issues a signed, expiring token after the caller
    proves they know a job reference AND the email or phone recorded
    against that job's customer.

The signing key lives at SECRET_PATH (0600, generated on first use).
Connections are shared with server.partner so a request thread holds one
maxgleam connection, not two.
"""
from __future__ import annotations
import base64
import hashlib
import hmac
import logging
import os
import re
import secrets
import time
from pathlib import Path

from server import partner, sumup

log = logging.getLogger("agentos.maxgleam")

SECRET_PATH = os.environ.get("MAXGLEAM_SIGNOFF_SECRET", "/var/lib/agent-os/signoff-secret")
PHOTOS_DIR = os.environ.get("MAXGLEAM_PHOTOS", "/var/lib/maxgleam/photos")
PUBLIC_BASE = os.environ.get("MAXGLEAM_PUBLIC_BASE", "").rstrip("/")

PHOTO_MAX_BYTES = 5 * 1024 * 1024
_PHOTO_MAGIC = (b"\xff\xd8\xff", b"\x89PNG")

# A job left unsigned for this long is treated as accepted.
AUTO_APPROVE_HOURS = 24
CUSTOMER_TOKEN_TTL = 7 * 24 * 3600

SIGNOFF_PENDING = ("sent", "pending")


def _conn():
    """The maxgleam connection (shared with the partner portal)."""
    return partner._conn()


def _rows(sql: str, args=()) -> list[dict]:
    return [dict(r) for r in _conn().execute(sql, args).fetchall()]


def _one(sql: str, args=()) -> dict | None:
    r = _conn().execute(sql, args).fetchone()
    return dict(r) if r else None


# ------------------------------------------------------------------ tokens --

_secret_cache: bytes | None = None


def _secret() -> bytes:
    global _secret_cache
    if _secret_cache:
        return _secret_cache
    path = Path(SECRET_PATH)
    try:
        if path.is_file():
            _secret_cache = path.read_bytes().strip()
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            value = secrets.token_hex(32).encode()
            path.write_bytes(value)
            path.chmod(0o600)
            _secret_cache = value
            log.warning("maxgleam: generated sign-off signing key at %s", SECRET_PATH)
    except OSError:
        # Never hand out unsigned links: fall back to a process-lifetime key
        # (links stop working on restart, which is safe-by-default).
        log.exception("maxgleam: could not persist signing key")
        _secret_cache = secrets.token_hex(32).encode()
    return _secret_cache


def _sign(payload: str) -> str:
    digest = hmac.new(_secret(), payload.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")[:32]


def signoff_token(job_id: int) -> str:
    return _sign(f"signoff:{job_id}")


def _valid_signoff_token(job_id: int, token: str) -> bool:
    return hmac.compare_digest(signoff_token(job_id), (token or "").strip())


def customer_token(customer_id: int, expires_at: int | None = None) -> str:
    expires_at = expires_at or int(time.time()) + CUSTOMER_TOKEN_TTL
    body = f"{customer_id}.{expires_at}"
    return f"{body}.{_sign(f'customer:{body}')}"


def customer_for_token(token: str) -> dict | None:
    try:
        cid_s, exp_s, sig = (token or "").split(".")
        cid, exp = int(cid_s), int(exp_s)
    except (ValueError, AttributeError):
        return None
    if not hmac.compare_digest(_sign(f"customer:{cid_s}.{exp_s}"), sig):
        return None
    if exp < int(time.time()):
        return None
    return _one("SELECT * FROM customers WHERE id = ? AND archived = 0", (cid,))


# --------------------------------------------------------------- reference --

def job_ref(job_id: int) -> str:
    """The reference a crew quotes to a customer. Stable and human-readable."""
    return f"MG-{int(job_id):04d}"


def _job_id_from_ref(ref: str) -> int | None:
    m = re.match(r"^\s*(?:MG[-\s]?)?0*(\d{1,9})\s*$", (ref or ""), re.I)
    return int(m.group(1)) if m else None


def signoff_url(job_id: int) -> str:
    return f"{PUBLIC_BASE}/signoff/{job_id}?t={signoff_token(job_id)}"


# ---------------------------------------------------------------- sign-off --

_JOB_SELECT = """
  SELECT j.id, j.scheduled_date, j.status, j.price_pence, j.completed_at,
         j.signoff_status, j.signoff_at, j.signoff_note, j.notes,
         j.partner_company_id, j.tenant_id,
         p.address, p.postcode, p.partner_company_id AS prop_partner_id,
         c.id AS customer_id, c.name AS customer_name, c.phone AS customer_phone,
         c.email AS customer_email,
         s.name AS crew_name,
         pc.name AS partner_name, pc.contact_phone AS partner_phone,
         pc.contact_email AS partner_email
    FROM jobs j
    JOIN properties p ON p.id = j.property_id
    LEFT JOIN customers c ON c.id = p.customer_id
    LEFT JOIN subcontractors s ON s.id = j.subcontractor_id
    LEFT JOIN partner_companies pc
           ON pc.id = COALESCE(j.partner_company_id, p.partner_company_id)
"""


def _rating_of(note: str | None) -> int | None:
    """Ratings ride along in signoff_note as a leading [n/5] tag.

    The live jobs table has no rating column and it belongs to another
    running application, so the star rating is encoded in the note rather
    than migrating maxgleam's schema underneath it.
    """
    m = re.match(r"^\[(\d)/5\]", (note or "").strip())
    return int(m.group(1)) if m else None


def _note_body(note: str | None) -> str:
    return re.sub(r"^\[\d/5\]\s*", "", (note or "").strip())


def _signoff_dto(j: dict, include_contact: bool = False) -> dict:
    out = {
        "job_id": j["id"],
        "ref": job_ref(j["id"]),
        "address": j["address"],
        "postcode": j["postcode"],
        "scheduled_date": j["scheduled_date"],
        "completed_at": j["completed_at"],
        "status": j["status"],
        "signoff_status": j["signoff_status"],
        "signoff_at": j["signoff_at"],
        "signoff_note": _note_body(j["signoff_note"]),
        "rating": _rating_of(j["signoff_note"]),
        "price_pence": j["price_pence"] or 0,
        "crew_name": j["crew_name"],
        "customer_name": j["customer_name"],
        "company_name": j["partner_name"] or "Max Gleam",
        "photos": _rows("SELECT id, kind, caption FROM photos WHERE job_id = ? ORDER BY id",
                        (j["id"],)),
    }
    if include_contact:
        out["company_phone"] = j["partner_phone"]
        out["company_email"] = j["partner_email"]
    return out


def get_signoff(job_id: int, token: str) -> tuple[int, dict]:
    if not _valid_signoff_token(job_id, token):
        return 403, {"error": "this sign-off link is not valid"}
    job = _one(_JOB_SELECT + " WHERE j.id = ?", (job_id,))
    if not job:
        return 404, {"error": "job not found"}
    if job["status"] != "done":
        return 409, {"error": "this clean has not been completed yet"}
    return 200, {"job": _signoff_dto(job, include_contact=True),
                 "already_signed": job["signoff_status"] in ("signed", "auto-approved"),
                 "auto_approve_hours": AUTO_APPROVE_HOURS}


def submit_signoff(job_id: int, token: str, body: dict) -> tuple[int, dict]:
    if not _valid_signoff_token(job_id, token):
        return 403, {"error": "this sign-off link is not valid"}
    job = _one(_JOB_SELECT + " WHERE j.id = ?", (job_id,))
    if not job:
        return 404, {"error": "job not found"}
    if job["status"] != "done":
        return 409, {"error": "this clean has not been completed yet"}
    if job["signoff_status"] == "signed":
        return 409, {"error": "this clean has already been signed off",
                     "job": _signoff_dto(job)}

    rating = body.get("rating")
    if rating not in (None, ""):
        try:
            rating = int(rating)
        except (TypeError, ValueError):
            return 400, {"error": "invalid rating"}
        if not 1 <= rating <= 5:
            return 400, {"error": "rating must be between 1 and 5"}
    else:
        rating = None

    note = (str(body.get("note") or "").strip())[:1000]
    stored_note = f"[{rating}/5] {note}".strip() if rating else note

    photo_error = None
    data_url = body.get("photo_data_url") or ""
    if data_url:
        ok, photo_error = _save_photo(job, data_url)
        if not ok and photo_error:
            # A bad photo must not cost the customer their sign-off; record
            # the sign-off and report the photo problem alongside it.
            log.info("signoff photo rejected for job %s: %s", job_id, photo_error)

    now = int(time.time())
    conn = _conn()
    conn.execute("UPDATE jobs SET signoff_status = 'signed', signoff_at = ?, signoff_note = ? "
                 "WHERE id = ?", (now, stored_note or None, job_id))
    conn.commit()

    # Mirror the star rating into jobs.rating for the reviews surface. The
    # [n/5] tag above stays the wire format the other maxgleam application
    # parses, so this is a dual write, not a migration.
    try:
        from server import maxgleam_reviews
        maxgleam_reviews.set_rating(job_id, rating)
    except Exception:                                   # noqa: BLE001
        log.exception("maxgleam: could not mirror rating for job %s", job_id)

    try:
        conn.execute(
            "INSERT INTO comms_log (tenant_id, customer_id, kind, content) VALUES (?,?,?,?)",
            (job["tenant_id"], job["customer_id"], "signoff",
             f"{job_ref(job_id)} signed off by customer"
             + (f" — {rating}/5" if rating else "")))
        conn.commit()
    except Exception:                                   # noqa: BLE001
        log.exception("maxgleam: could not write comms_log for %s", job_id)

    # Sign-off is what makes the crew's commission earnable, so accrue it now
    # rather than waiting for someone to open the commissions tab. Best-effort:
    # the sweep behind that tab picks up anything missed here.
    from server import maxgleam_commissions
    maxgleam_commissions.accrue_quietly(job["tenant_id"])

    fresh = _one(_JOB_SELECT + " WHERE j.id = ?", (job_id,))
    return 200, {"job": _signoff_dto(fresh), "photo_error": photo_error}


def _save_photo(job: dict, data_url: str) -> tuple[bool, str | None]:
    """Store a customer photo the same way the maxgleam crew app does."""
    if "," not in data_url:
        return False, "photo could not be read"
    try:
        raw = base64.b64decode(data_url.split(",", 1)[1], validate=True)
    except Exception:                                   # noqa: BLE001
        return False, "photo could not be read"
    if len(raw) > PHOTO_MAX_BYTES:
        return False, "photo too large (5MB max)"
    if not raw.startswith(_PHOTO_MAGIC):
        return False, "only JPEG or PNG photos"
    rel = f"{job['tenant_id']}/{job['id']}/{secrets.token_hex(8)}.jpg"
    try:
        dest = Path(PHOTOS_DIR) / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(raw)
    except OSError:
        log.exception("maxgleam: could not write signoff photo")
        return False, "photo could not be saved"
    conn = _conn()
    conn.execute("INSERT INTO photos (tenant_id, job_id, kind, path, caption) VALUES (?,?,?,?,?)",
                 (job["tenant_id"], job["id"], "after", rel, "Customer sign-off photo"))
    conn.commit()
    return True, None


def photo_bytes(photo_id: int) -> tuple[bytes, str] | None:
    row = _one("SELECT path FROM photos WHERE id = ?", (photo_id,))
    if not row:
        return None
    target = (Path(PHOTOS_DIR) / row["path"]).resolve()
    if not str(target).startswith(str(Path(PHOTOS_DIR).resolve())) or not target.is_file():
        return None
    data = target.read_bytes()
    ctype = "image/png" if data.startswith(b"\x89PNG") else "image/jpeg"
    return data, ctype


# ------------------------------------------------------- sign-off dashboard --

def signoff_status(company_id: int | None = None) -> tuple[int, dict]:
    """Pending / overdue / signed counts, optionally scoped to one partner."""
    now = int(time.time())
    cutoff = now - AUTO_APPROVE_HOURS * 3600
    where = " WHERE j.status = 'done'"
    args: list = []
    if company_id is not None:
        where += " AND (j.partner_company_id = ? OR p.partner_company_id = ?)"
        args += [company_id, company_id]

    jobs = _rows(_JOB_SELECT + where + " ORDER BY j.completed_at DESC, j.id DESC LIMIT 300",
                 tuple(args))

    pending, overdue, signed, auto = [], [], [], []
    for j in jobs:
        dto = _signoff_dto(j)
        dto["signoff_url"] = signoff_url(j["id"])
        status = j["signoff_status"]
        if status == "signed":
            signed.append(dto)
        elif status == "auto-approved":
            auto.append(dto)
        else:
            # Not yet signed: overdue once it is past the auto-approve window.
            reference = j["completed_at"] or 0
            (overdue if reference and reference < cutoff else pending).append(dto)

    ratings = [d["rating"] for d in signed if d["rating"]]
    return 200, {
        "pending": pending,
        "overdue": overdue,
        "signed": signed[:100],
        "auto_approved": auto[:100],
        "summary": {
            "pending": len(pending), "overdue": len(overdue),
            "signed": len(signed), "auto_approved": len(auto),
            "average_rating": round(sum(ratings) / len(ratings), 2) if ratings else None,
            "rated": len(ratings),
            "auto_approve_hours": AUTO_APPROVE_HOURS,
        },
    }


def send_signoff_link(job_id: int, company_id: int | None = None) -> tuple[int, dict]:
    """Text the customer their sign-off link. Used by the crew/partner UI."""
    job = _one(_JOB_SELECT + " WHERE j.id = ?", (job_id,))
    if not job:
        return 404, {"error": "job not found"}
    if company_id is not None and company_id not in (
            job["partner_company_id"], job["prop_partner_id"]):
        return 403, {"error": "that job belongs to another company"}
    if job["status"] != "done":
        return 409, {"error": "complete the clean before requesting a sign-off"}
    if job["signoff_status"] == "signed":
        return 409, {"error": "already signed off"}
    phone = (job["customer_phone"] or "").strip()
    if not phone:
        return 400, {"error": "no mobile number on file for this customer"}
    if not PUBLIC_BASE:
        return 503, {"error": "MAXGLEAM_PUBLIC_BASE is not configured — "
                              "the SMS would contain a link that goes nowhere"}

    body = (f"{job['partner_name'] or 'Max Gleam'}: your clean at "
            f"{job['address']} is done. Please confirm you're happy: "
            f"{signoff_url(job_id)}")
    status, error = _send_sms(phone, body)

    conn = _conn()
    if status in ("sent", "dry_run") and job["signoff_status"] not in ("signed", "auto-approved"):
        conn.execute("UPDATE jobs SET signoff_status = 'sent' WHERE id = ?", (job_id,))
    try:
        conn.execute(
            "INSERT INTO comms_log (tenant_id, customer_id, kind, content) VALUES (?,?,?,?)",
            (job["tenant_id"], job["customer_id"], "signoff_link",
             f"Sign-off link {status} to {phone} for {job_ref(job_id)}"))
    except Exception:                                   # noqa: BLE001
        log.exception("maxgleam: comms_log write failed")
    conn.commit()

    if status == "failed":
        return 502, {"error": f"could not send the text: {error}"}
    return 200, {"ok": True, "status": status, "to": phone, "url": signoff_url(job_id)}


def _send_sms(to_number: str, body: str) -> tuple[str, str | None]:
    """ClickSend send, reusing the KS module's transport and dry-run switch."""
    from server import ks
    return ks._send_sms(to_number, body)


def auto_approve(now: int | None = None) -> dict:
    """Mark unsigned completed jobs older than the window as auto-approved."""
    now = now or int(time.time())
    cutoff = now - AUTO_APPROVE_HOURS * 3600
    stale = _rows(
        "SELECT id FROM jobs WHERE status = 'done' AND completed_at IS NOT NULL "
        "  AND completed_at < ? "
        "  AND (signoff_status IS NULL OR signoff_status IN ('sent','pending'))",
        (cutoff,))
    if not stale:
        return {"auto_approved": 0, "ids": []}
    conn = _conn()
    ids = [j["id"] for j in stale]
    conn.executemany(
        "UPDATE jobs SET signoff_status = 'auto-approved', signoff_at = ? WHERE id = ?",
        [(now, i) for i in ids])
    conn.commit()
    log.info("maxgleam: auto-approved %d job(s)", len(ids))

    # Auto-approval earns commission exactly as a customer signature does.
    from server import maxgleam_commissions
    maxgleam_commissions.accrue_quietly()

    return {"auto_approved": len(ids), "ids": ids}


# -------------------------------------------------------- customer portal ---

def _digits(value: str) -> str:
    return re.sub(r"\D", "", value or "")


def customer_login(body: dict) -> tuple[int, dict]:
    """Prove ownership with a job reference plus the email or phone on file.

    Most Max Gleam customers have a mobile on record but no email address,
    so either identifier is accepted — requiring email alone would lock out
    almost the whole book.
    """
    identifier = (body.get("email") or body.get("identifier") or body.get("phone") or "").strip()
    ref = (body.get("ref") or body.get("job_ref") or "").strip()
    job_id = _job_id_from_ref(ref)
    if not identifier or not job_id:
        return 400, {"error": "enter your email or mobile number and a job reference"}

    job = _one(_JOB_SELECT + " WHERE j.id = ?", (job_id,))
    if not job or not job["customer_id"]:
        return 401, {"error": "we could not match those details"}

    email_ok = bool(job["customer_email"]) and identifier.lower() == job["customer_email"].lower()
    typed_digits = _digits(identifier)
    phone_ok = (len(typed_digits) >= 9 and bool(job["customer_phone"])
                and _digits(job["customer_phone"]).endswith(typed_digits[-9:]))
    if not (email_ok or phone_ok):
        return 401, {"error": "we could not match those details"}

    customer = _one("SELECT * FROM customers WHERE id = ?", (job["customer_id"],))
    return 200, {
        "token": customer_token(customer["id"]),
        "customer": {"id": customer["id"], "name": customer["name"],
                     "email": customer["email"], "phone": customer["phone"]},
    }


def customer_jobs(customer: dict) -> tuple[int, dict]:
    rs = _rows(_JOB_SELECT + " WHERE p.customer_id = ? ORDER BY j.scheduled_date DESC LIMIT 200",
               (customer["id"],))
    today = time.strftime("%Y-%m-%d")
    upcoming, past = [], []
    for j in rs:
        dto = _signoff_dto(j, include_contact=True)
        dto["can_sign_off"] = (j["status"] == "done"
                               and j["signoff_status"] not in ("signed", "auto-approved"))
        if dto["can_sign_off"]:
            dto["signoff_url"] = signoff_url(j["id"])
        (upcoming if j["status"] == "scheduled" and j["scheduled_date"] >= today else past).append(dto)
    return 200, {"upcoming": upcoming, "past": past,
                 "customer": {"name": customer["name"], "email": customer["email"],
                              "phone": customer["phone"]}}


_INVOICE_SELECT = """
  SELECT i.id, i.number, i.amount_pence, i.vat_pence, i.status, i.method,
         i.issued_at, i.paid_at, i.sumup_checkout_id, i.sumup_checkout_url,
         i.tenant_id, j.scheduled_date, p.address
    FROM invoices i
    LEFT JOIN jobs j ON j.id = i.job_id
    LEFT JOIN properties p ON p.id = j.property_id
"""


def customer_payments(customer: dict) -> tuple[int, dict]:
    """Everything owed, everything paid, and what is booked in next.

    Any invoice carrying a SumUp checkout is re-checked first, so a customer
    coming back from the SumUp page sees "Paid" rather than being invited to
    pay a second time.
    """
    synced = _sync_checkouts(customer)

    rs = _rows(_INVOICE_SELECT +
               " WHERE i.customer_id = ? AND i.status != 'void'"
               " ORDER BY i.issued_at DESC LIMIT 200", (customer["id"],))
    due = [r for r in rs if r["status"] == "unpaid"]
    history = [r for r in rs if r["status"] == "paid"]

    # Cleans that are booked but not yet invoiced — what is coming, and what
    # it will cost. Priced from the job, which is what the invoice will use.
    today = time.strftime("%Y-%m-%d")
    upcoming = _rows(
        "SELECT j.id AS job_id, j.scheduled_date, j.price_pence, p.address, p.postcode "
        "  FROM jobs j "
        "  JOIN properties p ON p.id = j.property_id "
        "  LEFT JOIN invoices i ON i.job_id = j.id AND i.status != 'void' "
        " WHERE p.customer_id = ? AND j.status = 'scheduled' "
        "   AND j.scheduled_date >= ? AND i.id IS NULL "
        " ORDER BY j.scheduled_date LIMIT 20", (customer["id"], today))

    tenant = _tenant_of(customer)
    return 200, {
        "invoices": rs,                       # kept for the older portal tab
        "due": due,
        "history": history,
        "upcoming": upcoming,
        "summary": {
            "paid_pence": sum(r["amount_pence"] for r in history),
            "unpaid_pence": sum(r["amount_pence"] for r in due),
            "upcoming_pence": sum(r["price_pence"] or 0 for r in upcoming),
            "count": len(rs),
            "newly_paid": synced,
        },
        "can_pay_online": bool(tenant and tenant.get("sumup_api_key")),
        "currency": (tenant or {}).get("currency") or "GBP",
    }


# ------------------------------------------------------------ card payment --

def _tenant_of(customer: dict) -> dict | None:
    return _one("SELECT * FROM tenants WHERE id = ?", (customer["tenant_id"],))


def _merchant_code(tenant: dict) -> str:
    """The tenant's SumUp merchant code, fetched and cached on first use.

    The column exists but was never populated for the live tenant, and a
    hosted checkout cannot be created without it — so look it up once from
    /v0.1/me rather than making this a manual setup step.
    """
    code = (tenant.get("sumup_merchant_code") or "").strip()
    if code:
        return code
    code = sumup.merchant_code(tenant["sumup_api_key"])
    if code:
        conn = _conn()
        conn.execute("UPDATE tenants SET sumup_merchant_code = ? WHERE id = ?",
                     (code, tenant["id"]))
        conn.commit()
        log.info("maxgleam: cached SumUp merchant code for tenant %s", tenant["id"])
    return code


def _sync_checkouts(customer: dict) -> list[str]:
    """Mark invoices paid whose SumUp checkout has completed. Never raises."""
    tenant = _tenant_of(customer)
    if not tenant or not tenant.get("sumup_api_key"):
        return []
    pending = _rows(
        "SELECT id, number, sumup_checkout_id FROM invoices "
        " WHERE customer_id = ? AND status = 'unpaid' "
        "   AND sumup_checkout_id IS NOT NULL LIMIT 10", (customer["id"],))
    flipped = []
    conn = _conn()
    for inv in pending:
        try:
            ck = sumup.checkout_status(api_key=tenant["sumup_api_key"],
                                       checkout_id=inv["sumup_checkout_id"])
        except sumup.SumUpError as e:
            # SumUp being down must not stop the page rendering.
            log.warning("maxgleam: sumup status failed for %s: %s", inv["number"], e)
            continue
        if ck.get("status") == "PAID":
            conn.execute("UPDATE invoices SET status = 'paid', method = 'sumup_online', "
                         "paid_at = strftime('%s','now') WHERE id = ?", (inv["id"],))
            flipped.append(inv["number"])
    if flipped:
        conn.commit()
        log.info("maxgleam: %d invoice(s) marked paid from SumUp", len(flipped))
    return flipped


def customer_checkout(customer: dict, invoice_id: int) -> tuple[int, dict]:
    """POST /api/maxgleam/customer/pay — a SumUp pay link for one invoice.

    Scoped to the signed-in customer's own invoices; the id in the request is
    never trusted on its own.
    """
    inv = _one(_INVOICE_SELECT + " WHERE i.id = ? AND i.customer_id = ?",
               (invoice_id, customer["id"]))
    if not inv:
        return 404, {"error": "invoice not found"}
    if inv["status"] == "paid":
        return 409, {"error": "this invoice is already paid", "invoice": inv}
    if inv["status"] == "void":
        return 409, {"error": "this invoice has been cancelled"}

    tenant = _tenant_of(customer)
    if not tenant or not tenant.get("sumup_api_key"):
        return 503, {"error": "card payments are not set up — please pay by bank transfer"}

    # An existing link is reused while SumUp still considers it live; a spent
    # or expired one is replaced rather than shown to the customer again.
    if inv["sumup_checkout_id"]:
        try:
            ck = sumup.checkout_status(api_key=tenant["sumup_api_key"],
                                       checkout_id=inv["sumup_checkout_id"])
        except sumup.SumUpError:
            ck = {}
        if ck.get("status") == "PAID":
            conn = _conn()
            conn.execute("UPDATE invoices SET status = 'paid', method = 'sumup_online', "
                         "paid_at = strftime('%s','now') WHERE id = ?", (inv["id"],))
            conn.commit()
            return 409, {"error": "this invoice is already paid"}
        if ck.get("status") == "PENDING" and inv["sumup_checkout_url"]:
            return 200, {"checkout_url": inv["sumup_checkout_url"],
                         "invoice": {"id": inv["id"], "number": inv["number"],
                                     "amount_pence": inv["amount_pence"]}}

    try:
        code = _merchant_code(tenant)
    except sumup.SumUpError as e:
        log.warning("maxgleam: sumup merchant lookup failed: %s", e)
        return 502, {"error": "could not reach the card payment provider — try again shortly"}
    if not code:
        return 503, {"error": "card payments are not set up — please pay by bank transfer"}

    # The reference must be unique per merchant, so a replacement checkout for
    # the same invoice carries a short random suffix.
    reference = f"{tenant['slug']}-{inv['number']}"
    if inv["sumup_checkout_id"]:
        reference = f"{reference}-{secrets.token_hex(3)}"
    redirect = f"{PUBLIC_BASE}/customer/payments?paid={inv['number']}" if PUBLIC_BASE else None

    try:
        ck = sumup.create_hosted_checkout(
            api_key=tenant["sumup_api_key"], merchant_code=code,
            amount_pence=inv["amount_pence"], currency=tenant["currency"] or "GBP",
            reference=reference,
            description=f"{tenant['name']} — {inv['number']}",
            redirect_url=redirect)
    except sumup.SumUpError as e:
        log.warning("maxgleam: sumup checkout failed for %s: %s", inv["number"], e)
        return 502, {"error": "could not start the card payment — try again shortly"}

    url = ck.get("hosted_checkout_url") or ""
    if not url:
        log.warning("maxgleam: sumup returned no hosted_checkout_url for %s", inv["number"])
        return 502, {"error": "could not start the card payment — try again shortly"}

    conn = _conn()
    conn.execute("UPDATE invoices SET sumup_checkout_id = ?, sumup_checkout_url = ? "
                 "WHERE id = ?", (ck.get("id"), url, inv["id"]))
    conn.commit()
    log.info("maxgleam: created SumUp checkout for %s", inv["number"])
    return 200, {"checkout_url": url,
                 "invoice": {"id": inv["id"], "number": inv["number"],
                             "amount_pence": inv["amount_pence"]}}


def customer_contact(customer: dict) -> tuple[int, dict]:
    """The partner company looking after this customer's properties."""
    row = _one(
        "SELECT pc.name, pc.contact_name, pc.contact_email, pc.contact_phone "
        "  FROM properties p "
        "  JOIN partner_companies pc ON pc.id = p.partner_company_id "
        " WHERE p.customer_id = ? AND p.partner_company_id IS NOT NULL LIMIT 1",
        (customer["id"],))
    return 200, {"company": row}
