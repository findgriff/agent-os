"""Max Gleam email marketing — campaigns, audiences and the monthly newsletter.

Reads and writes the maxgleam database (/var/lib/maxgleam/app.db), sharing the
thread-local connection with the other maxgleam modules.

Sending
-------
Resend over urllib, same as server.maxgleam_alerts and /opt/maxgleam/server/mail.py.
The key is read from /etc/resend-api-key, falling back to the maxgleam copy —
they are byte-identical today, but the agent-os one is the one this service owns.

Personalisation
---------------
A body may contain {placeholders} which are filled per recipient at send time:
{name} {first_name} {cleans} {last_clean} {next_clean} {total_spent} {balance}
{month} {company}. This is what makes one campaign row able to send 98 different
"your cleaning summary" emails without a row per body.

Unknown placeholders are left verbatim rather than raising — a typo in a subject
line should not strand a campaign mid-send with half the audience emailed.

Dry run
-------
MAXGLEAM_MARKETING_DRY_RUN defaults to "1" (rehearse, never send), matching the
convention server.maxgleam_notify already set. Everything except the outbound
HTTP call runs identically, so a dry run still proves the audience, the render
and the per-recipient rows.
"""
from __future__ import annotations

import html
import json
import os
import re
import sqlite3
import threading
import time
import urllib.request

from server import partner
from server.maxgleam_ops import DEFAULT_TENANT_ID
from server import maxgleam_activity as activity

# This service's own copy of the key; the maxgleam one is the fallback.
RESEND_KEY_PATHS = (
    os.environ.get("MAXGLEAM_RESEND_KEY_PATH", "/etc/resend-api-key"),
    "/etc/maxgleam/resend-api-key",
)
MAIL_FROM = os.environ.get("MAXGLEAM_FROM", "Max Gleam <hello@mail.opspocket.com>")
REPLY_TO = os.environ.get("MAXGLEAM_REPLY_TO", "") or None
BASE_URL = os.environ.get("MAXGLEAM_PUBLIC_BASE", "").rstrip("/")
USER_AGENT = "agent-os-maxgleam-marketing/1.0"

# Safe by default — flip with MAXGLEAM_MARKETING_DRY_RUN=0 in /etc/agent-os.env.
DRY_RUN = os.environ.get("MAXGLEAM_MARKETING_DRY_RUN", "1") != "0"

AUDIENCES = ("all", "cleaned_since", "not_cleaned_since", "unpaid_invoices", "never_cleaned")
STATUSES = ("draft", "sent")

_local = threading.local()


def _conn() -> sqlite3.Connection:
    conn = partner._conn()
    if not getattr(_local, "marketing_schema_ready", False):
        _ensure_schema(conn)
        _local.marketing_schema_ready = True
    return conn


def _ensure_schema(conn: sqlite3.Connection) -> None:
    """Additive only — never alters a column maxgleam already owns."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS email_campaigns (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id  INTEGER NOT NULL,
          name       TEXT NOT NULL,
          subject    TEXT NOT NULL,
          body       TEXT NOT NULL,
          status     TEXT NOT NULL DEFAULT 'draft',
          sent_at    INTEGER,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )""")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS email_recipients (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          campaign_id INTEGER NOT NULL REFERENCES email_campaigns(id),
          customer_id INTEGER REFERENCES customers(id),
          sent        INTEGER NOT NULL DEFAULT 0,
          opened      INTEGER NOT NULL DEFAULT 0,
          clicked     INTEGER NOT NULL DEFAULT 0
        )""")
    # Columns beyond the brief, carried so a send is auditable after the fact:
    # which address it actually went to, and why one failed.
    for ddl in ("ALTER TABLE email_recipients ADD COLUMN email TEXT",
                "ALTER TABLE email_recipients ADD COLUMN error TEXT",
                "ALTER TABLE email_recipients ADD COLUMN sent_at INTEGER",
                "ALTER TABLE email_recipients ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 0",
                "ALTER TABLE email_campaigns ADD COLUMN audience_json TEXT NOT NULL DEFAULT '{}'",
                "ALTER TABLE email_campaigns ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 0"):
        try:
            conn.execute(ddl)
        except sqlite3.OperationalError:
            pass          # already present
    conn.execute("""CREATE INDEX IF NOT EXISTS idx_email_campaigns_tenant
                    ON email_campaigns(tenant_id, created_at)""")
    conn.execute("""CREATE INDEX IF NOT EXISTS idx_email_recipients_campaign
                    ON email_recipients(campaign_id)""")
    conn.commit()


def _rows(sql: str, args=()) -> list[dict]:
    cur = _conn().execute(sql, args)
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def _one(sql: str, args=()) -> dict | None:
    got = _rows(sql, args)
    return got[0] if got else None


def _gbp(pence) -> str:
    return f"£{(pence or 0) / 100:,.2f}"


def _pretty(iso: str | None) -> str:
    if not iso:
        return "—"
    try:
        return time.strftime("%-d %B %Y", time.strptime(iso, "%Y-%m-%d"))
    except ValueError:
        return iso


def _valid_email(addr: str | None) -> bool:
    return bool(addr and re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", addr.strip()))


# ── audiences ───────────────────────────────────────────────────────────

def audience(kind: str = "all", *, tenant_id: int = DEFAULT_TENANT_ID,
             since: str | None = None, days: int | None = None) -> list[dict]:
    """Customers matching an audience filter, each with the figures the
    placeholders need. Archived customers are never included.

    Rows without a usable email address are still returned, flagged
    `emailable: false` — the campaign screen must be able to say "12 of 98
    customers have no email on file" instead of silently shrinking.
    """
    if kind not in AUDIENCES:
        kind = "all"
    if since is None and days:
        since = time.strftime("%Y-%m-%d", time.localtime(time.time() - days * 86400))

    rows = _rows(
        """SELECT c.id, c.name, c.email, c.phone, c.tags,
                  (SELECT MAX(COALESCE(DATE(j.completed_at, 'unixepoch'),
                                       j.scheduled_date))
                     FROM jobs j JOIN properties p ON p.id = j.property_id
                    WHERE p.customer_id = c.id AND j.status = 'done') AS last_clean,
                  (SELECT MIN(j.scheduled_date)
                     FROM jobs j JOIN properties p ON p.id = j.property_id
                    WHERE p.customer_id = c.id AND j.status = 'scheduled'
                      AND j.scheduled_date >= DATE('now')) AS next_clean,
                  (SELECT COUNT(*)
                     FROM jobs j JOIN properties p ON p.id = j.property_id
                    WHERE p.customer_id = c.id AND j.status = 'done') AS cleans,
                  (SELECT COALESCE(SUM(j.price_pence), 0)
                     FROM jobs j JOIN properties p ON p.id = j.property_id
                    WHERE p.customer_id = c.id AND j.status = 'done') AS spent_pence,
                  (SELECT COALESCE(SUM(i.amount_pence), 0) FROM invoices i
                    WHERE i.customer_id = c.id AND i.status = 'unpaid') AS balance_pence
             FROM customers c
            WHERE c.tenant_id = ? AND c.archived = 0
         ORDER BY c.name""", (tenant_id,))

    out = []
    for r in rows:
        keep = True
        if kind == "cleaned_since":
            keep = bool(r["last_clean"] and since and r["last_clean"] >= since)
        elif kind == "not_cleaned_since":
            # No clean at all also counts as "not cleaned since" — those are
            # exactly the lapsed customers a win-back campaign is aimed at.
            keep = not r["last_clean"] or (bool(since) and r["last_clean"] < since)
        elif kind == "never_cleaned":
            keep = not r["last_clean"]
        elif kind == "unpaid_invoices":
            keep = (r["balance_pence"] or 0) > 0
        if not keep:
            continue
        r["emailable"] = _valid_email(r["email"])
        r["tags"] = r["tags"] or "[]"
        out.append(r)
    return out


def audience_summary(kind: str = "all", *, tenant_id: int = DEFAULT_TENANT_ID,
                     since: str | None = None, days: int | None = None) -> dict:
    people = audience(kind, tenant_id=tenant_id, since=since, days=days)
    emailable = [p for p in people if p["emailable"]]
    return {
        "kind": kind, "since": since, "days": days,
        "matched": len(people),
        "emailable": len(emailable),
        "missing_email": len(people) - len(emailable),
        "sample": [{"id": p["id"], "name": p["name"], "email": p["email"],
                    "last_clean": p["last_clean"], "emailable": p["emailable"]}
                   for p in people[:25]],
    }


# ── rendering ───────────────────────────────────────────────────────────

_PLACEHOLDER = re.compile(r"\{([a-z_]+)\}")


def _fields(person: dict, *, month: str = "", company: str = "Max Gleam") -> dict:
    name = (person.get("name") or "there").strip()
    return {
        "name": name,
        "first_name": name.split()[0] if name else "there",
        "cleans": str(person.get("cleans") or 0),
        "last_clean": _pretty(person.get("last_clean")),
        "next_clean": _pretty(person.get("next_clean")),
        "total_spent": _gbp(person.get("spent_pence")),
        "balance": _gbp(person.get("balance_pence")),
        "month": month or time.strftime("%B %Y"),
        "company": company,
    }


def render(template: str, person: dict, **kw) -> str:
    """Fill {placeholders}. Unknown ones are left as written."""
    fields = _fields(person, **kw)
    return _PLACEHOLDER.sub(lambda m: fields.get(m.group(1), m.group(0)), template or "")


def placeholders_in(template: str) -> list[str]:
    return sorted(set(_PLACEHOLDER.findall(template or "")))


KNOWN_PLACEHOLDERS = ("name", "first_name", "cleans", "last_clean", "next_clean",
                      "total_spent", "balance", "month", "company")


def _tracking_html(text: str, recipient_id: int | None) -> str:
    """Plain text → minimal HTML, with open + click tracking woven in.

    The text part stays clean; only the HTML alternative carries the pixel and
    rewritten links, so a plain-text reader sees no tracking clutter.
    """
    body = html.escape(text).replace("\n", "<br>\n")
    if recipient_id and BASE_URL:
        def _wrap(m: re.Match) -> str:
            url = m.group(0)
            # The URL is already HTML-escaped at this point; quote it for the
            # query string so an ampersand in the target cannot split the link.
            from urllib.parse import quote
            tracked = (f"{BASE_URL}/api/maxgleam/email/click"
                       f"?r={recipient_id}&u={quote(html.unescape(url), safe='')}")
            return f'<a href="{tracked}">{url}</a>'
        body = re.sub(r"https?://[^\s<]+", _wrap, body)
        pixel = (f'<img src="{BASE_URL}/api/maxgleam/email/open?r={recipient_id}"'
                 ' width="1" height="1" alt="" style="display:none">')
    else:
        pixel = ""
    return ("<div style=\"font-family:-apple-system,Segoe UI,Roboto,sans-serif;"
            "font-size:15px;line-height:1.6;color:#1a1a1a\">"
            f"{body}{pixel}</div>")


# ── sending ─────────────────────────────────────────────────────────────

def _resend_key() -> str:
    for path in RESEND_KEY_PATHS:
        try:
            with open(path) as fh:
                key = fh.read().strip()
                if key:
                    return key
        except OSError:
            continue
    return ""


def _send_email(to: str, subject: str, text: str, html_body: str | None = None) -> None:
    key = _resend_key()
    if not key:
        raise RuntimeError(f"no Resend API key at {RESEND_KEY_PATHS[0]}")
    payload = {"from": MAIL_FROM, "to": [to], "subject": subject, "text": text}
    if html_body:
        payload["html"] = html_body
    if REPLY_TO:
        payload["reply_to"] = REPLY_TO
    req = urllib.request.Request(
        "https://api.resend.com/emails", data=json.dumps(payload).encode(),
        method="POST",
        headers={"Authorization": f"Bearer {key}",
                 "Content-Type": "application/json", "User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=15):
        pass


# ── campaigns ───────────────────────────────────────────────────────────

def _campaign_dto(c: dict) -> dict:
    stats = _one(
        """SELECT COUNT(*) AS recipients,
                  COALESCE(SUM(sent), 0) AS sent,
                  COALESCE(SUM(opened), 0) AS opened,
                  COALESCE(SUM(clicked), 0) AS clicked,
                  COALESCE(SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END), 0) AS failed
             FROM email_recipients
            WHERE campaign_id = ? AND dry_run = 0""", (c["id"],)) or {}
    try:
        aud = json.loads(c.get("audience_json") or "{}")
    except (TypeError, ValueError):
        aud = {}
    sent = stats.get("sent") or 0
    return {
        "id": c["id"], "name": c["name"], "subject": c["subject"], "body": c["body"],
        "status": c["status"], "sent_at": c["sent_at"], "created_at": c["created_at"],
        "dry_run": bool(c.get("dry_run")),
        "audience": aud,
        "stats": {
            "recipients": stats.get("recipients") or 0,
            "sent": sent,
            "opened": stats.get("opened") or 0,
            "clicked": stats.get("clicked") or 0,
            "failed": stats.get("failed") or 0,
            "open_rate": round(100.0 * (stats.get("opened") or 0) / sent, 1) if sent else 0.0,
            "click_rate": round(100.0 * (stats.get("clicked") or 0) / sent, 1) if sent else 0.0,
        },
    }


def create_campaign(body: dict, tenant_id: int = DEFAULT_TENANT_ID) -> tuple[int, dict]:
    """POST body: {name, subject, body, audience:{kind, since, days}}."""
    name = (body.get("name") or "").strip()
    subject = (body.get("subject") or "").strip()
    text = (body.get("body") or "").strip()
    if not name:
        return 400, {"error": "name is required"}
    if not subject:
        return 400, {"error": "subject is required"}
    if not text:
        return 400, {"error": "body is required"}

    aud = body.get("audience") or {}
    if not isinstance(aud, dict):
        return 400, {"error": "audience must be an object"}
    kind = (aud.get("kind") or "all").strip()
    if kind not in AUDIENCES:
        return 400, {"error": f"audience.kind must be one of: {', '.join(AUDIENCES)}"}
    since = (aud.get("since") or "").strip() or None
    if since and not re.match(r"^\d{4}-\d{2}-\d{2}$", since):
        return 400, {"error": "audience.since must be YYYY-MM-DD"}
    days = aud.get("days")
    if days is not None:
        try:
            days = max(1, min(3650, int(days)))
        except (TypeError, ValueError):
            return 400, {"error": "audience.days must be a number"}

    conn = _conn()
    cur = conn.execute(
        """INSERT INTO email_campaigns
             (tenant_id, name, subject, body, status, audience_json, created_at)
           VALUES (?,?,?,?,'draft',?,?)""",
        (tenant_id, name, subject, text,
         json.dumps({"kind": kind, "since": since, "days": days}), int(time.time())))
    conn.commit()
    cid = cur.lastrowid

    activity.log("campaign_created", tenant_id=tenant_id, actor_type="user",
                 actor_name="Marketing", entity_type="campaign", entity_id=cid,
                 detail=f"{name} — {subject}", meta={"audience": kind})
    return 201, {"campaign": _campaign_dto(
        _one("SELECT * FROM email_campaigns WHERE id = ?", (cid,)))}


def list_campaigns(tenant_id: int = DEFAULT_TENANT_ID,
                   limit: int = 100) -> tuple[int, dict]:
    rows = _rows("""SELECT * FROM email_campaigns WHERE tenant_id = ?
                 ORDER BY created_at DESC, id DESC LIMIT ?""",
                 (tenant_id, max(1, min(500, limit))))
    return 200, {
        "campaigns": [_campaign_dto(c) for c in rows],
        "count": len(rows),
        "dry_run_default": DRY_RUN,
        "mail_configured": bool(_resend_key()),
        "mail_from": MAIL_FROM,
        "audiences": list(AUDIENCES),
        "placeholders": list(KNOWN_PLACEHOLDERS),
    }


def get_campaign(campaign_id: int, tenant_id: int = DEFAULT_TENANT_ID) -> tuple[int, dict]:
    c = _one("SELECT * FROM email_campaigns WHERE id = ? AND tenant_id = ?",
             (campaign_id, tenant_id))
    if not c:
        return 404, {"error": "campaign not found"}
    recips = _rows(
        """SELECT r.id, r.customer_id, r.email, r.sent, r.opened, r.clicked,
                  r.error, r.sent_at, r.dry_run, c.name AS customer_name
             FROM email_recipients r
             LEFT JOIN customers c ON c.id = r.customer_id
            WHERE r.campaign_id = ? ORDER BY r.id LIMIT 500""", (campaign_id,))
    return 200, {"campaign": _campaign_dto(c), "recipients": recips}


def preview(campaign_id: int, tenant_id: int = DEFAULT_TENANT_ID,
            limit: int = 3) -> tuple[int, dict]:
    """The audience, plus the first few emails rendered exactly as they'd send."""
    c = _one("SELECT * FROM email_campaigns WHERE id = ? AND tenant_id = ?",
             (campaign_id, tenant_id))
    if not c:
        return 404, {"error": "campaign not found"}
    try:
        aud = json.loads(c.get("audience_json") or "{}")
    except (TypeError, ValueError):
        aud = {}
    people = audience(aud.get("kind") or "all", tenant_id=tenant_id,
                      since=aud.get("since"), days=aud.get("days"))
    emailable = [p for p in people if p["emailable"]]
    samples = [{
        "customer_id": p["id"], "name": p["name"], "email": p["email"],
        "subject": render(c["subject"], p),
        "body": render(c["body"], p),
    } for p in (emailable or people)[:max(1, min(10, limit))]]

    unknown = [ph for ph in placeholders_in(c["subject"] + " " + c["body"])
               if ph not in KNOWN_PLACEHOLDERS]
    return 200, {
        "campaign": _campaign_dto(c),
        "audience": {"kind": aud.get("kind") or "all", "matched": len(people),
                     "emailable": len(emailable),
                     "missing_email": len(people) - len(emailable)},
        "samples": samples,
        "unknown_placeholders": unknown,
        "mail_configured": bool(_resend_key()),
        "dry_run_default": DRY_RUN,
    }


def send_campaign(campaign_id: int, tenant_id: int = DEFAULT_TENANT_ID, *,
                  dry_run: bool | None = None,
                  limit: int = 1000) -> tuple[int, dict]:
    """Render and send one campaign to its audience.

    A campaign already marked 'sent' is refused rather than re-sent — the
    commonest way to mail a customer list twice is a double-clicked button.
    """
    if dry_run is None:
        dry_run = DRY_RUN
    c = _one("SELECT * FROM email_campaigns WHERE id = ? AND tenant_id = ?",
             (campaign_id, tenant_id))
    if not c:
        return 404, {"error": "campaign not found"}
    if c["status"] == "sent":
        return 409, {"error": "campaign has already been sent",
                     "sent_at": c["sent_at"]}
    if not dry_run and not _resend_key():
        return 503, {"error": f"no Resend API key at {RESEND_KEY_PATHS[0]}"}

    try:
        aud = json.loads(c.get("audience_json") or "{}")
    except (TypeError, ValueError):
        aud = {}
    people = audience(aud.get("kind") or "all", tenant_id=tenant_id,
                      since=aud.get("since"), days=aud.get("days"))
    targets = [p for p in people if p["emailable"]][:limit]
    if not targets:
        return 400, {"error": "nobody in this audience has an email address",
                     "matched": len(people)}

    conn = _conn()
    now = int(time.time())
    sent = failed = 0
    results = []

    for person in targets:
        # Dry-run rows are kept as a record of the rehearsal but flagged, so
        # they never count toward the campaign's sent/open/click figures.
        cur = conn.execute(
            """INSERT INTO email_recipients (campaign_id, customer_id, email, dry_run)
               VALUES (?,?,?,?)""",
            (campaign_id, person["id"], person["email"], 1 if dry_run else 0))
        rid = cur.lastrowid
        subject = render(c["subject"], person)
        text = render(c["body"], person)
        error = None

        if not dry_run:
            try:
                _send_email(person["email"], subject, text,
                            _tracking_html(text, rid))
            except Exception as exc:                  # noqa: BLE001
                error = f"{type(exc).__name__}: {exc}"

        if error:
            failed += 1
            conn.execute("UPDATE email_recipients SET error = ? WHERE id = ?",
                         (error, rid))
        else:
            sent += 1
            conn.execute(
                "UPDATE email_recipients SET sent = ?, sent_at = ? WHERE id = ?",
                (0 if dry_run else 1, now, rid))
        results.append({"customer_id": person["id"], "name": person["name"],
                        "email": person["email"], "error": error})

    # A dry run must not mark the campaign spent — it is a rehearsal, and the
    # draft has to stay sendable afterwards.
    if not dry_run:
        conn.execute("UPDATE email_campaigns SET status = 'sent', sent_at = ? WHERE id = ?",
                     (now, campaign_id))
    conn.commit()

    activity.log("campaign_sent" if not dry_run else "campaign_dry_run",
                 tenant_id=tenant_id, actor_type="user", actor_name="Marketing",
                 entity_type="campaign", entity_id=campaign_id,
                 detail=f'{c["name"]} → {sent} recipient{"" if sent == 1 else "s"}',
                 meta={"sent": sent, "failed": failed, "dry_run": dry_run})

    return 200, {
        "campaign_id": campaign_id, "dry_run": dry_run,
        "audience_matched": len(people), "targeted": len(targets),
        "sent": sent, "failed": failed,
        "skipped_no_email": len(people) - len(targets),
        "results": results[:100],
    }


# ── tracking ────────────────────────────────────────────────────────────

# 1×1 transparent GIF.
PIXEL = (b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!"
         b"\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00"
         b"\x00\x02\x02D\x01\x00;")


def mark_opened(recipient_id: int) -> None:
    try:
        conn = _conn()
        conn.execute("UPDATE email_recipients SET opened = 1 WHERE id = ?",
                     (recipient_id,))
        conn.commit()
    except sqlite3.Error:
        pass          # a tracking pixel must never fail loudly


def mark_clicked(recipient_id: int) -> None:
    try:
        conn = _conn()
        # A click implies an open, even when the pixel was blocked.
        conn.execute("UPDATE email_recipients SET clicked = 1, opened = 1 WHERE id = ?",
                     (recipient_id,))
        conn.commit()
    except sqlite3.Error:
        pass


# ── monthly newsletter ──────────────────────────────────────────────────

NEWSLETTER_BODY = """Hi {first_name},

Here's your cleaning summary for {month}.

  · Cleans completed with us : {cleans}
  · Last clean               : {last_clean}
  · Next scheduled clean     : {next_clean}
  · Outstanding balance      : {balance}

Thanks for being a customer — if anything needs sorting before your next
visit, just reply to this email and we'll pick it up.

{company}
"""


def _month_label(month: str | None) -> tuple[str, str]:
    """(YYYY-MM, 'July 2026') for the given month, defaulting to last month."""
    if month:
        try:
            t = time.strptime(month, "%Y-%m")
            return month, time.strftime("%B %Y", t)
        except ValueError:
            pass
    lt = time.localtime()
    year, mon = (lt.tm_year, lt.tm_mon - 1) if lt.tm_mon > 1 else (lt.tm_year - 1, 12)
    key = f"{year:04d}-{mon:02d}"
    return key, time.strftime("%B %Y", time.strptime(key, "%Y-%m"))


def monthly_newsletter(tenant_id: int = DEFAULT_TENANT_ID, *,
                       month: str | None = None,
                       dry_run: bool | None = None,
                       send: bool = True) -> tuple[int, dict]:
    """Create (and optionally send) the monthly customer summary.

    Idempotent per month: a newsletter campaign already created for that month
    is reused rather than duplicated, so a retried cron cannot mail twice.
    """
    key, label = _month_label(month)
    name = f"Monthly newsletter — {label}"

    existing = _one("""SELECT * FROM email_campaigns
                        WHERE tenant_id = ? AND name = ? ORDER BY id DESC LIMIT 1""",
                    (tenant_id, name))
    if existing:
        campaign = existing
        created = False
    else:
        status, payload = create_campaign({
            "name": name,
            "subject": f"Your cleaning summary for {label}",
            # {month} is baked in here, not left to render time: this campaign
            # is about a specific month and may well be sent on a later date,
            # when the live {month} placeholder would resolve to the wrong one.
            "body": NEWSLETTER_BODY.replace("{month}", label),
            "audience": {"kind": "all"},
        }, tenant_id)
        if status != 201:
            return status, payload
        campaign = _one("SELECT * FROM email_campaigns WHERE id = ?",
                        (payload["campaign"]["id"],))
        created = True

    out = {"month": key, "month_label": label, "created": created,
           "campaign": _campaign_dto(campaign)}
    if not send:
        return 200, out
    if campaign["status"] == "sent":
        out["send"] = {"skipped": "already sent", "sent_at": campaign["sent_at"]}
        return 200, out

    _status, result = send_campaign(campaign["id"], tenant_id, dry_run=dry_run)
    out["send"] = result
    return 200, out
