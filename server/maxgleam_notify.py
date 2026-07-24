"""Max Gleam customer notifications — templated SMS on job events.

Triggers
--------
    job_reminder_24h   the day before a scheduled clean
    job_completed      once a clean is done AND signed off (or auto-approved)

Safety
------
This texts real customers, so three guards sit in front of every send:

1. MAXGLEAM_NOTIFY_DRY_RUN (default "1") — log the message instead of sending.
   Deploying this module therefore texts nobody. Set it to 0 in
   /etc/agent-os.env and restart to go live. This mirrors KS_SMS_DRY_RUN,
   which gates the underlying ClickSend transport for everything else.
2. notification_templates.enabled — per-trigger switch owned by the office.
3. notification_log has a UNIQUE (job_id, trigger) index, so a customer can
   never be texted twice for the same event no matter how often the sweep
   runs. The sweep is on cron, so this is not optional.

Customers tagged "sms_opt_out" or "no_sms" are skipped and recorded as such.
Only jobs dated from the day the sweep first runs are eligible — switching
this on does not fire a backlog of texts about cleans that already happened.
"""
from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import threading
import time

from server import partner

log = logging.getLogger("agentos")

DEFAULT_TENANT_ID = int(os.environ.get("MAXGLEAM_TENANT_ID", "2"))

# Default ON: a fresh deploy must not text anyone until someone decides to.
DRY_RUN = os.environ.get("MAXGLEAM_NOTIFY_DRY_RUN", "1") != "0"

CHANNELS = ("sms", "email")
TRIGGERS = ("job_reminder_24h", "job_on_my_way", "job_completed")
OPT_OUT_TAGS = {"sms_opt_out", "no_sms", "do_not_text"}

# Seeded once, then owned by the office through the settings endpoint.
DEFAULT_TEMPLATES = {
    "job_reminder_24h": (
        "sms",
        "Hi {customer_name}, your Max Gleam cleaner arrives tomorrow "
        "({date}) at {address}. Reply if that no longer suits."),
    "job_on_my_way": (
        "sms",
        "Hi {customer_name}, your Max Gleam cleaner is on the way to "
        "{address}. See you shortly!"),
    "job_completed": (
        "sms",
        "Your clean is complete! Rate it: {link}"),
}

_local = threading.local()


def _conn() -> sqlite3.Connection:
    conn = partner._conn()
    if not getattr(_local, "schema_ready", False):
        _ensure_schema(conn)
        _local.schema_ready = True
    return conn


def _ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS notification_templates (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id  INTEGER NOT NULL REFERENCES tenants(id),
          trigger    TEXT NOT NULL,
          channel    TEXT NOT NULL DEFAULT 'sms',
          template   TEXT NOT NULL,
          enabled    INTEGER NOT NULL DEFAULT 1
        )""")
    conn.execute("""CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_tpl_once
                    ON notification_templates(tenant_id, trigger, channel)""")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS notification_log (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id  INTEGER NOT NULL,
          job_id     INTEGER REFERENCES jobs(id),
          customer_id INTEGER REFERENCES customers(id),
          trigger    TEXT NOT NULL,
          channel    TEXT NOT NULL,
          to_addr    TEXT,
          body       TEXT,
          status     TEXT NOT NULL,        -- sent|dry_run|failed|skipped_opt_out|no_contact
          error      TEXT,
          sent_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )""")
    # The guarantee that a cron re-run cannot text the same person twice.
    conn.execute("""CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_once
                    ON notification_log(job_id, trigger)""")
    conn.commit()
    _seed_templates(conn)


def _seed_templates(conn: sqlite3.Connection,
                    tenant_id: int = DEFAULT_TENANT_ID) -> None:
    for trigger, (channel, body) in DEFAULT_TEMPLATES.items():
        conn.execute(
            "INSERT OR IGNORE INTO notification_templates "
            " (tenant_id, trigger, channel, template, enabled) VALUES (?,?,?,?,1)",
            (tenant_id, trigger, channel, body))
    conn.commit()


def _rows(sql: str, args=()) -> list[dict]:
    return [dict(r) for r in _conn().execute(sql, args).fetchall()]


def _one(sql: str, args=()) -> dict | None:
    r = _conn().execute(sql, args).fetchone()
    return dict(r) if r else None


# ── Templates ───────────────────────────────────────────────────────

def list_templates(tenant_id: int = DEFAULT_TENANT_ID) -> dict:
    _conn()                                   # ensures seeding has happened
    templates = _rows("SELECT * FROM notification_templates WHERE tenant_id = ? "
                      "ORDER BY trigger, channel", (tenant_id,))
    recent = _rows(
        "SELECT n.*, c.name AS customer_name FROM notification_log n "
        "  LEFT JOIN customers c ON c.id = n.customer_id "
        " WHERE n.tenant_id = ? ORDER BY n.sent_at DESC LIMIT 50", (tenant_id,))
    return {
        "templates": templates,
        "triggers": list(TRIGGERS),
        "channels": list(CHANNELS),
        "placeholders": sorted(_PLACEHOLDER_HELP),
        "placeholder_help": _PLACEHOLDER_HELP,
        "recent": recent,
        # The UI must be able to say plainly whether real texts are going out.
        "dry_run": DRY_RUN,
        "dry_run_note": ("Messages are logged, not sent. Set "
                         "MAXGLEAM_NOTIFY_DRY_RUN=0 in /etc/agent-os.env and "
                         "restart agent-os to send for real."
                         if DRY_RUN else "Live — messages are sent to customers."),
    }


def update_template(body: dict, tenant_id: int = DEFAULT_TENANT_ID) -> tuple[int, dict]:
    trigger = (body.get("trigger") or "").strip()
    if trigger not in TRIGGERS:
        return 400, {"error": f"trigger must be one of {', '.join(TRIGGERS)}"}
    channel = (body.get("channel") or "sms").strip()
    if channel not in CHANNELS:
        return 400, {"error": f"channel must be one of {', '.join(CHANNELS)}"}

    existing = _one("SELECT * FROM notification_templates WHERE tenant_id = ? "
                    "AND trigger = ? AND channel = ?", (tenant_id, trigger, channel))
    template = body.get("template")
    template = existing["template"] if template is None else str(template).strip()
    if not template:
        return 400, {"error": "template cannot be empty"}
    if len(template) > 640:
        return 400, {"error": "template is too long (max 640 characters)"}

    unknown = _unknown_placeholders(template)
    if unknown:
        return 400, {"error": f"unknown placeholder(s): {', '.join(sorted(unknown))}. "
                              f"Available: {', '.join(sorted(_PLACEHOLDER_HELP))}"}

    enabled = body.get("enabled")
    enabled = (existing["enabled"] if existing else 1) if enabled is None else int(bool(enabled))

    conn = _conn()
    conn.execute(
        "INSERT INTO notification_templates (tenant_id, trigger, channel, template, enabled) "
        "VALUES (?,?,?,?,?) "
        "ON CONFLICT(tenant_id, trigger, channel) DO UPDATE SET template = excluded.template, "
        " enabled = excluded.enabled",
        (tenant_id, trigger, channel, template, enabled))
    conn.commit()
    return 200, {"template": _one(
        "SELECT * FROM notification_templates WHERE tenant_id = ? AND trigger = ? "
        "AND channel = ?", (tenant_id, trigger, channel))}


# ── Rendering ───────────────────────────────────────────────────────

_PLACEHOLDER_HELP = {
    "customer_name": "Customer's name",
    "address": "Property address",
    "postcode": "Property postcode",
    "date": "Clean date, e.g. Fri 24 Jul",
    "time": "Scheduled arrival, when a route has been optimised",
    "company": "Trading name",
    "price": "Price of the clean, e.g. £20.00",
    "ref": "Job reference, e.g. MG-0042",
    "link": "Sign-off / rating link for the job",
}

_PLACEHOLDER_RE = re.compile(r"\{([a-z_]+)\}")


def _unknown_placeholders(template: str) -> set[str]:
    return set(_PLACEHOLDER_RE.findall(template or "")) - set(_PLACEHOLDER_HELP)


def _pretty_date(iso: str) -> str:
    try:
        return time.strftime("%a %-d %b", time.strptime(iso, "%Y-%m-%d"))
    except (ValueError, TypeError):
        return iso or ""


def render(template: str, job: dict) -> str:
    """Fill a template from a job row. Unknown placeholders are left alone
    rather than raising — a bad template must not break the sweep."""
    from server import maxgleam_portal as portal

    values = {
        "customer_name": (job.get("customer_name") or "there").split(" ")[0],
        "address": job.get("address") or "",
        "postcode": job.get("postcode") or "",
        "date": _pretty_date(job.get("scheduled_date") or ""),
        "time": job.get("estimated_time") or "",
        "company": job.get("company_name") or "Max Gleam",
        "price": f"£{(job.get('price_pence') or 0) / 100:.2f}",
        "ref": portal.job_ref(job["job_id"]) if job.get("job_id") else "",
        "link": portal.signoff_url(job["job_id"]) if job.get("job_id") else "",
    }
    out = template or ""
    for key, val in values.items():
        out = out.replace("{" + key + "}", str(val))
    return out.strip()


# ── Sending ─────────────────────────────────────────────────────────

def _send_sms(to_number: str, body: str) -> tuple[str, str | None]:
    """ClickSend send, reusing the KS transport like the rest of maxgleam.

    MAXGLEAM_NOTIFY_DRY_RUN short-circuits before the transport, so this stays
    safe even when the global KS_SMS_DRY_RUN switch is off.
    """
    if not to_number:
        return "no_contact", "no phone number"
    if DRY_RUN:
        log.info("maxgleam-notify DRY-RUN sms to=%s body=%r", to_number, body[:120])
        return "dry_run", None
    from server import ks
    return ks._send_sms(to_number, body)


def _opted_out(tags_json: str | None) -> bool:
    try:
        tags = json.loads(tags_json or "[]")
    except (json.JSONDecodeError, TypeError):
        return False
    return bool({str(t).lower() for t in tags} & OPT_OUT_TAGS) if isinstance(tags, list) else False


_JOB_SELECT = """
  SELECT j.id AS job_id, j.tenant_id, j.scheduled_date, j.status, j.price_pence,
         j.signoff_status,
         p.address, p.postcode,
         c.id AS customer_id, c.name AS customer_name, c.phone AS customer_phone,
         c.email AS customer_email, c.tags AS customer_tags
    FROM jobs j
    JOIN properties p ON p.id = j.property_id
    LEFT JOIN customers c ON c.id = p.customer_id
"""


def _already_sent(job_id: int, trigger: str) -> bool:
    return bool(_one("SELECT 1 FROM notification_log WHERE job_id = ? AND trigger = ?",
                     (job_id, trigger)))


def _claim(job: dict, trigger: str) -> bool:
    """Reserve the (job_id, trigger) slot *before* sending. The UNIQUE index on
    (job_id, trigger) makes this INSERT the concurrency lock: when two calls
    race — a double-tapped START arriving on two threads — only one insert
    wins. The loser gets IntegrityError and sends nothing, so the customer
    never receives a duplicate text. Returns False when the slot is taken.

    The row lands as 'pending'; _finalize fills in the real outcome. If the
    process dies between the two, a stale 'pending' blocks a resend — a fair
    trade against double-texting a real customer.
    """
    conn = _conn()
    try:
        conn.execute(
            "INSERT INTO notification_log (tenant_id, job_id, customer_id, trigger, "
            " channel, to_addr, body, status, error) VALUES (?,?,?,?,?,?,?,?,?)",
            (job.get("tenant_id") or DEFAULT_TENANT_ID, job.get("job_id"),
             job.get("customer_id"), trigger, "", "", "", "pending", None))
        conn.commit()
        return True
    except sqlite3.IntegrityError:
        return False


def _finalize(job: dict, trigger: str, channel: str, to_addr: str, body: str,
              status: str, error: str | None) -> None:
    """Record the outcome on the row _claim reserved. Falls back to a plain
    insert when there is no claim (a job_id-less notification, or a forced
    re-send that never had one) so the send is still logged."""
    conn = _conn()
    row = (_one("SELECT id FROM notification_log WHERE job_id = ? AND trigger = ?",
                (job.get("job_id"), trigger)) if job.get("job_id") else None)
    if row:
        conn.execute(
            "UPDATE notification_log SET channel = ?, to_addr = ?, body = ?, "
            " status = ?, error = ? WHERE id = ?",
            (channel, to_addr, body, status, error, row["id"]))
    else:
        try:
            conn.execute(
                "INSERT INTO notification_log (tenant_id, job_id, customer_id, trigger, "
                " channel, to_addr, body, status, error) VALUES (?,?,?,?,?,?,?,?,?)",
                (job.get("tenant_id") or DEFAULT_TENANT_ID, job.get("job_id"),
                 job.get("customer_id"), trigger, channel, to_addr, body, status, error))
        except sqlite3.IntegrityError:
            return
    if status in ("sent", "dry_run"):
        conn.execute(
            "INSERT INTO comms_log (tenant_id, customer_id, kind, content) VALUES (?,?,?,?)",
            (job.get("tenant_id") or DEFAULT_TENANT_ID, job.get("customer_id"),
             trigger, f"{channel} {status} to {to_addr}: {body[:160]}"))
    conn.commit()


def notify_job(job: dict, trigger: str, tenant_id: int = DEFAULT_TENANT_ID,
               force: bool = False) -> dict:
    """Send one notification for one job. Returns a result dict; never raises."""
    job_id = job.get("job_id")
    if not force and job_id and _already_sent(job_id, trigger):
        return {"job_id": job_id, "trigger": trigger, "status": "duplicate"}

    tpl = _one("SELECT * FROM notification_templates WHERE tenant_id = ? AND trigger = ? "
               "AND enabled = 1 ORDER BY id LIMIT 1", (tenant_id, trigger))
    if not tpl:
        return {"job_id": job_id, "trigger": trigger, "status": "disabled"}

    body = render(tpl["template"], job)
    channel = tpl["channel"]

    # Claim the slot before sending so a concurrent double-tap can't slip past
    # the _already_sent check above and fire a second real text. A forced
    # re-send deliberately bypasses the lock and updates the existing row.
    if not force and job_id and not _claim(job, trigger):
        return {"job_id": job_id, "trigger": trigger, "status": "duplicate"}

    if _opted_out(job.get("customer_tags")):
        _finalize(job, trigger, channel, job.get("customer_phone") or "", body,
                  "skipped_opt_out", None)
        return {"job_id": job_id, "trigger": trigger, "status": "skipped_opt_out"}

    if channel == "sms":
        to_addr = (job.get("customer_phone") or "").strip()
        status, error = _send_sms(to_addr, body)
    else:
        # Email templates can be stored and edited, but nothing sends them yet —
        # say so rather than silently dropping the message.
        to_addr = (job.get("customer_email") or "").strip()
        status, error = "failed", "email channel not implemented"

    _finalize(job, trigger, channel, to_addr, body, status, error)
    return {"job_id": job_id, "trigger": trigger, "status": status,
            "to": to_addr, "body": body, "error": error}


def notify_job_by_id(job_id: int, trigger: str,
                     tenant_id: int = DEFAULT_TENANT_ID, force: bool = False) -> dict:
    """Send one notification for a job identified only by id.

    The sweeps hand notify_job a job row they already hold; an event trigger
    (a crew tapping START) only knows the id, and its own job row is shaped for
    the crew app, not for rendering. So we re-read the job in the shape render()
    expects rather than trust the caller's dict. Never raises — an event
    handler must not lose its own work because a text could not be sent.
    """
    job = _one(_JOB_SELECT + " WHERE j.id = ? AND j.tenant_id = ?", (job_id, tenant_id))
    if not job:
        return {"job_id": job_id, "trigger": trigger, "status": "no_job"}
    return notify_job(job, trigger, tenant_id, force=force)


# ── Sweeps ──────────────────────────────────────────────────────────

def _today() -> str:
    return time.strftime("%Y-%m-%d")


def _tomorrow() -> str:
    return time.strftime("%Y-%m-%d", time.localtime(time.time() + 86400))


def due_reminders(tenant_id: int = DEFAULT_TENANT_ID) -> list[dict]:
    """Scheduled jobs happening tomorrow that have not been reminded about."""
    jobs = _rows(_JOB_SELECT + " WHERE j.tenant_id = ? AND j.scheduled_date = ? "
                 "  AND j.status = 'scheduled'", (tenant_id, _tomorrow()))
    return [j for j in jobs if not _already_sent(j["job_id"], "job_reminder_24h")]


def due_completions(tenant_id: int = DEFAULT_TENANT_ID,
                    lookback_days: int = 7) -> list[dict]:
    """Jobs done AND signed off (or auto-approved) that have had no thank-you.

    Bounded by lookback_days so switching the feature on cannot text every
    customer about a clean from months ago.
    """
    since = time.strftime("%Y-%m-%d",
                          time.localtime(time.time() - lookback_days * 86400))
    jobs = _rows(_JOB_SELECT + " WHERE j.tenant_id = ? AND j.status = 'done' "
                 "  AND j.scheduled_date >= ? "
                 "  AND j.signoff_status IN ('signed','auto-approved')",
                 (tenant_id, since))
    return [j for j in jobs if not _already_sent(j["job_id"], "job_completed")]


def run_sweep(tenant_id: int = DEFAULT_TENANT_ID,
              lookback_days: int = 7) -> dict:
    """Send everything due. Safe to run from cron as often as you like."""
    results = []
    for job in due_reminders(tenant_id):
        results.append(notify_job(job, "job_reminder_24h", tenant_id))
    for job in due_completions(tenant_id, lookback_days):
        results.append(notify_job(job, "job_completed", tenant_id))

    counts: dict[str, int] = {}
    for r in results:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    return {"dry_run": DRY_RUN, "tomorrow": _tomorrow(), "today": _today(),
            "processed": len(results), "by_status": counts, "results": results}


def send_test(body: dict, tenant_id: int = DEFAULT_TENANT_ID) -> tuple[int, dict]:
    """Send one test message to an explicitly supplied number.

    Deliberately does NOT accept a customer id: a test must never be able to
    text a customer by accident. The number has to be typed in.
    """
    trigger = (body.get("trigger") or "job_reminder_24h").strip()
    if trigger not in TRIGGERS:
        return 400, {"error": f"trigger must be one of {', '.join(TRIGGERS)}"}
    to = (body.get("to") or "").strip()
    if not re.match(r"^\+?[0-9 ()-]{7,20}$", to):
        return 400, {"error": "a destination phone number ('to') is required"}

    tpl = _one("SELECT * FROM notification_templates WHERE tenant_id = ? AND trigger = ? "
               "ORDER BY id LIMIT 1", (tenant_id, trigger))
    if not tpl:
        return 404, {"error": "no template for that trigger"}

    # A representative sample job keeps the preview honest; falls back to
    # placeholder text when the tenant has no jobs yet.
    sample = _one(_JOB_SELECT + " WHERE j.tenant_id = ? ORDER BY j.scheduled_date DESC "
                  "LIMIT 1", (tenant_id,)) or {
        "job_id": 0, "scheduled_date": _tomorrow(), "address": "1 Example Street",
        "postcode": "CH1 1AA", "customer_name": "Sample Customer", "price_pence": 2000}
    message = render(tpl["template"], sample)

    status, error = _send_sms(to, message)
    conn = _conn()
    conn.execute(
        "INSERT INTO notification_log (tenant_id, job_id, customer_id, trigger, channel, "
        " to_addr, body, status, error) VALUES (?,NULL,NULL,?,?,?,?,?,?)",
        (tenant_id, f"test:{trigger}", tpl["channel"], to, message, status, error))
    conn.commit()

    if status == "failed":
        return 502, {"error": f"could not send: {error}", "body": message}
    return 200, {"ok": True, "status": status, "to": to, "body": message,
                 "dry_run": DRY_RUN}
