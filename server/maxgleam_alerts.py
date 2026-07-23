"""Max Gleam automatic email alerts.

Evaluates a fixed set of rules against the live estate and emails the office
when one fires. Designed to sit on a daily timer (see tools/maxgleam_alerts.py
and maxgleam-alerts.timer).

Transport
---------
Resend over urllib, matching /opt/maxgleam/server/mail.py exactly — same API
key file, same From address, same User-Agent (Cloudflare in front of
api.resend.com rejects urllib's default UA with error 1010). No SDK, no pip.

Not sending twice
-----------------
Every alert has a dedupe key that encodes what it is actually about — for the
overdue sign-off alert, the set of job ids; for the daily digest, the date.
A key that has already been sent inside its cooldown is skipped. Without this
the timer would email the same eight overdue sign-offs every morning until
someone chased them, and the office would filter the whole lot to junk.

Recipients
----------
Owner-role users on the tenant, honouring users.notify_prefs — the JSON opt-out
map the maxgleam app already writes, keyed by alert kind. A prefs entry set to
false means that person has opted out of that alert, not out of everything.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import urllib.request

from server import partner
from server.maxgleam_ops import DEFAULT_TENANT_ID
from server import maxgleam_activity as activity

# Same key file and sender the maxgleam backend already uses.
RESEND_KEY_PATH = os.environ.get("MAXGLEAM_RESEND_KEY_PATH",
                                 "/etc/maxgleam/resend-api-key")
MAIL_FROM = os.environ.get("MAXGLEAM_FROM", "Max Gleam <hello@mail.opspocket.com>")
BASE_URL = os.environ.get("MAXGLEAM_PUBLIC_BASE", "").rstrip("/")
USER_AGENT = "agent-os-maxgleam-alerts/1.0"

# Set MAXGLEAM_ALERTS_DRY_RUN=1 to evaluate and log without sending.
DRY_RUN_DEFAULT = os.environ.get("MAXGLEAM_ALERTS_DRY_RUN", "").strip() in ("1", "true", "yes")

# Rule thresholds.
UNPAID_INVOICE_DAYS = 14      # unpaid this long after issue → chase it
OPEN_CLOCK_HOURS = 6          # a clock-in running this long was forgotten
OVERDUE_PROPERTY_MIN = 7      # ignore a property only a few days past its slot
DIGEST_HOUR_FROM = 0          # digest covers the previous full day

# How long before the same alert may be sent again, per kind (seconds).
COOLDOWN = {
    "overdue_signoffs": 3 * 86400,
    "overdue_properties": 7 * 86400,
    "unpaid_invoices": 7 * 86400,
    "open_clock": 6 * 3600,
    "daily_digest": 20 * 3600,
}
DEFAULT_COOLDOWN = 86400

KINDS = tuple(COOLDOWN)

_local = threading.local()


def _conn() -> sqlite3.Connection:
    conn = partner._conn()
    if not getattr(_local, "alerts_schema_ready", False):
        _ensure_schema(conn)
        _local.alerts_schema_ready = True
    return conn


def _ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS alert_log (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id   INTEGER NOT NULL,
          kind        TEXT NOT NULL,
          dedupe_key  TEXT NOT NULL,
          severity    TEXT NOT NULL DEFAULT 'info',
          subject     TEXT NOT NULL,
          body        TEXT NOT NULL,
          recipients  TEXT NOT NULL DEFAULT '[]',
          item_count  INTEGER NOT NULL DEFAULT 0,
          dry_run     INTEGER NOT NULL DEFAULT 0,
          status      TEXT NOT NULL DEFAULT 'sent',
          error       TEXT,
          sent_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )""")
    conn.execute("""CREATE INDEX IF NOT EXISTS idx_alert_log_dedupe
                    ON alert_log(tenant_id, kind, dedupe_key, sent_at)""")
    conn.execute("""CREATE INDEX IF NOT EXISTS idx_alert_log_tenant
                    ON alert_log(tenant_id, sent_at)""")
    conn.commit()


def _rows(sql: str, args=()) -> list[dict]:
    cur = _conn().execute(sql, args)
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def _one(sql: str, args=()):
    got = _rows(sql, args)
    return got[0] if got else None


def _gbp(pence) -> str:
    return f"£{(pence or 0) / 100:,.2f}"


def _day(epoch: int) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(epoch))


def _day_start(offset_days: int = 0) -> int:
    t = time.localtime(time.time() + offset_days * 86400)
    return int(time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, -1)))


# ── rules ───────────────────────────────────────────────────────────────
# Each returns an alert dict, or None when it has nothing to say. Keeping
# them independent means one bad rule cannot suppress the others.

def _rule_overdue_signoffs(tenant_id: int) -> dict | None:
    from server.maxgleam_reports import _overdue_signoffs
    data = _overdue_signoffs(tenant_id, None)
    if not data["count"]:
        return None
    jobs = data["jobs"]
    total = sum(j["price_pence"] for j in jobs)
    lines = [f'  · {j["address"]} — {_gbp(j["price_pence"])}, '
             f'{j["days_overdue"]}d overdue'
             + (f' ({j["crew_name"]})' if j["crew_name"] else '')
             for j in jobs[:20]]
    if len(jobs) > 20:
        lines.append(f"  … and {len(jobs) - 20} more")
    return {
        "kind": "overdue_signoffs",
        "severity": "warn",
        "count": data["count"],
        # Keyed on the job set: chase eight, and a ninth appearing tomorrow is
        # a genuinely new alert rather than a repeat of the same list.
        "dedupe_key": ",".join(str(j["job_id"]) for j in sorted(
            jobs, key=lambda x: x["job_id"])),
        "subject": f'Max Gleam: {data["count"]} sign-off'
                   f'{"" if data["count"] == 1 else "s"} overdue',
        "body": "\n".join([
            f'{data["count"]} completed job'
            f'{"" if data["count"] == 1 else "s"} have not been signed off'
            f' within {data["auto_approve_hours"]}h.',
            f'Value waiting on sign-off: {_gbp(total)}.', "", *lines,
        ]),
    }


def _rule_overdue_properties(tenant_id: int) -> dict | None:
    from server import maxgleam_ops
    props = [p for p in maxgleam_ops.overdue_properties(tenant_id)
             if p["days_overdue"] >= OVERDUE_PROPERTY_MIN]
    if not props:
        return None
    lines = [f'  · {p["address"]} — {p["days_overdue"]}d past its '
             f'{p["frequency_weeks"]}-weekly slot (last {p["last_completed"]})'
             for p in props[:20]]
    if len(props) > 20:
        lines.append(f"  … and {len(props) - 20} more")
    return {
        "kind": "overdue_properties",
        "severity": "warn",
        "count": len(props),
        # Bucketed by size, not by exact set: this list churns daily and an
        # exact key would defeat the cooldown entirely.
        "dedupe_key": f"count:{len(props) // 5}",
        "subject": f"Max Gleam: {len(props)} properties overdue a clean",
        "body": "\n".join([
            f"{len(props)} active properties are more than "
            f"{OVERDUE_PROPERTY_MIN} days past their scheduled frequency.",
            "", *lines,
        ]),
    }


def _rule_unpaid_invoices(tenant_id: int) -> dict | None:
    cutoff = int(time.time()) - UNPAID_INVOICE_DAYS * 86400
    rows = _rows(
        """SELECT i.id, i.number, i.amount_pence, i.issued_at, c.name AS customer
             FROM invoices i
             LEFT JOIN customers c ON c.id = i.customer_id
            WHERE i.tenant_id = ? AND i.status = 'unpaid' AND i.issued_at < ?
         ORDER BY i.issued_at ASC LIMIT 100""", (tenant_id, cutoff))
    if not rows:
        return None
    total = sum(r["amount_pence"] or 0 for r in rows)
    lines = [f'  · {r["number"]} — {_gbp(r["amount_pence"])}, '
             f'{(int(time.time()) - r["issued_at"]) // 86400}d old'
             + (f' ({r["customer"]})' if r["customer"] else '')
             for r in rows[:20]]
    return {
        "kind": "unpaid_invoices",
        "severity": "warn",
        "count": len(rows),
        "dedupe_key": ",".join(str(r["id"]) for r in rows),
        "subject": f"Max Gleam: {_gbp(total)} unpaid across {len(rows)} invoice"
                   f'{"" if len(rows) == 1 else "s"}',
        "body": "\n".join([
            f"{len(rows)} invoices are unpaid more than {UNPAID_INVOICE_DAYS} "
            f"days after issue, totalling {_gbp(total)}.", "", *lines,
        ]),
    }


def _rule_open_clock(tenant_id: int) -> dict | None:
    """A clock-in still running hours later is almost always a forgotten
    clock-out, and it silently corrupts every hours figure until fixed."""
    cutoff = int(time.time()) - OPEN_CLOCK_HOURS * 3600
    rows = _rows(
        """SELECT t.id, t.clock_in, t.job_id, s.name AS crew_name, p.address
             FROM time_logs t
             LEFT JOIN subcontractors s ON s.id = t.subcontractor_id
             LEFT JOIN jobs j ON j.id = t.job_id
             LEFT JOIN properties p ON p.id = j.property_id
            WHERE t.clock_out IS NULL AND t.clock_in < ?
              AND COALESCE(s.tenant_id, ?) = ?
         ORDER BY t.clock_in ASC""", (cutoff, tenant_id, tenant_id))
    if not rows:
        return None
    now = int(time.time())
    lines = [f'  · {r["crew_name"] or "Unknown crew"} — on the clock '
             f'{(now - r["clock_in"]) // 3600}h '
             f'since {time.strftime("%H:%M", time.localtime(r["clock_in"]))}'
             + (f' at {r["address"]}' if r["address"] else ' (general duties)')
             for r in rows]
    return {
        "kind": "open_clock",
        "severity": "warn",
        "count": len(rows),
        "dedupe_key": ",".join(str(r["id"]) for r in rows),
        "subject": f'Max Gleam: {len(rows)} crew still clocked in',
        "body": "\n".join([
            f"{len(rows)} time log"
            f'{"" if len(rows) == 1 else "s"} have been open more than '
            f"{OPEN_CLOCK_HOURS}h — likely a missed clock-out.",
            "", *lines,
        ]),
    }


def _rule_daily_digest(tenant_id: int) -> dict | None:
    """Yesterday in one paragraph. Always fires — the cooldown keeps it daily."""
    from server.maxgleam_reports import reports
    start = _day_start(-1)
    yesterday = _day(start)
    _status, data = reports(tenant_id, None)

    jobs = _rows(
        """SELECT COUNT(*) AS n, COALESCE(SUM(j.price_pence), 0) AS pence
             FROM jobs j
            WHERE j.tenant_id = ? AND j.status = 'done'
              AND COALESCE(DATE(j.completed_at, 'unixepoch'), j.scheduled_date) = ?""",
        (tenant_id, yesterday))[0]
    mins = _rows(
        """SELECT COUNT(*) AS n, COALESCE(SUM(total_minutes), 0) AS mins
             FROM time_logs WHERE clock_out IS NOT NULL
              AND clock_in >= ? AND clock_in < ?""", (start, start + 86400))[0]
    upcoming = _rows(
        """SELECT COUNT(*) AS n FROM jobs
            WHERE tenant_id = ? AND status = 'scheduled' AND scheduled_date = ?""",
        (tenant_id, _day(_day_start())))[0]

    return {
        "kind": "daily_digest",
        "severity": "info",
        "count": jobs["n"],
        "dedupe_key": yesterday,
        "subject": f'Max Gleam daily digest — {yesterday}',
        "body": "\n".join([
            f"Yesterday ({yesterday}):",
            f'  · Jobs completed   : {jobs["n"]}',
            f'  · Revenue          : {_gbp(jobs["pence"])}',
            f'  · Hours clocked    : {mins["mins"] / 60:.1f}h across {mins["n"]} entries',
            "",
            "Today:",
            f'  · Jobs scheduled   : {upcoming["n"]}',
            "",
            f'Last {data["window_days"]} days:',
            f'  · Revenue          : {_gbp(data["revenue"]["total_pence"])}',
            f'  · Jobs completed   : {data["jobs"]["completed_window"]}',
            f'  · Average job value: {_gbp(data["jobs"]["avg_value_pence"])}',
            f'  · Retention        : {data["retention"]["rate_pct"]}% '
            f'of {data["retention"]["active_properties"]} recurring properties',
            f'  · Overdue sign-offs: {data["overdue_signoffs"]["count"]}',
        ]),
    }


RULES = {
    "overdue_signoffs": _rule_overdue_signoffs,
    "overdue_properties": _rule_overdue_properties,
    "unpaid_invoices": _rule_unpaid_invoices,
    "open_clock": _rule_open_clock,
    "daily_digest": _rule_daily_digest,
}


def evaluate(tenant_id: int = DEFAULT_TENANT_ID,
             kinds: tuple[str, ...] | None = None) -> list[dict]:
    """Run every rule and return the alerts that fired. Read-only."""
    out = []
    for kind in (kinds or KINDS):
        rule = RULES.get(kind)
        if not rule:
            continue
        try:
            alert = rule(tenant_id)
        except Exception as exc:                      # noqa: BLE001
            # One broken rule must not silence the rest of the sweep.
            alert = {
                "kind": kind, "severity": "error", "count": 0,
                "dedupe_key": f"error:{type(exc).__name__}",
                "subject": f"Max Gleam: alert rule '{kind}' failed",
                "body": f"The {kind} rule raised {type(exc).__name__}: {exc}",
            }
        if alert:
            alert["cooldown_seconds"] = COOLDOWN.get(kind, DEFAULT_COOLDOWN)
            out.append(alert)
    return out


# ── recipients ──────────────────────────────────────────────────────────

def recipients(tenant_id: int = DEFAULT_TENANT_ID, kind: str = "") -> list[dict]:
    """Owner-role users on the tenant who have not opted out of this kind."""
    people = []
    for u in _rows("""SELECT id, email, name, role, notify_prefs FROM users
                       WHERE tenant_id = ? AND role = 'owner' AND email IS NOT NULL""",
                   (tenant_id,)):
        try:
            prefs = json.loads(u["notify_prefs"] or "{}")
        except (TypeError, ValueError):
            prefs = {}
        if kind and prefs.get(kind) is False:
            continue
        people.append({"id": u["id"], "email": u["email"], "name": u["name"]})

    if not people:
        # Fall back to the tenant's own contact address rather than silently
        # dropping an alert because nobody is flagged as an owner.
        t = _one("SELECT email, name FROM tenants WHERE id = ?", (tenant_id,))
        if t and t["email"]:
            people.append({"id": None, "email": t["email"], "name": t["name"]})
    return people


# ── sending ─────────────────────────────────────────────────────────────

def _resend_key() -> str:
    try:
        with open(RESEND_KEY_PATH) as fh:
            return fh.read().strip()
    except OSError:
        return ""


def _send_email(to: str, subject: str, text: str) -> None:
    """Resend over urllib — identical to /opt/maxgleam/server/mail.py."""
    key = _resend_key()
    if not key:
        raise RuntimeError(f"no Resend API key at {RESEND_KEY_PATH}")
    body = {"from": MAIL_FROM, "to": [to], "subject": subject, "text": text}
    req = urllib.request.Request(
        "https://api.resend.com/emails", data=json.dumps(body).encode(),
        method="POST",
        headers={"Authorization": f"Bearer {key}",
                 "Content-Type": "application/json", "User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=15):
        pass


def _recently_sent(tenant_id: int, kind: str, dedupe_key: str,
                   cooldown: int) -> dict | None:
    return _one(
        """SELECT id, sent_at FROM alert_log
            WHERE tenant_id = ? AND kind = ? AND dedupe_key = ?
              AND status = 'sent' AND dry_run = 0 AND sent_at > ?
         ORDER BY sent_at DESC LIMIT 1""",
        (tenant_id, kind, dedupe_key, int(time.time()) - cooldown))


def _footer(alert: dict) -> str:
    link = f"{BASE_URL}/maxgleam/reports" if BASE_URL else "/maxgleam/reports"
    return ("\n\n—\nAGENT OS · Max Gleam alerts\n"
            f"Full reporting: {link}\n"
            f"Alert: {alert['kind']}")


def run(tenant_id: int = DEFAULT_TENANT_ID, *, dry_run: bool | None = None,
        kinds: tuple[str, ...] | None = None,
        force: bool = False) -> dict:
    """Evaluate every rule, then email whatever fired and is not on cooldown.

    force=True ignores the cooldown but still writes the log — for a manual
    "send it now" from the dashboard.
    """
    if dry_run is None:
        dry_run = DRY_RUN_DEFAULT
    alerts = evaluate(tenant_id, kinds)
    results = []

    for alert in alerts:
        cooldown = alert.get("cooldown_seconds", DEFAULT_COOLDOWN)
        prior = None if force else _recently_sent(
            tenant_id, alert["kind"], alert["dedupe_key"], cooldown)
        if prior:
            results.append({**_summary(alert), "status": "skipped",
                            "reason": "cooldown", "last_sent_at": prior["sent_at"]})
            continue

        people = recipients(tenant_id, alert["kind"])
        if not people:
            results.append({**_summary(alert), "status": "skipped",
                            "reason": "no recipients"})
            continue

        text = alert["body"] + _footer(alert)
        addresses = [p["email"] for p in people]
        status, error = "sent", None

        if not dry_run:
            for addr in addresses:
                try:
                    _send_email(addr, alert["subject"], text)
                except Exception as exc:              # noqa: BLE001
                    status, error = "failed", f"{type(exc).__name__}: {exc}"
                    break

        conn = _conn()
        conn.execute(
            """INSERT INTO alert_log
                 (tenant_id, kind, dedupe_key, severity, subject, body,
                  recipients, item_count, dry_run, status, error, sent_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (tenant_id, alert["kind"], alert["dedupe_key"], alert["severity"],
             alert["subject"], text, json.dumps(addresses), alert.get("count", 0),
             1 if dry_run else 0, status, error, int(time.time())))
        conn.commit()

        activity.log("alert_sent" if status == "sent" else "alert_failed",
                     tenant_id=tenant_id, actor_type="system", actor_name="Alerts",
                     entity_type="alert", detail=alert["subject"],
                     meta={"kind": alert["kind"], "recipients": addresses,
                           "dry_run": dry_run, "count": alert.get("count", 0)})

        results.append({**_summary(alert), "status": status,
                        "recipients": addresses, "error": error})

    return {
        "tenant_id": tenant_id,
        "dry_run": dry_run,
        "evaluated": len(alerts),
        "sent": sum(1 for r in results if r["status"] == "sent"),
        "skipped": sum(1 for r in results if r["status"] == "skipped"),
        "failed": sum(1 for r in results if r["status"] == "failed"),
        "results": results,
        "mail_configured": bool(_resend_key()),
        "ran_at": int(time.time()),
    }


def _summary(alert: dict) -> dict:
    return {"kind": alert["kind"], "severity": alert["severity"],
            "subject": alert["subject"], "count": alert.get("count", 0),
            "body": alert["body"]}


def preview(tenant_id: int = DEFAULT_TENANT_ID) -> tuple[int, dict]:
    """What would fire right now, and who it would go to. Sends nothing."""
    alerts = evaluate(tenant_id)
    out = []
    for a in alerts:
        cooldown = a.get("cooldown_seconds", DEFAULT_COOLDOWN)
        prior = _recently_sent(tenant_id, a["kind"], a["dedupe_key"], cooldown)
        out.append({
            **_summary(a),
            "would_send": prior is None,
            "on_cooldown": prior is not None,
            "last_sent_at": prior["sent_at"] if prior else None,
            "recipients": [p["email"] for p in recipients(tenant_id, a["kind"])],
            "cooldown_hours": round(cooldown / 3600, 1),
        })
    return 200, {
        "alerts": out,
        "kinds": list(KINDS),
        "mail_configured": bool(_resend_key()),
        "mail_from": MAIL_FROM,
        "dry_run_default": DRY_RUN_DEFAULT,
        "checked_at": int(time.time()),
    }


def history(tenant_id: int = DEFAULT_TENANT_ID, limit: int = 100) -> tuple[int, dict]:
    rows = _rows(
        """SELECT id, kind, severity, subject, recipients, item_count,
                  dry_run, status, error, sent_at
             FROM alert_log WHERE tenant_id = ?
         ORDER BY sent_at DESC, id DESC LIMIT ?""",
        (tenant_id, max(1, min(500, limit))))
    for r in rows:
        try:
            r["recipients"] = json.loads(r["recipients"] or "[]")
        except (TypeError, ValueError):
            r["recipients"] = []
        r["dry_run"] = bool(r["dry_run"])
    return 200, {"alerts": rows, "count": len(rows)}
