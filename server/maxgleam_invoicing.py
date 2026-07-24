"""Max Gleam — auto-invoicing and tax reporting.

Raises an invoice for a completed clean, attaches a SumUp pay-link and
emails it to the customer.

Why this exists when maxgleam already invoices on completion: maxgleam's
own "complete job" endpoint raises the invoice itself, but jobs completed
anywhere else — the AGENT OS crew app, a bulk status change, an import —
leave the job done and uninvoiced. This module is the safety net, and it is
strictly idempotent: a job that already has an invoice is never invoiced
twice, so running it alongside maxgleam is safe.

Invoice shape matches maxgleam exactly (number scheme, VAT from tenant
settings, amount_pence carrying the gross) so the two paths are
indistinguishable downstream.

Kill-switch: MAXGLEAM_INVOICE_DRY_RUN=1 stops outbound email and SumUp
calls while still writing the invoice rows.
"""
from __future__ import annotations
import csv
import datetime as dt
import io
import json
import logging
import os
import sqlite3
import threading
import time
import urllib.request
from pathlib import Path

from server import partner, sumup

log = logging.getLogger("agentos.mg_invoicing")

DEFAULT_TENANT_ID = int(os.environ.get("MAXGLEAM_TENANT_ID", "2"))
RESEND_KEY_PATH = os.environ.get("MAXGLEAM_RESEND_KEY_PATH", "/etc/maxgleam/resend-api-key")
FROM_ADDR = os.environ.get("MAXGLEAM_FROM", "Max Gleam <hello@mail.opspocket.com>")
PUBLIC_BASE = os.environ.get("MAXGLEAM_PUBLIC_BASE", "").rstrip("/")
DRY_RUN = os.environ.get("MAXGLEAM_INVOICE_DRY_RUN", "") == "1"

# Invoices unpaid for longer than this are reported as overdue.
OVERDUE_DAYS = int(os.environ.get("MAXGLEAM_INVOICE_OVERDUE_DAYS", "30"))
USER_AGENT = "agent-os-invoicing/1.0"


def _conn() -> sqlite3.Connection:
    return partner._conn()


def _rows(sql: str, args=()) -> list[dict]:
    return [dict(r) for r in _conn().execute(sql, args).fetchall()]


def _one(sql: str, args=()) -> dict | None:
    r = _conn().execute(sql, args).fetchone()
    return dict(r) if r else None


def _read_secret(path: str) -> str:
    try:
        return Path(path).read_text().strip()
    except OSError:
        return ""


# ------------------------------------------------------------------ tenant --

def _tenant(tenant_id: int = DEFAULT_TENANT_ID) -> dict | None:
    return _one("SELECT * FROM tenants WHERE id = ?", (tenant_id,))


def _vat_rate(tenant: dict) -> float:
    """VAT percentage for this tenant, or 0 when not VAT registered.

    Mirrors maxgleam: VAT is only charged when settings.vat_enabled is set.
    Chester Window Cleaner is not currently VAT registered, so this returns
    0 and invoices carry vat_pence = 0 — the tax report must not invent a
    VAT liability that was never charged.
    """
    try:
        settings = json.loads(tenant.get("settings_json") or "{}")
    except (json.JSONDecodeError, TypeError):
        return 0.0
    if not settings.get("vat_enabled"):
        return 0.0
    return float(settings.get("vat_rate") or 20)


def vat_status(tenant_id: int = DEFAULT_TENANT_ID) -> dict:
    tenant = _tenant(tenant_id) or {}
    rate = _vat_rate(tenant)
    return {"vat_registered": rate > 0, "vat_rate": rate}


# ----------------------------------------------------------------- numbers --

def _next_number(tenant_id: int, year: int | None = None) -> str:
    """INV-<year>-<seq>, continuing maxgleam's series.

    Derived from the highest existing number for that year rather than a
    row count, so deleting or voiding an invoice can never mint a number
    that already exists.
    """
    year = year or dt.date.today().year
    # NUMBER_PREFIX defaults to INV, continuing the live series. Setting
    # MAXGLEAM_INVOICE_PREFIX=MG mints MG-<year>-<seq> from that point on.
    prefix = f"{globals().get('NUMBER_PREFIX', 'INV')}-{year}-"
    rows = _rows("SELECT number FROM invoices WHERE tenant_id = ? AND number LIKE ?",
                 (tenant_id, prefix + "%"))
    highest = 0
    for r in rows:
        tail = (r["number"] or "").rsplit("-", 1)[-1]
        if tail.isdigit():
            highest = max(highest, int(tail))
    return f"{prefix}{highest + 1:04d}"


# -------------------------------------------------------------- integrations --

def _merchant_code(tenant: dict) -> str:
    """Cached merchant code, fetched from SumUp on first use (as maxgleam does)."""
    code = (tenant.get("sumup_merchant_code") or "").strip()
    if code:
        return code
    api_key = (tenant.get("sumup_api_key") or "").strip()
    if not api_key:
        return ""
    try:
        code = sumup.merchant_code(api_key)
    except Exception as exc:                                # noqa: BLE001
        log.warning("sumup: could not read merchant profile: %s", exc)
        return ""
    if code:
        conn = _conn()
        conn.execute("UPDATE tenants SET sumup_merchant_code = ? WHERE id = ?",
                     (code, tenant["id"]))
        conn.commit()
        tenant["sumup_merchant_code"] = code
    return code


def ensure_checkout(tenant: dict, invoice: dict) -> str:
    """Return a SumUp pay-link for an invoice, creating one if needed.

    Best-effort: a SumUp outage must never stop an invoice being raised.
    """
    if invoice.get("sumup_checkout_url"):
        return invoice["sumup_checkout_url"]
    api_key = (tenant.get("sumup_api_key") or "").strip()
    if not api_key:
        return ""
    if DRY_RUN:
        log.info("DRY-RUN sumup checkout for %s (%s)",
                 invoice["number"], invoice["amount_pence"])
        return ""
    code = _merchant_code(tenant)
    if not code:
        return ""
    try:
        ck = sumup.create_hosted_checkout(
            api_key=api_key, merchant_code=code,
            amount_pence=invoice["amount_pence"],
            currency=tenant.get("currency") or "GBP",
            reference=f"{tenant['slug']}-{invoice['number']}",
            description=f"{tenant['name']} — {invoice['number']}")
    except Exception as exc:                                # noqa: BLE001
        log.warning("sumup: checkout failed for %s: %s", invoice["number"], exc)
        return ""
    url = ck.get("hosted_checkout_url") or ""
    if url:
        conn = _conn()
        conn.execute("UPDATE invoices SET sumup_checkout_id = ?, sumup_checkout_url = ? "
                     "WHERE id = ?", (ck.get("id"), url, invoice["id"]))
        conn.commit()
        invoice["sumup_checkout_id"] = ck.get("id")
        invoice["sumup_checkout_url"] = url
    return url


def _send_email(to: str, subject: str, text: str, reply_to: str | None = None) -> tuple[str, str | None]:
    if not to:
        return "skipped", "no email address"
    if DRY_RUN:
        log.info("DRY-RUN invoice email to=%s subject=%r", to, subject)
        return "dry_run", None
    key = _read_secret(RESEND_KEY_PATH)
    if not key:
        return "failed", "resend key not readable"
    body = {"from": FROM_ADDR, "to": [to], "subject": subject, "text": text}
    if reply_to:
        body["reply_to"] = reply_to
    req = urllib.request.Request(
        "https://api.resend.com/emails", data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                 "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=15):
            return "sent", None
    except Exception as exc:                                # noqa: BLE001
        log.warning("invoice email failed: %s", exc)
        return "failed", str(exc)[:200]


# ---------------------------------------------------------------- invoicing --

_JOB_FOR_INVOICE = """
  SELECT j.id, j.tenant_id, j.property_id, j.scheduled_date, j.status,
         j.price_pence AS job_price, j.completed_at, j.partner_company_id,
         p.price_pence AS property_price, p.address, p.postcode,
         p.partner_company_id AS prop_partner_id,
         c.id AS customer_id, c.name AS customer_name, c.email AS customer_email
    FROM jobs j
    JOIN properties p ON p.id = j.property_id
    LEFT JOIN customers c ON c.id = p.customer_id
"""


def uninvoiced_jobs(tenant_id: int = DEFAULT_TENANT_ID,
                    company_id: int | None = None) -> list[dict]:
    """Completed jobs with no invoice against them."""
    sql = _JOB_FOR_INVOICE + (
        " WHERE j.status = 'done' AND j.tenant_id = ?"
        "   AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.job_id = j.id)")
    args: list = [tenant_id]
    if company_id is not None:
        sql += " AND (j.partner_company_id = ? OR p.partner_company_id = ?)"
        args += [company_id, company_id]
    sql += " ORDER BY j.completed_at ASC, j.id ASC"
    return _rows(sql, tuple(args))


def _invoice_amount(job: dict) -> int:
    """Net amount for a job.

    The standing price on the property is the contracted rate, so it wins.
    Where a property has no price set (ad-hoc work), the price agreed on the
    job itself is used instead — invoicing £0 would be worse than either.
    """
    return int(job.get("property_price") or 0) or int(job.get("job_price") or 0)


def invoice_job(job_id: int, tenant_id: int = DEFAULT_TENANT_ID,
                send: bool = True) -> tuple[dict | None, str]:
    """Raise an invoice for one completed job. Returns (invoice, outcome)."""
    job = _one(_JOB_FOR_INVOICE + " WHERE j.id = ?", (job_id,))
    if not job:
        return None, "job not found"
    if job["status"] != "done":
        return None, "job is not complete"
    existing = _one("SELECT * FROM invoices WHERE job_id = ?", (job_id,))
    if existing:
        return existing, "already invoiced"
    if not job["customer_id"]:
        return None, "job has no customer"

    net = _invoice_amount(job)
    if net <= 0:
        return None, "no price on the property or job"

    tenant = _tenant(job["tenant_id"] or tenant_id)
    if not tenant:
        return None, "tenant not found"
    rate = _vat_rate(tenant)
    vat = round(net * rate / 100) if rate else 0

    items = [{"label": f"Window clean — {job['address']}", "amount_pence": net}]
    conn = _conn()
    # A UNIQUE index guards (tenant_id, number); retry once if maxgleam's
    # own invoicing claimed the same number in between.
    for attempt in range(3):
        number = _next_number(tenant["id"])
        try:
            cur = conn.execute(
                "INSERT INTO invoices (tenant_id, customer_id, job_id, number, "
                " amount_pence, vat_pence, status, items_json) "
                "VALUES (?,?,?,?,?,?, 'unpaid', ?)",
                (tenant["id"], job["customer_id"], job_id, number,
                 net + vat, vat, json.dumps(items)))
            conn.commit()
            break
        except sqlite3.IntegrityError:
            conn.rollback()
            if attempt == 2:
                return None, "could not allocate an invoice number"
            time.sleep(0.05)
    else:                                                   # pragma: no cover
        return None, "could not allocate an invoice number"

    invoice = _one("SELECT * FROM invoices WHERE id = ?", (cur.lastrowid,))

    # Absorb any referral credit this customer has earned, before the checkout
    # link is minted and the invoice is emailed — applying it afterwards would
    # bill them the full amount and then quietly change the figure.
    try:
        from server import maxgleam_referrals
        maxgleam_referrals.apply_rewards(tenant["id"])
        invoice = _one("SELECT * FROM invoices WHERE id = ?", (invoice["id"],))
    except Exception:                                       # noqa: BLE001
        log.exception("maxgleam: referral credit check failed for invoice %s",
                      invoice["id"])

    ensure_checkout(tenant, invoice)
    if send:
        email_invoice(invoice["id"], tenant_id=tenant["id"])
    return _one("SELECT * FROM invoices WHERE id = ?", (invoice["id"],)), "created"


def auto_generate(tenant_id: int = DEFAULT_TENANT_ID, company_id: int | None = None,
                  send: bool = True, limit: int = 200) -> tuple[int, dict]:
    """Invoice every completed-but-uninvoiced job."""
    jobs = uninvoiced_jobs(tenant_id, company_id)[:limit]
    created, skipped = [], []
    for job in jobs:
        invoice, outcome = invoice_job(job["id"], tenant_id, send=send)
        if outcome == "created" and invoice:
            created.append({"invoice_id": invoice["id"], "number": invoice["number"],
                            "job_id": job["id"], "amount_pence": invoice["amount_pence"],
                            "address": job["address"],
                            "customer_email": job["customer_email"]})
        else:
            skipped.append({"job_id": job["id"], "address": job["address"],
                            "reason": outcome})
    return 200, {"created": created, "skipped": skipped,
                 "created_count": len(created), "skipped_count": len(skipped),
                 "candidates": len(jobs), "dry_run": DRY_RUN}


def email_invoice(invoice_id: int, tenant_id: int = DEFAULT_TENANT_ID) -> tuple[int, dict]:
    """Email (or re-email) an invoice to the customer with a pay-link."""
    inv = _one(
        "SELECT i.*, c.name AS customer_name, c.email AS customer_email, "
        "       p.address, j.scheduled_date "
        "  FROM invoices i "
        "  LEFT JOIN customers c ON c.id = i.customer_id "
        "  LEFT JOIN jobs j ON j.id = i.job_id "
        "  LEFT JOIN properties p ON p.id = j.property_id "
        " WHERE i.id = ?", (invoice_id,))
    if not inv:
        return 404, {"error": "invoice not found"}
    tenant = _tenant(inv["tenant_id"] or tenant_id)
    if not tenant:
        return 404, {"error": "tenant not found"}
    to = (inv["customer_email"] or "").strip()
    if not to:
        return 400, {"error": "no email address on file for this customer"}

    url = ensure_checkout(tenant, dict(inv))
    amount = f"£{inv['amount_pence'] / 100:.2f}"
    lines = [
        f"Hi {(inv['customer_name'] or '').split(' ')[0] or 'there'},",
        "",
        f"Here's your invoice {inv['number']} from {tenant['name']} for {amount}.",
    ]
    if inv["address"]:
        lines.append(f"Clean at {inv['address']}"
                     + (f" on {inv['scheduled_date']}." if inv["scheduled_date"] else "."))
    if inv["vat_pence"]:
        lines.append(f"Includes VAT of £{inv['vat_pence'] / 100:.2f}.")
    lines.append("")
    if url:
        lines += [f"Pay online: {url}", ""]
    if PUBLIC_BASE:
        lines += [f"See all your cleans and invoices: {PUBLIC_BASE}/customer/login", ""]
    lines += ["Thank you,", tenant["name"]]

    status, error = _send_email(
        to, f"{tenant['name']} — invoice {inv['number']} ({amount})",
        "\n".join(lines), reply_to=tenant.get("email"))

    conn = _conn()
    try:
        conn.execute(
            "INSERT INTO comms_log (tenant_id, customer_id, kind, content) VALUES (?,?,?,?)",
            (inv["tenant_id"], inv["customer_id"], "invoice_sent",
             f"Invoice {inv['number']} {status} to {to}"))
        conn.commit()
    except Exception:                                       # noqa: BLE001
        log.exception("comms_log write failed")

    if status == "failed":
        return 502, {"error": f"could not send the email: {error}"}
    return 200, {"ok": True, "status": status, "to": to,
                 "number": inv["number"], "checkout_url": url}


# ------------------------------------------------------------------- listing --

# ledger_paid is the running total received against each invoice, summed from
# the invoice_payments ledger (see the payments section below). Callers that
# run this SELECT must ensure that table exists first via _payments_conn().
_INVOICE_SELECT = """
  SELECT i.id, i.number, i.amount_pence, i.vat_pence, i.status, i.method,
         i.issued_at, i.paid_at, i.sumup_checkout_url, i.job_id, i.customer_id,
         c.name AS customer_name, c.email AS customer_email,
         j.scheduled_date, j.signoff_status,
         p.address, p.postcode, p.partner_company_id,
         COALESCE(pay.paid, 0) AS ledger_paid
    FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id
    LEFT JOIN jobs j ON j.id = i.job_id
    LEFT JOIN properties p ON p.id = j.property_id
    LEFT JOIN (SELECT invoice_id, SUM(amount_pence) AS paid
                 FROM invoice_payments GROUP BY invoice_id) pay ON pay.invoice_id = i.id
"""


def _invoice_dto(r: dict, now: int) -> dict:
    """Money view of an invoice, balance-aware for part-payments.

    A 'paid' or 'void' invoice owes nothing; for 'unpaid'/'partial' the
    outstanding balance is the gross less whatever the ledger has received.
    """
    amount = r["amount_pence"] or 0
    status = r["status"]
    if status in ("paid", "void"):
        paid = amount if status == "paid" else 0
    else:
        paid = min(amount, r.get("ledger_paid") or 0)
    outstanding = 0 if status in ("paid", "void") else max(0, amount - paid)
    owes = outstanding > 0
    overdue = (owes and r["issued_at"]
               and now - r["issued_at"] > OVERDUE_DAYS * 86400)
    # 'overdue' and 'partial' are derived views, never stored — the invoices
    # table only knows unpaid/partial/paid/void.
    disp = ("overdue" if overdue
            else "partial" if (owes and paid > 0)
            else status)
    return {
        **r,
        "net_pence": amount - (r["vat_pence"] or 0),
        "paid_pence": paid,
        "outstanding_pence": outstanding,
        "is_overdue": bool(overdue),
        "display_status": disp,
        "days_outstanding": (int((now - r["issued_at"]) / 86400)
                             if owes and r["issued_at"] else None),
    }


def list_invoices(tenant_id: int = DEFAULT_TENANT_ID, company_id: int | None = None,
                  status: str = "", limit: int = 500) -> tuple[int, dict]:
    _payments_conn()          # the ledger JOIN in _INVOICE_SELECT needs the table
    sql = _INVOICE_SELECT + " WHERE i.tenant_id = ?"
    args: list = [tenant_id]
    if company_id is not None:
        sql += " AND p.partner_company_id = ?"
        args.append(company_id)
    sql += " ORDER BY i.issued_at DESC, i.id DESC LIMIT ?"
    args.append(limit)

    now = int(time.time())
    dtos = [_invoice_dto(r, now) for r in _rows(sql, tuple(args))]

    wanted = (status or "").strip().lower()
    if wanted == "unpaid":
        # 'Unpaid' means "still owes money" — part-paid invoices belong here too.
        shown = [d for d in dtos if d["outstanding_pence"] > 0 and not d["is_overdue"]]
    elif wanted in ("paid", "void", "overdue", "partial"):
        shown = [d for d in dtos if d["display_status"] == wanted]
    else:
        shown = dtos

    return 200, {
        "invoices": shown,
        "summary": {
            "total": len(dtos),
            "paid": sum(1 for d in dtos if d["status"] == "paid"),
            "unpaid": sum(1 for d in dtos if d["outstanding_pence"] > 0),
            "partial": sum(1 for d in dtos if d["display_status"] == "partial"),
            "overdue": sum(1 for d in dtos if d["is_overdue"]),
            # Money view: paid_pence is what's actually been received (part-
            # payments included), unpaid_pence what is still outstanding.
            "paid_pence": sum(d["paid_pence"] for d in dtos),
            "unpaid_pence": sum(d["outstanding_pence"] for d in dtos),
            "overdue_pence": sum(d["outstanding_pence"] for d in dtos if d["is_overdue"]),
            "overdue_days": OVERDUE_DAYS,
        },
        "uninvoiced_jobs": len(uninvoiced_jobs(tenant_id, company_id)),
        "filter": wanted or "all",
        **vat_status(tenant_id),
    }


# ---------------------------------------------------------------- tax report --

def _month_bounds(frm: str, to: str) -> tuple[int, int, str, str]:
    """YYYY-MM strings → inclusive epoch range covering whole months."""
    today = dt.date.today()
    def parse(value: str, fallback: dt.date) -> dt.date:
        try:
            year, month = value.split("-")
            return dt.date(int(year), int(month), 1)
        except (ValueError, AttributeError):
            return fallback
    start = parse(frm, today.replace(day=1))
    end = parse(to, today.replace(day=1))
    if end < start:
        start, end = end, start
    # exclusive upper bound = first day of the month after `end`
    nxt = dt.date(end.year + (end.month // 12), (end.month % 12) + 1, 1)
    return (int(dt.datetime.combine(start, dt.time.min).timestamp()),
            int(dt.datetime.combine(nxt, dt.time.min).timestamp()),
            start.strftime("%Y-%m"), end.strftime("%Y-%m"))


def tax_report(frm: str = "", to: str = "", tenant_id: int = DEFAULT_TENANT_ID,
               company_id: int | None = None) -> tuple[int, dict]:
    """Revenue, VAT and settlement for a month range, by invoice issue date."""
    start_ts, end_ts, from_month, to_month = _month_bounds(frm, to)

    sql = (_INVOICE_SELECT + " WHERE i.tenant_id = ? AND i.status != 'void'"
           "   AND i.issued_at >= ? AND i.issued_at < ?")
    args: list = [tenant_id, start_ts, end_ts]
    if company_id is not None:
        sql += " AND p.partner_company_id = ?"
        args.append(company_id)
    sql += " ORDER BY i.issued_at ASC"

    now = int(time.time())
    invoices = [_invoice_dto(r, now) for r in _rows(sql, tuple(args))]

    gross = sum(i["amount_pence"] for i in invoices)
    vat = sum(i["vat_pence"] or 0 for i in invoices)
    net = gross - vat
    paid = sum(i["amount_pence"] for i in invoices if i["status"] == "paid")
    unpaid = gross - paid

    status = vat_status(tenant_id)
    # Not VAT registered → nothing was charged. Show what the liability
    # would be at the standard rate so the figure is available for planning,
    # but never present it as VAT collected.
    notional_vat = 0 if status["vat_registered"] else round(gross - gross / 1.2)

    months: dict[str, dict] = {}
    for i in invoices:
        key = dt.datetime.fromtimestamp(i["issued_at"]).strftime("%Y-%m")
        m = months.setdefault(key, {"month": key, "gross_pence": 0, "vat_pence": 0,
                                    "net_pence": 0, "paid_pence": 0, "count": 0})
        m["gross_pence"] += i["amount_pence"]
        m["vat_pence"] += i["vat_pence"] or 0
        m["net_pence"] += i["net_pence"]
        m["paid_pence"] += i["amount_pence"] if i["status"] == "paid" else 0
        m["count"] += 1

    return 200, {
        "from": from_month, "to": to_month,
        "totals": {
            "revenue_gross_pence": gross,
            "revenue_net_pence": net,
            "vat_pence": vat,
            "paid_pence": paid,
            "unpaid_pence": unpaid,
            "invoice_count": len(invoices),
            "notional_vat_at_20_pence": notional_vat,
        },
        "by_month": [months[k] for k in sorted(months)],
        "invoices": invoices,
        **status,
    }


def tax_csv(frm: str = "", to: str = "", tenant_id: int = DEFAULT_TENANT_ID,
            company_id: int | None = None) -> tuple[int, str, str]:
    code, report = tax_report(frm, to, tenant_id, company_id)
    if code != 200:
        return code, json.dumps(report), "application/json"

    buf = io.StringIO()
    w = csv.writer(buf)
    pounds = lambda p: f"{(p or 0) / 100:.2f}"                      # noqa: E731

    w.writerow([f"Tax report {report['from']} to {report['to']}"])
    w.writerow(["VAT registered", "yes" if report["vat_registered"] else "no"])
    if report["vat_rate"]:
        w.writerow(["VAT rate", f"{report['vat_rate']:g}%"])
    w.writerow([])
    t = report["totals"]
    w.writerow(["Summary"])
    w.writerow(["Invoices", t["invoice_count"]])
    w.writerow(["Revenue (gross)", pounds(t["revenue_gross_pence"])])
    w.writerow(["Revenue (net of VAT)", pounds(t["revenue_net_pence"])])
    w.writerow(["VAT charged", pounds(t["vat_pence"])])
    if not report["vat_registered"]:
        w.writerow(["VAT at 20% if registered (not charged)",
                    pounds(t["notional_vat_at_20_pence"])])
    w.writerow(["Paid", pounds(t["paid_pence"])])
    w.writerow(["Unpaid", pounds(t["unpaid_pence"])])
    w.writerow([])

    w.writerow(["Month", "Invoices", "Gross", "Net", "VAT", "Paid"])
    for m in report["by_month"]:
        w.writerow([m["month"], m["count"], pounds(m["gross_pence"]),
                    pounds(m["net_pence"]), pounds(m["vat_pence"]), pounds(m["paid_pence"])])
    w.writerow([])

    w.writerow(["Invoice", "Issued", "Customer", "Address", "Gross", "Net", "VAT",
                "Status", "Paid on"])
    for i in report["invoices"]:
        w.writerow([
            i["number"],
            dt.datetime.fromtimestamp(i["issued_at"]).strftime("%Y-%m-%d") if i["issued_at"] else "",
            i.get("customer_name") or "", i.get("address") or "",
            pounds(i["amount_pence"]), pounds(i["net_pence"]), pounds(i["vat_pence"]),
            i["display_status"],
            dt.datetime.fromtimestamp(i["paid_at"]).strftime("%Y-%m-%d") if i["paid_at"] else "",
        ])
    return 200, buf.getvalue(), "text/csv"


# ------------------------------------------------------- late payment chasing --
# Two nudges, at 30 and 60 days. Both by SMS, because an unpaid invoice has
# already had the email that raised it and been ignored.
#
# Three guards sit in front of every send, mirroring maxgleam_notify:
#   1. MAXGLEAM_REMINDER_DRY_RUN (default "1") — log, don't send. Deploying
#      this therefore texts nobody until someone decides otherwise.
#   2. invoice_reminders has a UNIQUE (invoice_id, stage) index, so a cron
#      re-run can never chase the same person twice for the same stage.
#   3. Customers tagged sms_opt_out / no_sms are skipped and recorded.

REMINDER_DRY_RUN = os.environ.get("MAXGLEAM_REMINDER_DRY_RUN", "1") != "0"

# Days overdue at which each nudge is due, gentlest first.
REMINDER_STAGES = (30, 60)

REMINDER_TEMPLATE = ("Hi {name}, invoice #{number} for {amount} is now overdue. "
                     "Pay here: {link}")

_reminder_local = threading.local()


def _reminder_conn() -> sqlite3.Connection:
    conn = _conn()
    if not getattr(_reminder_local, "ready", False):
        conn.execute("""
            CREATE TABLE IF NOT EXISTS invoice_reminders (
              id         INTEGER PRIMARY KEY AUTOINCREMENT,
              tenant_id  INTEGER NOT NULL,
              invoice_id INTEGER NOT NULL REFERENCES invoices(id),
              customer_id INTEGER REFERENCES customers(id),
              stage      INTEGER NOT NULL,      -- days overdue: 30 | 60
              channel    TEXT NOT NULL DEFAULT 'sms',
              to_addr    TEXT,
              body       TEXT,
              status     TEXT NOT NULL,         -- sent|dry_run|failed|skipped_opt_out|no_contact
              error      TEXT,
              sent_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
            )""")
        # The guarantee that a re-run cannot chase the same stage twice.
        conn.execute("""CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_reminder_once
                        ON invoice_reminders(invoice_id, stage)""")
        conn.commit()
        _reminder_local.ready = True
    return conn


def _days_overdue(invoice: dict, now: int) -> int:
    if not invoice.get("issued_at"):
        return 0
    return max(0, int((now - invoice["issued_at"]) / 86400))


def _stage_due(days: int) -> int | None:
    """The highest reminder stage this invoice has reached, or None.

    Highest rather than lowest so an invoice that is already 65 days old when
    the feature is switched on gets the 60-day message, not a 30-day one that
    understates how late it is. The 30-day stage is then recorded as skipped
    so it never fires afterwards.
    """
    reached = [s for s in REMINDER_STAGES if days >= s]
    return max(reached) if reached else None


def _sent_stages(invoice_id: int) -> set[int]:
    return {r["stage"] for r in
            [dict(x) for x in _reminder_conn().execute(
                "SELECT stage FROM invoice_reminders WHERE invoice_id = ?",
                (invoice_id,)).fetchall()]}


# Part-paid invoices are chased too — a customer who paid half still owes the
# rest — so 'partial' sits alongside 'unpaid' here. The outstanding balance
# (not the gross) is what the summary and the reminder text below report.
_OVERDUE_SELECT = _INVOICE_SELECT + """
   WHERE i.tenant_id = ? AND i.status IN ('unpaid', 'partial')
     AND i.issued_at IS NOT NULL AND i.issued_at < ?
"""


def overdue_invoices(tenant_id: int = DEFAULT_TENANT_ID,
                     company_id: int | None = None) -> tuple[int, dict]:
    """Unpaid or part-paid invoices past the overdue threshold, with chase history."""
    _reminder_conn()          # create the log table up front, not per-row
    _payments_conn()          # the ledger JOIN in _INVOICE_SELECT needs the table
    now = int(time.time())
    cutoff = now - REMINDER_STAGES[0] * 86400

    sql = _OVERDUE_SELECT
    args: list = [tenant_id, cutoff]
    if company_id is not None:
        sql += " AND p.partner_company_id = ?"
        args.append(company_id)
    sql += " ORDER BY i.issued_at ASC"

    rows = []
    for r in _rows(sql, tuple(args)):
        dto = _invoice_dto(r, now)
        days = _days_overdue(r, now)
        sent = _sent_stages(r["id"])
        stage = _stage_due(days)
        phone = _customer_phone(r["customer_id"])
        rows.append({
            **dto,
            "days_overdue": days,
            "reminders_sent": sorted(sent),
            "stage_due": stage,
            # What a sweep would do with this invoice right now.
            "reminder_due": bool(stage and stage not in sent),
            "customer_phone": phone,
            "can_text": bool(phone),
        })

    due = [r for r in rows if r["reminder_due"]]
    return 200, {
        "invoices": rows,
        "summary": {
            "count": len(rows),
            "total_pence": sum(r["outstanding_pence"] for r in rows),
            "due_now": len(due),
            "due_now_pence": sum(r["outstanding_pence"] for r in due),
            "at_30": sum(1 for r in rows if r["stage_due"] == 30),
            "at_60": sum(1 for r in rows if r["stage_due"] == 60),
            "no_phone": sum(1 for r in rows if not r["can_text"]),
        },
        "stages": list(REMINDER_STAGES),
        "overdue_days": OVERDUE_DAYS,
        "dry_run": REMINDER_DRY_RUN,
        "dry_run_note": ("Reminders are logged, not sent. Set "
                         "MAXGLEAM_REMINDER_DRY_RUN=0 in /etc/agent-os.env and "
                         "restart agent-os to text customers for real."
                         if REMINDER_DRY_RUN else "Live — reminders are texted to customers."),
        "checked_at": now,
    }


def _opted_out(tags_json: str | None) -> bool:
    """Reuses maxgleam_notify's opt-out tag list so a customer who has said
    "no texts" is honoured here too. Imported lazily to keep the two modules
    independent at import time."""
    from server.maxgleam_notify import _opted_out as notify_opted_out
    return notify_opted_out(tags_json)


def _customer_phone(customer_id: int | None) -> str:
    if not customer_id:
        return ""
    row = _one("SELECT phone FROM customers WHERE id = ?", (customer_id,))
    return ((row or {}).get("phone") or "").strip()


def _customer_tags(customer_id: int | None) -> str:
    if not customer_id:
        return "[]"
    row = _one("SELECT tags FROM customers WHERE id = ?", (customer_id,))
    return (row or {}).get("tags") or "[]"


def _pay_link(invoice: dict) -> str:
    """Best available way for the customer to settle: their SumUp checkout,
    else the portal. A reminder with no link is a reminder that gets ignored."""
    url = (invoice.get("sumup_checkout_url") or "").strip()
    if url:
        return url
    tenant = _tenant(invoice.get("tenant_id") or DEFAULT_TENANT_ID)
    if tenant:
        url = ensure_checkout(tenant, dict(invoice))
        if url:
            return url
    return f"{PUBLIC_BASE}/customer/login" if PUBLIC_BASE else ""


def _reminder_body(invoice: dict, link: str) -> str:
    name = (invoice.get("customer_name") or "there").split(" ")[0] or "there"
    # Chase the balance still owed, not the gross — a customer who part-paid
    # would otherwise be asked for money they've already handed over.
    owed = invoice.get("outstanding_pence")
    if owed is None:
        owed = invoice.get("amount_pence") or 0
    return REMINDER_TEMPLATE.format(
        name=name, number=invoice.get("number") or "",
        amount=f"£{owed / 100:.2f}", link=link)


def _send_reminder_sms(to_number: str, body: str) -> tuple[str, str | None]:
    if not to_number:
        return "no_contact", "no phone number"
    if REMINDER_DRY_RUN:
        log.info("maxgleam-reminder DRY-RUN sms to=%s body=%r", to_number, body[:140])
        return "dry_run", None
    from server import ks
    return ks._send_sms(to_number, body)


def _log_reminder(invoice: dict, stage: int, to_addr: str, body: str,
                  status: str, error: str | None) -> bool:
    """Record one reminder. False means another sweep beat us to it."""
    conn = _reminder_conn()
    try:
        conn.execute(
            "INSERT INTO invoice_reminders (tenant_id, invoice_id, customer_id, stage, "
            " channel, to_addr, body, status, error) VALUES (?,?,?,?, 'sms', ?,?,?,?)",
            (invoice.get("tenant_id") or DEFAULT_TENANT_ID, invoice["id"],
             invoice.get("customer_id"), stage, to_addr, body, status, error))
    except sqlite3.IntegrityError:
        return False
    if status in ("sent", "dry_run"):
        conn.execute(
            "INSERT INTO comms_log (tenant_id, customer_id, kind, content) VALUES (?,?,?,?)",
            (invoice.get("tenant_id") or DEFAULT_TENANT_ID, invoice.get("customer_id"),
             "payment_reminder",
             f"{stage}-day reminder for {invoice.get('number')} {status} to {to_addr}"))
    conn.commit()
    return True


def send_reminders(tenant_id: int = DEFAULT_TENANT_ID, company_id: int | None = None,
                   invoice_id: int | None = None, limit: int = 100) -> tuple[int, dict]:
    """Text everyone whose invoice has hit a reminder stage. Cron-safe.

    Skipped stages are still written to invoice_reminders — an invoice that
    was already 65 days old when this first ran has its 30-day stage recorded
    as superseded, so it can never fire a stale message later.
    """
    # Settle silent payments before deciding who to chase: a customer who paid
    # on SumUp's hosted page but never reopened the portal still reads 'unpaid'
    # here, and texting them a charge notice is the worst outcome this sweep
    # has. Best-effort — a SumUp outage must not stop legitimate reminders.
    try:
        reconcile_payments(tenant_id, company_id)
    except Exception as exc:                                   # noqa: BLE001
        log.warning("maxgleam: pre-reminder reconcile failed, chasing on last "
                    "known state: %s", exc)

    _code, overdue = overdue_invoices(tenant_id, company_id)
    candidates = [i for i in overdue["invoices"] if i["reminder_due"]]
    if invoice_id is not None:
        candidates = [i for i in candidates if i["id"] == invoice_id]
    candidates = candidates[:limit]

    results = []
    for inv_row in candidates:
        stage = inv_row["stage_due"]

        # Record any earlier stage this invoice sailed past, so it is closed
        # off rather than left waiting to fire.
        for earlier in REMINDER_STAGES:
            if earlier < stage and earlier not in inv_row["reminders_sent"]:
                _log_reminder(inv_row, earlier, "", "", "superseded",
                              f"invoice was already {inv_row['days_overdue']} days overdue")

        if _opted_out(_customer_tags(inv_row["customer_id"])):
            _log_reminder(inv_row, stage, inv_row["customer_phone"], "",
                          "skipped_opt_out", None)
            results.append({"invoice_id": inv_row["id"], "number": inv_row["number"],
                            "stage": stage, "status": "skipped_opt_out"})
            continue

        link = _pay_link(inv_row)
        body = _reminder_body(inv_row, link)
        to = inv_row["customer_phone"]
        status, error = _send_reminder_sms(to, body)

        if not _log_reminder(inv_row, stage, to, body, status, error):
            results.append({"invoice_id": inv_row["id"], "number": inv_row["number"],
                            "stage": stage, "status": "duplicate"})
            continue

        results.append({"invoice_id": inv_row["id"], "number": inv_row["number"],
                        "customer_name": inv_row.get("customer_name"),
                        "stage": stage, "status": status, "to": to,
                        "body": body, "error": error})

    counts: dict[str, int] = {}
    for r in results:
        counts[r["status"]] = counts.get(r["status"], 0) + 1

    return 200, {
        "processed": len(results),
        "by_status": counts,
        "sent": counts.get("sent", 0) + counts.get("dry_run", 0),
        "failed": counts.get("failed", 0),
        "results": results,
        "candidates": len(candidates),
        "dry_run": REMINDER_DRY_RUN,
        "ran_at": int(time.time()),
    }


def reminder_history(tenant_id: int = DEFAULT_TENANT_ID, limit: int = 100) -> list[dict]:
    return [dict(r) for r in _reminder_conn().execute(
        "SELECT r.*, i.number, c.name AS customer_name "
        "  FROM invoice_reminders r "
        "  LEFT JOIN invoices i ON i.id = r.invoice_id "
        "  LEFT JOIN customers c ON c.id = r.customer_id "
        " WHERE r.tenant_id = ? ORDER BY r.sent_at DESC LIMIT ?",
        (tenant_id, limit)).fetchall()]


# ─────────────────────────────────────────────────────────────────────────
# Payment reconciliation
#
# maxgleam_portal._sync_checkouts already flips an invoice to paid, but only
# while the customer is *looking at the portal payments page*. A customer who
# pays on SumUp's hosted checkout and then closes the tab never reloads that
# page, so the invoice sits 'unpaid' with a completed checkout behind it — and
# the overdue sweep above would text them a "you still owe us" reminder for
# money they have already handed over. Chasing a paid invoice is the one
# mistake this whole feature must never make.
#
# This is the server-side settle: poll SumUp for every unpaid invoice that has
# a checkout and flip the ones SumUp reports PAID. It is a read against SumUp
# whose only write is unpaid -> paid, so it is idempotent and cron-safe, and it
# runs regardless of the email/SMS dry-run flags — marking a genuinely-paid
# invoice paid is a settle, never a "send".
# ─────────────────────────────────────────────────────────────────────────

def reconcile_payments(tenant_id: int = DEFAULT_TENANT_ID,
                       company_id: int | None = None,
                       limit: int = 100) -> tuple[int, dict]:
    """Flip invoices whose SumUp checkout has completed but weren't marked paid."""
    now = int(time.time())
    tenant = _tenant(tenant_id)
    api_key = ((tenant or {}).get("sumup_api_key") or "").strip()
    if not api_key:
        return 200, {"checked": 0, "reconciled": [], "reconciled_count": 0,
                     "reconciled_pence": 0, "errors": [], "ran_at": now,
                     "note": "SumUp is not configured for this tenant"}

    # _INVOICE_SELECT omits sumup_checkout_id, so this poll uses its own query.
    sql = ("SELECT i.id, i.number, i.amount_pence, i.customer_id, "
           "       i.sumup_checkout_id "
           "  FROM invoices i "
           "  LEFT JOIN jobs j ON j.id = i.job_id "
           "  LEFT JOIN properties p ON p.id = j.property_id "
           " WHERE i.status = 'unpaid' AND i.tenant_id = ? "
           "   AND i.sumup_checkout_id IS NOT NULL AND i.sumup_checkout_id != ''")
    args: list = [tenant_id]
    if company_id is not None:
        sql += " AND p.partner_company_id = ?"
        args.append(company_id)
    sql += " ORDER BY i.issued_at ASC LIMIT ?"
    args.append(limit)

    pending = _rows(sql, tuple(args))
    conn = _conn()
    reconciled: list[dict] = []
    errors: list[dict] = []
    for inv in pending:
        try:
            ck = sumup.checkout_status(api_key=api_key,
                                       checkout_id=inv["sumup_checkout_id"])
        except sumup.SumUpError as exc:
            # A SumUp outage settles nothing this run; the invoice stays unpaid
            # and is retried next time rather than being lost.
            log.warning("maxgleam: sumup status failed for %s: %s", inv["number"], exc)
            errors.append({"number": inv["number"], "error": str(exc)})
            continue
        if ck.get("status") != "PAID":
            continue
        # The status guard keeps the flip idempotent under a concurrent portal
        # sync — whichever writer gets there first wins, the other is a no-op.
        cur = conn.execute(
            "UPDATE invoices SET status = 'paid', method = 'sumup_online', "
            "paid_at = strftime('%s','now') WHERE id = ? AND status = 'unpaid'",
            (inv["id"],))
        if cur.rowcount:
            reconciled.append({"id": inv["id"], "number": inv["number"],
                               "amount_pence": inv["amount_pence"]})
    if reconciled:
        conn.commit()
        log.info("maxgleam: reconciled %d invoice(s) as paid from SumUp: %s",
                 len(reconciled), ", ".join(r["number"] for r in reconciled))

    return 200, {
        "checked": len(pending),
        "reconciled": reconciled,
        "reconciled_count": len(reconciled),
        "reconciled_pence": sum(r["amount_pence"] for r in reconciled),
        "still_unpaid": len(pending) - len(reconciled),
        "errors": errors,
        "ran_at": now,
    }


# ─────────────────────────────────────────────────────────────────────────
# Offline payments
#
# reconcile_payments() settles SumUp *online* checkouts, but plenty of cleans
# are paid in cash, by bank transfer, or on a SumUp card reader at the door.
# Nothing wrote those, so an offline-paid invoice stayed 'unpaid' forever and
# the overdue sweep kept texting the customer a charge notice they didn't owe.
# This lets the office — or a partner, for their own jobs — record that money.
# ─────────────────────────────────────────────────────────────────────────

# Methods that may be keyed in by hand. 'sumup_online' is deliberately absent:
# an online card payment is settled from SumUp itself by reconcile_payments,
# never typed in, so it also cannot be reverted by the office action below.
OFFLINE_METHODS = ("cash", "transfer", "sumup_reader")

_payments_local = threading.local()


def _payments_conn() -> sqlite3.Connection:
    """The maxgleam connection, with the invoice_payments ledger guaranteed.

    Each recorded payment (part or full) is one append-only row; the invoice's
    stored status is a rollup of them — unpaid → partial → paid. Created lazily
    like invoice_reminders so no schema.sql migration is needed on the live DB.
    """
    conn = _conn()
    if not getattr(_payments_local, "ready", False):
        conn.execute("""
            CREATE TABLE IF NOT EXISTS invoice_payments (
              id           INTEGER PRIMARY KEY AUTOINCREMENT,
              tenant_id    INTEGER NOT NULL,
              invoice_id   INTEGER NOT NULL REFERENCES invoices(id),
              amount_pence INTEGER NOT NULL,
              method       TEXT NOT NULL,      -- cash | transfer | sumup_reader
              note         TEXT,
              paid_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
              created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
            )""")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_invoice_payments_inv "
                     "ON invoice_payments(invoice_id)")
        conn.commit()
        _payments_local.ready = True
    return conn


def _ledger_total(invoice_id: int) -> int:
    row = _one("SELECT COALESCE(SUM(amount_pence), 0) AS p "
               "FROM invoice_payments WHERE invoice_id = ?", (invoice_id,))
    return int((row or {}).get("p") or 0)


def _outstanding(row: dict) -> int:
    """Pence still owed on a fetched invoice row (0 for paid/void)."""
    if row["status"] in ("paid", "void"):
        return 0
    return max(0, (row["amount_pence"] or 0) - (row.get("ledger_paid") or 0))


def record_payment(invoice_id: int, method: str, amount_pence: int | None = None,
                   paid_at: int | None = None, note: str | None = None,
                   tenant_id: int = DEFAULT_TENANT_ID,
                   company_id: int | None = None) -> tuple[int, dict]:
    """Record a payment against an invoice: cash / transfer / card reader.

    amount_pence omitted settles the whole outstanding balance (the common
    case); a smaller amount is a part-payment that moves the invoice to
    'partial' and leaves the remainder owing. Overpayment is refused.
    """
    method = (method or "").strip().lower()
    if method not in OFFLINE_METHODS:
        return 400, {"error": "method must be one of " + ", ".join(OFFLINE_METHODS)}
    conn = _payments_conn()
    row = _one(_INVOICE_SELECT + " WHERE i.id = ? AND i.tenant_id = ?",
               (invoice_id, tenant_id))
    if not row:
        return 404, {"error": "invoice not found"}
    if company_id is not None and row.get("partner_company_id") != company_id:
        return 404, {"error": "invoice not found"}
    if row["status"] == "void":
        return 409, {"error": "this invoice has been cancelled"}

    outstanding = _outstanding(row)
    if outstanding <= 0:
        return 409, {"error": "this invoice is already paid in full"}

    amt = outstanding if amount_pence is None else int(amount_pence)
    if amt <= 0:
        return 400, {"error": "payment amount must be more than zero"}
    if amt > outstanding:
        return 400, {"error": f"that's more than the £{outstanding / 100:.2f} still outstanding"}

    when = int(paid_at) if paid_at else int(time.time())
    conn.execute(
        "INSERT INTO invoice_payments (tenant_id, invoice_id, amount_pence, method, note, paid_at) "
        "VALUES (?,?,?,?,?,?)",
        (tenant_id, invoice_id, amt, method, (note or None), when))
    # Recompute the rollup from the ledger itself — authoritative even if two
    # payments raced — and flip status accordingly. reconcile_payments only
    # touches status='unpaid', so it never fights a partial invoice.
    received = _ledger_total(invoice_id)
    fully = received >= (row["amount_pence"] or 0)
    conn.execute("UPDATE invoices SET status = ?, method = ?, paid_at = ? WHERE id = ?",
                 ("paid" if fully else "partial", method, when if fully else None, invoice_id))
    try:
        remaining = max(0, (row["amount_pence"] or 0) - received)
        tail = "paid in full" if fully else f"£{remaining / 100:.2f} still due"
        conn.execute(
            "INSERT INTO comms_log (tenant_id, customer_id, kind, content) VALUES (?,?,?,?)",
            (tenant_id, row["customer_id"], "payment_recorded",
             f"Invoice {row['number']}: £{amt / 100:.2f} by {method.replace('_', ' ')} — {tail}"))
    except Exception:                                          # noqa: BLE001
        log.exception("comms_log write failed")
    conn.commit()
    log.info("maxgleam: invoice %s +£%.2f by %s (%s)", row["number"], amt / 100, method,
             "paid" if fully else "partial")

    fresh = _one(_INVOICE_SELECT + " WHERE i.id = ?", (invoice_id,))
    return 200, {"ok": True, "invoice": _invoice_dto(fresh, int(time.time()))}


def unmark_payment(invoice_id: int, tenant_id: int = DEFAULT_TENANT_ID,
                   company_id: int | None = None) -> tuple[int, dict]:
    """Reverse the most recent recorded payment (keyed in by mistake).

    Removing the last part-payment drops the invoice back to 'partial' if money
    remains, or 'unpaid' if that was the only one. An online SumUp payment
    reflects money SumUp has actually taken, so it is never un-settled here.
    """
    conn = _payments_conn()
    row = _one(_INVOICE_SELECT + " WHERE i.id = ? AND i.tenant_id = ?",
               (invoice_id, tenant_id))
    if not row:
        return 404, {"error": "invoice not found"}
    if company_id is not None and row.get("partner_company_id") != company_id:
        return 404, {"error": "invoice not found"}
    if row["method"] == "sumup_online":
        return 409, {"error": "an online card payment can't be reversed here"}

    last = _one("SELECT id FROM invoice_payments WHERE invoice_id = ? "
                "ORDER BY paid_at DESC, id DESC LIMIT 1", (invoice_id,))
    if not last:
        # A legacy full mark (status 'paid', no ledger rows) reverts wholesale.
        if row["status"] != "paid":
            return 409, {"error": "there's no recorded payment to reverse"}
        conn.execute("UPDATE invoices SET status = 'unpaid', method = NULL, paid_at = NULL "
                     "WHERE id = ?", (invoice_id,))
        conn.commit()
    else:
        conn.execute("DELETE FROM invoice_payments WHERE id = ?", (last["id"],))
        received = _ledger_total(invoice_id)
        if received <= 0:
            conn.execute("UPDATE invoices SET status = 'unpaid', method = NULL, paid_at = NULL "
                         "WHERE id = ?", (invoice_id,))
        else:
            recent = _one("SELECT method FROM invoice_payments WHERE invoice_id = ? "
                          "ORDER BY paid_at DESC, id DESC LIMIT 1", (invoice_id,))
            conn.execute("UPDATE invoices SET status = 'partial', method = ?, paid_at = NULL "
                         "WHERE id = ?", ((recent or {}).get("method"), invoice_id))
        conn.commit()
    log.info("maxgleam: invoice %s — last payment reversed", row["number"])

    fresh = _one(_INVOICE_SELECT + " WHERE i.id = ?", (invoice_id,))
    return 200, {"ok": True, "invoice": _invoice_dto(fresh, int(time.time()))}


def payment_history(invoice_id: int, tenant_id: int = DEFAULT_TENANT_ID,
                    company_id: int | None = None) -> tuple[int, dict]:
    """The ledger of payments recorded against one invoice, newest first."""
    _payments_conn()
    row = _one(_INVOICE_SELECT + " WHERE i.id = ? AND i.tenant_id = ?",
               (invoice_id, tenant_id))
    if not row:
        return 404, {"error": "invoice not found"}
    if company_id is not None and row.get("partner_company_id") != company_id:
        return 404, {"error": "invoice not found"}
    payments = [dict(r) for r in _conn().execute(
        "SELECT id, amount_pence, method, note, paid_at FROM invoice_payments "
        "WHERE invoice_id = ? ORDER BY paid_at DESC, id DESC", (invoice_id,)).fetchall()]
    dto = _invoice_dto(row, int(time.time()))
    return 200, {
        "invoice": dto,
        "payments": payments,
        "paid_pence": dto["paid_pence"],
        "outstanding_pence": dto["outstanding_pence"],
    }


# ─────────────────────────────────────────────────────────────────────────
# Invoice PDF
#
# A downloadable A4 invoice, rendered by the stdlib PDF writer in server.pdf
# (no reportlab/wkhtmltopdf on this box). Same data the email carries, so a
# customer who wants "a proper invoice for my records" gets one that matches.
# ─────────────────────────────────────────────────────────────────────────

_PDF_SELECT = """
  SELECT i.id, i.number, i.amount_pence, i.vat_pence, i.status, i.method,
         i.issued_at, i.paid_at, i.items_json, i.sumup_checkout_url,
         c.name AS customer_name, c.email AS customer_email,
         p.address, p.postcode, p.partner_company_id,
         COALESCE(pay.paid, 0) AS ledger_paid
    FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id
    LEFT JOIN jobs j ON j.id = i.job_id
    LEFT JOIN properties p ON p.id = j.property_id
    LEFT JOIN (SELECT invoice_id, SUM(amount_pence) AS paid
                 FROM invoice_payments GROUP BY invoice_id) pay ON pay.invoice_id = i.id
   WHERE i.id = ? AND i.tenant_id = ?
"""


def _money(pence: int | None) -> str:
    return f"£{(pence or 0) / 100:,.2f}"


def _date(ts: int | None) -> str:
    return dt.datetime.fromtimestamp(ts).strftime("%d %b %Y") if ts else "-"


def _render_invoice_pdf(row: dict, tenant: dict) -> bytes:
    from server import pdf as pdfmod

    doc = pdfmod.Pdf()
    L, R = 56.0, doc.w - 56.0
    ACCENT = (0.098, 0.765, 0.902)      # #19C3E6
    PAID_GREEN = (0.133, 0.702, 0.290)
    INK, MUTE, HAIR = 0.12, 0.45, 0.80

    now = int(time.time())
    issued = row.get("issued_at") or now
    gross = row["amount_pence"] or 0
    paid_pence = gross if row["status"] == "paid" else (
        0 if row["status"] == "void" else min(gross, row.get("ledger_paid") or 0))
    outstanding = 0 if row["status"] in ("paid", "void") else max(0, gross - paid_pence)
    part_paid = outstanding > 0 and paid_pence > 0
    overdue = (outstanding > 0 and row.get("issued_at")
               and now - row["issued_at"] > OVERDUE_DAYS * 86400)
    status_label = ("Paid" if row["status"] == "paid"
                    else "Void" if row["status"] == "void"
                    else "Part-paid" if part_paid
                    else "Overdue" if overdue else "Unpaid")

    # Header — company left, INVOICE + meta right.
    doc.text(L, 74, tenant.get("name") or "Max Gleam", size=22, bold=True, rgb=ACCENT)
    doc.text_right(R, 74, "INVOICE", size=22, bold=True, gray=INK)
    if tenant.get("email"):
        doc.text(L, 94, tenant["email"], size=9.5, gray=MUTE)
    doc.text_right(R, 92, row["number"], size=11, bold=True, gray=INK)
    doc.text_right(R, 107, "Issued " + _date(issued), size=9.5, gray=MUTE)
    doc.text_right(R, 120, "Status: " + status_label, size=9.5,
                   rgb=PAID_GREEN if status_label == "Paid" else None,
                   gray=None if status_label == "Paid" else MUTE)
    doc.line(L, 138, R, 138, width=1.2, rgb=ACCENT)

    # Bill to.
    y = 168
    doc.text(L, y, "BILL TO", size=8.5, bold=True, gray=MUTE)
    y += 16
    doc.text(L, y, row.get("customer_name") or "Customer", size=11, bold=True, gray=INK)
    for part in (row.get("address"), row.get("postcode"), row.get("customer_email")):
        if part:
            y += 13
            doc.text(L, y, part, size=9.5, gray=MUTE)

    # Line items.
    y += 40
    doc.text(L, y, "Description", size=8.5, bold=True, gray=MUTE)
    doc.text_right(R, y, "Amount", size=8.5, bold=True, gray=MUTE)
    y += 7
    doc.line(L, y, R, y, width=0.6, gray=HAIR)
    y += 20

    try:
        items = json.loads(row.get("items_json") or "[]")
    except (json.JSONDecodeError, TypeError):
        items = []
    if not isinstance(items, list) or not items:
        label = "Window cleaning"
        if row.get("address"):
            label += f" - {row['address']}"
        # Stored line items are net; the Subtotal row below prints gross - vat
        # (= net). Show the net figure here too so the single fallback line
        # agrees with the Subtotal instead of printing the gross amount.
        items = [{"label": label, "amount_pence": gross - (row.get("vat_pence") or 0)}]

    for it in items:
        desc = str(it.get("label") or it.get("description") or "Service")
        if len(desc) > 78:
            desc = desc[:75] + "..."
        doc.text(L, y, desc, size=10, gray=INK)
        doc.text_right(R, y, _money(it.get("amount_pence")), size=10, gray=INK)
        y += 18

    y += 4
    doc.line(L, y, R, y, width=0.6, gray=HAIR)
    y += 20

    vat = row["vat_pence"] or 0
    if vat:
        doc.text_right(R - 96, y, "Subtotal", size=10, gray=MUTE)
        doc.text_right(R, y, _money(gross - vat), size=10, gray=INK)
        y += 17
        doc.text_right(R - 96, y, "VAT", size=10, gray=MUTE)
        doc.text_right(R, y, _money(vat), size=10, gray=INK)
        y += 17
    doc.text_right(R - 96, y, "Total", size=11, bold=True, gray=INK)
    doc.text_right(R, y, _money(gross), size=11, bold=True, gray=INK)
    if part_paid:
        y += 17
        doc.text_right(R - 96, y, "Paid", size=10, gray=MUTE)
        doc.text_right(R, y, "-" + _money(paid_pence), size=10, rgb=PAID_GREEN)
        y += 17
        doc.text_right(R - 96, y, "Balance due", size=11, bold=True, gray=INK)
        doc.text_right(R, y, _money(outstanding), size=11, bold=True, gray=INK)

    # Payment status / call to action.
    y += 40
    if row["status"] == "paid":
        note = "PAID" + (f" on {_date(row['paid_at'])}" if row.get("paid_at") else "")
        if row.get("method"):
            note += f"  ({str(row['method']).replace('_', ' ')})"
        doc.text(L, y, note, size=11, bold=True, rgb=PAID_GREEN)
    elif row["status"] == "void":
        doc.text(L, y, "This invoice has been cancelled.", size=10, gray=MUTE)
    else:
        due = outstanding if part_paid else gross
        doc.text(L, y, f"Amount due: {_money(due)}", size=11, bold=True, gray=INK)
        if row.get("sumup_checkout_url"):
            y += 16
            doc.text(L, y, "Pay online:", size=9.5, gray=MUTE)
            doc.text(L + doc.text_width("Pay online: ", 9.5), y,
                     row["sumup_checkout_url"], size=9, rgb=ACCENT)

    # Footer.
    doc.line(L, doc.h - 60, R, doc.h - 60, width=0.5, gray=0.88)
    doc.text(L, doc.h - 44, "Thank you for your business.", size=9, gray=MUTE)
    doc.text_right(R, doc.h - 44, "Generated " + _date(now), size=8, gray=0.6)
    return doc.build()


def invoice_pdf(invoice_id: int, tenant_id: int = DEFAULT_TENANT_ID,
                company_id: int | None = None):
    """Return (200, pdf_bytes, 'application/pdf') for one invoice, or a JSON error.

    company_id scopes a partner to their own company's invoices: a partner
    token can never pull a PDF for a job that isn't theirs.
    """
    _payments_conn()          # the ledger JOIN in _PDF_SELECT needs the table
    row = _one(_PDF_SELECT, (invoice_id, tenant_id))
    if not row:
        return 404, {"error": "invoice not found"}
    if company_id is not None and row.get("partner_company_id") != company_id:
        return 404, {"error": "invoice not found"}
    tenant = _tenant(tenant_id) or {}
    return 200, _render_invoice_pdf(row, tenant), "application/pdf"


# ─────────────────────────────────────────────────────────────────────────
# Recurring auto-send
#
# auto_generate() above invoices every completed-but-uninvoiced job. The
# recurring path adds two things on top:
#
#   * sign-off gating — an invoice raised before the customer has signed off
#     is a chargeback waiting to happen, so the recurring sweep only bills
#     jobs the customer (or the auto-approve timer) has accepted;
#   * a run log, so "when did this last fire and what did it do" is answerable
#     without reading the invoice table and inferring.
# ─────────────────────────────────────────────────────────────────────────

SIGNED_OFF = ("signed", "auto-approved")

# Invoice numbering. The live series is INV-<year>-<seq> and continues
# maxgleam's own numbering; set MAXGLEAM_INVOICE_PREFIX=MG to mint MG-<year>-<seq>
# instead. Changing it forks the series, so it is deliberately opt-in.
NUMBER_PREFIX = os.environ.get("MAXGLEAM_INVOICE_PREFIX", "INV").strip() or "INV"


def _ensure_autosend_schema(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS invoice_autosend_runs (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id     INTEGER NOT NULL,
          created_count INTEGER NOT NULL DEFAULT 0,
          emailed_count INTEGER NOT NULL DEFAULT 0,
          skipped_count INTEGER NOT NULL DEFAULT 0,
          candidates    INTEGER NOT NULL DEFAULT 0,
          dry_run       INTEGER NOT NULL DEFAULT 0,
          detail_json   TEXT NOT NULL DEFAULT '{}',
          ran_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )""")
    conn.execute("""CREATE INDEX IF NOT EXISTS idx_autosend_runs_tenant
                    ON invoice_autosend_runs(tenant_id, ran_at)""")
    conn.commit()


def signed_off_uninvoiced(tenant_id: int = DEFAULT_TENANT_ID,
                          company_id: int | None = None) -> list[dict]:
    """Completed AND signed-off jobs that have no invoice yet."""
    placeholders = ",".join("?" for _ in SIGNED_OFF)
    sql = _JOB_FOR_INVOICE + (
        " WHERE j.status = 'done' AND j.tenant_id = ?"
        f"   AND j.signoff_status IN ({placeholders})"
        "   AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.job_id = j.id)")
    args: list = [tenant_id, *SIGNED_OFF]
    if company_id is not None:
        sql += " AND (j.partner_company_id = ? OR p.partner_company_id = ?)"
        args += [company_id, company_id]
    sql += " ORDER BY j.completed_at ASC, j.id ASC"
    return _rows(sql, tuple(args))


def auto_send(tenant_id: int = DEFAULT_TENANT_ID, company_id: int | None = None,
              *, dry_run: bool | None = None, limit: int = 200,
              require_signoff: bool = True) -> tuple[int, dict]:
    """Raise and email invoices for completed, signed-off jobs.

    Idempotent by construction: a job with an invoice against it is no longer
    a candidate, so re-running bills nobody twice.
    """
    conn = _conn()
    _ensure_autosend_schema(conn)
    if dry_run is None:
        dry_run = DRY_RUN

    jobs = (signed_off_uninvoiced(tenant_id, company_id) if require_signoff
            else uninvoiced_jobs(tenant_id, company_id))[:limit]

    created, skipped = [], []
    emailed = 0
    for job in jobs:
        if dry_run:
            skipped.append({"job_id": job["id"], "address": job["address"],
                            "amount_pence": _invoice_amount(job),
                            "customer_email": job.get("customer_email"),
                            "reason": "dry_run"})
            continue
        invoice, outcome = invoice_job(job["id"], tenant_id, send=True)
        if outcome == "created" and invoice:
            sent_ok = bool(job.get("customer_email"))
            emailed += 1 if sent_ok else 0
            created.append({"invoice_id": invoice["id"], "number": invoice["number"],
                            "job_id": job["id"], "amount_pence": invoice["amount_pence"],
                            "address": job["address"],
                            "customer_email": job.get("customer_email"),
                            "emailed": sent_ok})
        else:
            skipped.append({"job_id": job["id"], "address": job["address"],
                            "reason": outcome})

    result = {"created": created, "skipped": skipped,
              "created_count": len(created), "emailed_count": emailed,
              "skipped_count": len(skipped), "candidates": len(jobs),
              "require_signoff": require_signoff, "dry_run": dry_run,
              "ran_at": int(time.time())}

    conn.execute(
        """INSERT INTO invoice_autosend_runs
             (tenant_id, created_count, emailed_count, skipped_count, candidates,
              dry_run, detail_json, ran_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (tenant_id, len(created), emailed, len(skipped), len(jobs),
         1 if dry_run else 0,
         json.dumps({"created": created[:50], "skipped": skipped[:50]}),
         result["ran_at"]))
    conn.commit()
    return 200, result


def recurring_status(tenant_id: int = DEFAULT_TENANT_ID,
                     company_id: int | None = None) -> tuple[int, dict]:
    """Last auto-send run, plus what is queued for the next one."""
    conn = _conn()
    _ensure_autosend_schema(conn)

    last = _one("""SELECT id, created_count, emailed_count, skipped_count,
                          candidates, dry_run, ran_at
                     FROM invoice_autosend_runs
                    WHERE tenant_id = ? ORDER BY ran_at DESC, id DESC LIMIT 1""",
                (tenant_id,))
    if last:
        last["dry_run"] = bool(last["dry_run"])

    pending = signed_off_uninvoiced(tenant_id, company_id)
    # Uninvoiced minus billable = still waiting on the customer's sign-off.
    # Derived by difference rather than reading signoff_status, because the
    # shared _JOB_FOR_INVOICE projection does not carry that column.
    billable = {j["id"] for j in pending}
    awaiting = [j for j in uninvoiced_jobs(tenant_id, company_id)
                if j["id"] not in billable]

    recent = _rows("""SELECT id, number, amount_pence, status, issued_at, job_id
                        FROM invoices WHERE tenant_id = ?
                    ORDER BY issued_at DESC, id DESC LIMIT 10""", (tenant_id,))

    return 200, {
        "last_run": last,
        "last_run_at": last["ran_at"] if last else None,
        "pending_count": len(pending),
        "pending_pence": sum(_invoice_amount(j) for j in pending),
        "pending": [{"job_id": j["id"], "address": j["address"],
                     "amount_pence": _invoice_amount(j),
                     "customer_email": j.get("customer_email"),
                     "completed_at": j.get("completed_at")}
                    for j in pending[:50]],
        "awaiting_signoff_count": len(awaiting),
        "recent_invoices": recent,
        "number_prefix": NUMBER_PREFIX,
        "next_number": _next_number(tenant_id),
        "dry_run": DRY_RUN,
        "mail_configured": bool(_read_secret(RESEND_KEY_PATH)),
    }
