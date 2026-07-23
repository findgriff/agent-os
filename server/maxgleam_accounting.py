"""Max Gleam — accounting exports for QuickBooks / Xero.

Three read-only views of the invoice book, shaped for an accountant rather
than for the dashboard:

    invoices_csv    every invoice — Date, Invoice#, Customer, Amount, VAT, Total, Status
    payments_csv    every settled invoice — Date, Invoice#, Customer, Amount, Method
    tax_summary     revenue, VAT collected and paid/unpaid split as JSON

Nothing here writes. An export can be run as often as you like, by anyone
who can already see the invoice list, without side effects.

Dates default to DD/MM/YYYY because both QuickBooks UK and Xero UK import
in the organisation's locale format; pass dates=iso for YYYY-MM-DD when
feeding something that wants unambiguous dates.

Voided invoices are excluded from every total — they were never revenue —
but they still appear in the invoice CSV with status "void" so the exported
numbering has no gaps for the accountant to chase.
"""
from __future__ import annotations

import csv
import datetime as dt
import io
import os
import time

from server import maxgleam_invoicing as inv
from server import partner

DEFAULT_TENANT_ID = int(os.environ.get("MAXGLEAM_TENANT_ID", "2"))

# Invoice methods, mapped to what an accountant expects to read in a
# payments export. Anything unrecognised passes through unchanged.
METHOD_LABELS = {
    "cash": "Cash",
    "transfer": "Bank Transfer",
    "sumup_reader": "Card (SumUp Reader)",
    "sumup_online": "Card (SumUp Online)",
}


def _conn():
    return partner._conn()


def _rows(sql: str, args=()) -> list[dict]:
    return [dict(r) for r in _conn().execute(sql, args).fetchall()]


# ------------------------------------------------------------------ dates --

def _fmt_date(epoch: int | None, iso: bool = False) -> str:
    if not epoch:
        return ""
    d = dt.datetime.fromtimestamp(epoch)
    return d.strftime("%Y-%m-%d" if iso else "%d/%m/%Y")


def _day_bounds(frm: str, to: str) -> tuple[int | None, int | None]:
    """YYYY-MM-DD strings → (start_epoch, exclusive_end_epoch).

    Either side may be blank, which means "no bound on that side" — the
    default export is the whole book rather than an arbitrary window.
    """
    def parse(value: str) -> dt.date | None:
        try:
            return dt.date.fromisoformat((value or "").strip())
        except ValueError:
            return None

    start, end = parse(frm), parse(to)
    if start and end and end < start:
        start, end = end, start
    return (
        int(dt.datetime.combine(start, dt.time.min).timestamp()) if start else None,
        # `to` is inclusive of the whole day it names.
        int(dt.datetime.combine(end + dt.timedelta(days=1), dt.time.min).timestamp())
        if end else None,
    )


def _pounds(pence: int | None) -> str:
    """Plain decimal, no currency symbol or thousands separator — both
    QuickBooks and Xero reject "£1,234.00" but take "1234.00"."""
    return f"{(pence or 0) / 100:.2f}"


# ---------------------------------------------------------------- fetching --

_SELECT = """
  SELECT i.id, i.number, i.amount_pence, i.vat_pence, i.status, i.method,
         i.issued_at, i.paid_at, i.job_id, i.customer_id,
         c.name AS customer_name, c.email AS customer_email,
         j.scheduled_date, p.address, p.postcode, p.partner_company_id
    FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id
    LEFT JOIN jobs j ON j.id = i.job_id
    LEFT JOIN properties p ON p.id = j.property_id
"""


def _fetch(tenant_id: int, company_id: int | None, frm: str, to: str,
           date_field: str = "issued_at", paid_only: bool = False) -> list[dict]:
    """Invoices in a date window, ordered oldest first.

    date_field picks which date the window applies to: invoices are filtered
    on when they were raised, payments on when they settled. Filtering
    payments by issue date would drop a January invoice paid in February
    from February's payment run, which is exactly the reconciliation the
    export exists to support.
    """
    sql = _SELECT + " WHERE i.tenant_id = ?"
    args: list = [tenant_id]
    if company_id is not None:
        sql += " AND p.partner_company_id = ?"
        args.append(company_id)
    if paid_only:
        sql += " AND i.status = 'paid'"

    start, end = _day_bounds(frm, to)
    if start is not None:
        sql += f" AND i.{date_field} >= ?"
        args.append(start)
    if end is not None:
        sql += f" AND i.{date_field} < ?"
        args.append(end)

    sql += f" ORDER BY i.{date_field} ASC, i.id ASC"
    return _rows(sql, tuple(args))


def _display_status(row: dict, now: int) -> str:
    """What the accountant should read. 'Overdue' is derived from an unpaid
    invoice's age — the invoices table only stores paid/unpaid/void."""
    if row["status"] != "unpaid":
        return row["status"].capitalize()
    if row["issued_at"] and now - row["issued_at"] > inv.OVERDUE_DAYS * 86400:
        return "Overdue"
    return "Unpaid"


# ----------------------------------------------------------------- exports --

def invoices_csv(frm: str = "", to: str = "", tenant_id: int = DEFAULT_TENANT_ID,
                 company_id: int | None = None,
                 iso_dates: bool = False) -> tuple[int, str, str]:
    """Every invoice as CSV: Date, Invoice#, Customer, Amount, VAT, Total, Status.

    Amount is net of VAT and Total is the gross actually billed, so
    Amount + VAT = Total on every row and the columns foot cleanly.
    """
    rows = _fetch(tenant_id, company_id, frm, to, "issued_at")
    now = int(time.time())

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Date", "Invoice#", "Customer", "Amount", "VAT", "Total", "Status"])
    for r in rows:
        gross = r["amount_pence"] or 0
        vat = r["vat_pence"] or 0
        w.writerow([
            _fmt_date(r["issued_at"], iso_dates),
            r["number"] or "",
            r["customer_name"] or "",
            _pounds(gross - vat),
            _pounds(vat),
            _pounds(gross),
            _display_status(r, now),
        ])
    return 200, buf.getvalue(), "text/csv"


def payments_csv(frm: str = "", to: str = "", tenant_id: int = DEFAULT_TENANT_ID,
                 company_id: int | None = None,
                 iso_dates: bool = False) -> tuple[int, str, str]:
    """Settled invoices as CSV: Date, Invoice#, Customer, Amount, Method.

    Dated and filtered on paid_at, not issue date — this is a cash-received
    report. Amount is the gross received, which is what hits the bank.
    """
    rows = _fetch(tenant_id, company_id, frm, to, "paid_at", paid_only=True)

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Date", "Invoice#", "Customer", "Amount", "Method"])
    for r in rows:
        method = (r["method"] or "").strip()
        w.writerow([
            _fmt_date(r["paid_at"], iso_dates),
            r["number"] or "",
            r["customer_name"] or "",
            _pounds(r["amount_pence"]),
            METHOD_LABELS.get(method, method or "Unrecorded"),
        ])
    return 200, buf.getvalue(), "text/csv"


def tax_summary(frm: str = "", to: str = "", tenant_id: int = DEFAULT_TENANT_ID,
                company_id: int | None = None) -> tuple[int, dict]:
    """Revenue, VAT and settlement for a date range, with a monthly split.

    Voids are dropped from every figure. The paid/unpaid split is by invoice
    status today, not as at the end of the range — an invoice raised in
    January and paid in March reads as paid.
    """
    rows = [r for r in _fetch(tenant_id, company_id, frm, to, "issued_at")
            if r["status"] != "void"]
    now = int(time.time())

    gross = sum(r["amount_pence"] or 0 for r in rows)
    vat = sum(r["vat_pence"] or 0 for r in rows)
    paid_rows = [r for r in rows if r["status"] == "paid"]
    paid = sum(r["amount_pence"] or 0 for r in paid_rows)
    unpaid_rows = [r for r in rows if r["status"] == "unpaid"]
    overdue_rows = [r for r in unpaid_rows
                    if r["issued_at"] and now - r["issued_at"] > inv.OVERDUE_DAYS * 86400]

    status = inv.vat_status(tenant_id)
    # Not VAT registered → nothing was charged, and the report must not
    # invent a liability. Show what it would be at the standard rate so the
    # figure is there for planning, clearly labelled as not collected.
    notional = 0 if status["vat_registered"] else round(gross - gross / 1.2)

    months: dict[str, dict] = {}
    for r in rows:
        if not r["issued_at"]:
            continue
        key = dt.datetime.fromtimestamp(r["issued_at"]).strftime("%Y-%m")
        m = months.setdefault(key, {"month": key, "invoices": 0, "gross_pence": 0,
                                    "net_pence": 0, "vat_pence": 0, "paid_pence": 0})
        m["invoices"] += 1
        m["gross_pence"] += r["amount_pence"] or 0
        m["vat_pence"] += r["vat_pence"] or 0
        m["net_pence"] += (r["amount_pence"] or 0) - (r["vat_pence"] or 0)
        if r["status"] == "paid":
            m["paid_pence"] += r["amount_pence"] or 0

    by_method: dict[str, dict] = {}
    for r in paid_rows:
        key = (r["method"] or "").strip() or "unrecorded"
        m = by_method.setdefault(key, {
            "method": key, "label": METHOD_LABELS.get(key, key.capitalize()),
            "count": 0, "amount_pence": 0})
        m["count"] += 1
        m["amount_pence"] += r["amount_pence"] or 0

    return 200, {
        "from": (frm or "").strip(), "to": (to or "").strip(),
        "generated_at": now,
        "overdue_days": inv.OVERDUE_DAYS,
        "totals": {
            "revenue_gross_pence": gross,
            "revenue_net_pence": gross - vat,
            "vat_collected_pence": vat,
            "paid_pence": paid,
            "unpaid_pence": sum(r["amount_pence"] or 0 for r in unpaid_rows),
            "overdue_pence": sum(r["amount_pence"] or 0 for r in overdue_rows),
            "invoice_count": len(rows),
            "paid_count": len(paid_rows),
            "unpaid_count": len(unpaid_rows),
            "overdue_count": len(overdue_rows),
            "notional_vat_at_20_pence": notional,
        },
        "by_month": [months[k] for k in sorted(months)],
        "by_method": sorted(by_method.values(),
                            key=lambda m: m["amount_pence"], reverse=True),
        **status,
    }
