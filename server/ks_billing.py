"""KS Sports Coaching — monthly subscriptions and automated billing.

Parents can move off pay-per-session onto a monthly plan. On the 1st of each
month the billing run raises one invoice per active subscription, attaches a
SumUp pay-link and texts it to the parent.

IMPORTANT — what "auto-charge" means here
-----------------------------------------
server/sumup.py speaks one dialect of the SumUp API: hosted checkouts. A
hosted checkout is a page the *customer* opens and pays on. It carries no
stored card, no mandate and no merchant-initiated transaction, so nothing in
this file can silently take money from a parent on the 1st of the month.

What the billing run therefore does is: raise the invoice, mint a pay-link,
send it, and leave the invoice `pending` until `reconcile()` sees SumUp
report it paid. That is genuine automation of the invoicing and the chasing,
but the parent still taps "pay". True auto-charge needs a mandate-based rail
— GoCardless Direct Debit is the usual answer for UK youth-sport monthlies,
and Direct Debit is also what parents expect for a monthly club fee.

Merchant account
----------------
SumUp credentials are per-tenant in the maxgleam database, and there is no
KS tenant there today — only Chester Window Cleaner. Billing therefore stays
link-less until KS_SUMUP_TENANT_ID names a tenant holding KS's own SumUp
key. It deliberately does not fall back to the default tenant: that would
route parents' money into the window-cleaning merchant account.

Kill-switch: KS_BILLING_DRY_RUN=1 raises invoice rows but sends nothing and
calls no payment API.
"""
from __future__ import annotations
import calendar
import datetime as dt
import logging
import os
import time

from server import ks

log = logging.getLogger("agentos.ks_billing")

DRY_RUN = os.environ.get("KS_BILLING_DRY_RUN", "") == "1"

# Tenant in /var/lib/maxgleam/app.db whose sumup_api_key belongs to KS.
# Unset → invoices are raised without a pay-link (see module docstring).
SUMUP_TENANT_ID = os.environ.get("KS_SUMUP_TENANT_ID", "").strip()

# Plan pricing. PLACEHOLDER COMMERCIAL TERMS: knowledge.json prices sessions
# (£35 1-to-1, £25 small group) but says nothing about monthly plans, so
# these are a first cut — a per-session discount that grows with commitment.
# Override per plan with KS_PLAN_4_SESSIONS_PENCE etc. once KS has signed
# the real numbers off.
PLANS = [
    {"key": "4-sessions", "label": "4 sessions a month",
     "sessions": 4, "amount_pence": 12000,
     "blurb": "One session a week. £30 a session — £5 off the 1-to-1 rate."},
    {"key": "8-sessions", "label": "8 sessions a month",
     "sessions": 8, "amount_pence": 22000,
     "blurb": "Twice a week. £27.50 a session."},
    {"key": "unlimited", "label": "Unlimited sessions",
     "sessions": None, "amount_pence": 30000,
     "blurb": "Every session we run, one monthly price."},
]


def plans() -> list[dict]:
    out = []
    for p in PLANS:
        env = os.environ.get(f"KS_PLAN_{p['key'].upper().replace('-', '_')}_PENCE", "").strip()
        amount = int(env) if env.isdigit() else p["amount_pence"]
        out.append({**p, "amount_pence": amount})
    return out


def _plan(key: str) -> dict | None:
    return next((p for p in plans() if p["key"] == key), None)


# -------------------------------------------------------------- calendar ---

def _today() -> dt.date:
    return dt.datetime.now(ks.UK).date()


def _first_of_next_month(d: dt.date) -> dt.date:
    return dt.date(d.year + (d.month == 12), 1 if d.month == 12 else d.month + 1, 1)


def _month_end(d: dt.date) -> dt.date:
    return dt.date(d.year, d.month, calendar.monthrange(d.year, d.month)[1])


# ---------------------------------------------------------------- lookup ---

def _sub_dto(s: dict, with_usage: bool = False) -> dict:
    plan = _plan(s["plan"]) or {}
    out = {
        "id": s["id"],
        "parent_email": s["parent_email"],
        "plan": s["plan"],
        "plan_label": plan.get("label", s["plan"]),
        "sessions_included": plan.get("sessions"),
        "amount_pence": s["amount_pence"],
        "active": bool(s["active"]),
        "next_billing_date": s["next_billing_date"],
        "created_at": s["created_at"],
        "cancelled_at": s["cancelled_at"],
    }
    if with_usage:
        start = _today().replace(day=1)
        used = ks._one(
            "SELECT COUNT(*) AS n FROM bookings "
            " WHERE lower(parent_email) = ? AND status != 'cancelled' AND date >= ?",
            (s["parent_email"].lower(), start.isoformat()))
        out["sessions_used_this_month"] = (used or {}).get("n", 0)
        out["allowance_remaining"] = (
            None if plan.get("sessions") is None
            else max(0, plan["sessions"] - out["sessions_used_this_month"]))
    return out


def _invoice_dto(i: dict) -> dict:
    return {
        "id": i["id"], "subscription_id": i["subscription_id"],
        "period_start": i["period_start"], "period_end": i["period_end"],
        "amount_pence": i["amount_pence"], "status": i["status"],
        "checkout_url": i["checkout_url"], "paid_at": i["paid_at"],
        "created_at": i["created_at"],
    }


def active_for(email: str) -> dict | None:
    return ks._one("SELECT * FROM subscriptions WHERE lower(parent_email) = ? AND active = 1",
                   ((email or "").strip().lower(),))


# ---------------------------------------------------------------- create ---

def create(parent: dict, body: dict) -> tuple[int, dict]:
    plan = _plan((body.get("plan") or "").strip())
    if not plan:
        return 400, {"error": "choose a plan"}
    email = parent["email"].strip().lower()
    if active_for(email):
        return 409, {"error": "you already have an active plan — cancel it first to switch"}

    # First bill goes out on the 1st of next month. The rest of the current
    # month rides free rather than being pro-rated: a parent signing up on
    # the 28th must not be charged a full month for three days.
    next_billing = _first_of_next_month(_today()).isoformat()
    conn = ks._conn()
    cur = conn.execute(
        "INSERT INTO subscriptions (parent_email, plan, amount_pence, active, next_billing_date) "
        "VALUES (?,?,?,1,?)", (email, plan["key"], plan["amount_pence"], next_billing))
    conn.commit()
    sub = ks._one("SELECT * FROM subscriptions WHERE id = ?", (cur.lastrowid,))
    log.info("ks billing: %s subscribed to %s", email, plan["key"])
    return 200, {"subscription": _sub_dto(sub, with_usage=True),
                 "first_bill_on": next_billing}


def cancel(parent: dict, body: dict) -> tuple[int, dict]:
    sub = active_for(parent["email"])
    if not sub:
        return 404, {"error": "you don't have an active plan"}
    conn = ks._conn()
    # The month already paid for is not clawed back — the plan simply stops
    # renewing, so next_billing_date is cleared rather than kept pending.
    conn.execute("UPDATE subscriptions SET active = 0, cancelled_at = ?, "
                 "next_billing_date = NULL WHERE id = ?", (int(time.time()), sub["id"]))
    conn.commit()
    sub = ks._one("SELECT * FROM subscriptions WHERE id = ?", (sub["id"],))
    return 200, {"subscription": _sub_dto(sub),
                 "note": "Your plan won't renew. Sessions you've already paid for still stand."}


def status(parent: dict) -> tuple[int, dict]:
    sub = active_for(parent["email"])
    if not sub:
        # Show the most recent cancelled plan so the portal can say "ended
        # on ..." rather than pretending the parent never had one.
        sub = ks._one("SELECT * FROM subscriptions WHERE lower(parent_email) = ? "
                      "ORDER BY id DESC LIMIT 1", (parent["email"].lower(),))
    invoices = []
    if sub:
        invoices = [_invoice_dto(i) for i in ks._rows(
            "SELECT * FROM subscription_invoices WHERE subscription_id = ? "
            "ORDER BY period_start DESC LIMIT 24", (sub["id"],))]
    return 200, {
        "subscription": _sub_dto(sub, with_usage=True) if sub else None,
        "invoices": invoices,
        "plans": plans(),
    }


# --------------------------------------------------------------- payment ---

def _tenant() -> dict | None:
    """The maxgleam tenant holding KS's SumUp key, if one is configured."""
    if not SUMUP_TENANT_ID.isdigit():
        return None
    try:
        from server import partner
        row = partner._conn().execute(
            "SELECT * FROM tenants WHERE id = ?", (int(SUMUP_TENANT_ID),)).fetchone()
    except Exception:                                       # noqa: BLE001
        log.exception("ks billing: could not read tenant %s", SUMUP_TENANT_ID)
        return None
    return dict(row) if row else None


def _pay_link(invoice: dict, sub: dict) -> str:
    """Mint a SumUp hosted-checkout link. Best effort — never fatal.

    A payment-provider outage must not stop the invoice being raised; the
    parent can be sent a link later by re-running the billing sweep.
    """
    if invoice.get("checkout_url"):
        return invoice["checkout_url"]
    if DRY_RUN:
        log.info("KS DRY-RUN checkout for invoice %s (%s pence)",
                 invoice["id"], invoice["amount_pence"])
        return ""
    tenant = _tenant()
    if not tenant:
        return ""
    api_key = (tenant.get("sumup_api_key") or "").strip()
    code = (tenant.get("sumup_merchant_code") or "").strip()
    if not api_key or not code:
        return ""
    try:
        from server import sumup
        ck = sumup.create_hosted_checkout(
            api_key=api_key, merchant_code=code,
            amount_pence=invoice["amount_pence"],
            currency=tenant.get("currency") or "GBP",
            reference=f"ks-sub-{sub['id']}-{invoice['period_start']}",
            description=f"KS Sports Coaching — {sub['plan']} — {invoice['period_start'][:7]}")
    except Exception as exc:                                # noqa: BLE001
        log.warning("ks billing: checkout failed for invoice %s: %s", invoice["id"], exc)
        return ""
    url = ck.get("hosted_checkout_url") or ""
    if url:
        conn = ks._conn()
        conn.execute("UPDATE subscription_invoices SET checkout_id = ?, checkout_url = ? "
                     "WHERE id = ?", (ck.get("id"), url, invoice["id"]))
        conn.commit()
        invoice["checkout_id"] = ck.get("id")
        invoice["checkout_url"] = url
    return url


def _send_invoice(sub: dict, invoice: dict, url: str) -> str:
    if DRY_RUN:
        return "dry_run"
    parent = ks.parent_by_email(sub["parent_email"])
    if not parent:
        return "no_parent"
    if parent.get("sms_opt_out"):
        return "skipped_opt_out"
    phone = (parent.get("phone") or "").strip()
    if not phone:
        return "no_phone"
    amount = f"£{invoice['amount_pence'] / 100:.2f}".replace(".00", "")
    month = dt.date.fromisoformat(invoice["period_start"]).strftime("%B")
    body = (f"KS Sports: your {month} plan is {amount}. "
            + (f"Pay here: {url}" if url else "We'll be in touch with payment details.")
            + " Thanks for training with us!")
    return ks.send_notice(phone, body, "subscription_invoice")


# ---------------------------------------------------------- billing cycle ---

def run_billing(now_date: str | None = None) -> dict:
    """Raise and send this period's invoices. Idempotent — safe to re-run.

    Idempotency rests on UNIQUE (subscription_id, period_start): a second run
    on the same day hits the constraint and skips, so a cron that fires twice
    cannot bill a parent twice.
    """
    today = dt.date.fromisoformat(now_date) if now_date else _today()
    due = ks._rows(
        "SELECT * FROM subscriptions WHERE active = 1 AND next_billing_date IS NOT NULL "
        "  AND next_billing_date <= ? ORDER BY id", (today.isoformat(),))

    result = {"date": today.isoformat(), "due": len(due),
              "invoiced": 0, "skipped": 0, "sent": 0, "dry_run": DRY_RUN,
              "invoices": []}
    conn = ks._conn()

    for sub in due:
        period_start = dt.date.fromisoformat(sub["next_billing_date"])
        period_end = _month_end(period_start)
        try:
            cur = conn.execute(
                "INSERT INTO subscription_invoices "
                "  (subscription_id, period_start, period_end, amount_pence, status) "
                "VALUES (?,?,?,?, 'pending')",
                (sub["id"], period_start.isoformat(), period_end.isoformat(),
                 sub["amount_pence"]))
            conn.commit()
        except Exception:                                   # noqa: BLE001 — UNIQUE clash
            result["skipped"] += 1
            _advance(conn, sub, period_start)
            continue

        invoice = ks._one("SELECT * FROM subscription_invoices WHERE id = ?", (cur.lastrowid,))
        result["invoiced"] += 1
        url = _pay_link(invoice, sub)
        if _send_invoice(sub, invoice, url) in ("sent", "dry_run"):
            result["sent"] += 1
        _advance(conn, sub, period_start)
        result["invoices"].append({**_invoice_dto(
            ks._one("SELECT * FROM subscription_invoices WHERE id = ?", (invoice["id"],))),
            "parent_email": sub["parent_email"]})

    return result


def _advance(conn, sub: dict, billed_period: dt.date) -> None:
    """Move the subscription on to the next month.

    Computed from the period just billed, not from today: a sweep that was
    down for a fortnight must catch up month by month, not skip to now and
    lose a month's revenue.
    """
    conn.execute("UPDATE subscriptions SET next_billing_date = ? WHERE id = ?",
                 (_first_of_next_month(billed_period).isoformat(), sub["id"]))
    conn.commit()


def reconcile() -> dict:
    """Ask SumUp which pending invoices have been paid, and mark them off."""
    pending = ks._rows(
        "SELECT * FROM subscription_invoices WHERE status = 'pending' "
        "  AND checkout_id IS NOT NULL ORDER BY id LIMIT 200")
    out = {"checked": len(pending), "paid": 0, "failed": 0}
    if DRY_RUN or not pending:
        return out
    tenant = _tenant()
    api_key = (tenant or {}).get("sumup_api_key") or ""
    if not api_key:
        return out

    from server import sumup
    conn = ks._conn()
    for inv in pending:
        try:
            st = sumup.checkout_status(api_key=api_key, checkout_id=inv["checkout_id"])
        except Exception as exc:                            # noqa: BLE001
            log.warning("ks billing: status check failed for %s: %s", inv["id"], exc)
            continue
        state = (st.get("status") or "").upper()
        if state == "PAID":
            conn.execute("UPDATE subscription_invoices SET status = 'paid', paid_at = ? "
                         "WHERE id = ?", (int(time.time()), inv["id"]))
            conn.commit()
            out["paid"] += 1
            _send_receipt(inv)
        elif state == "FAILED":
            conn.execute("UPDATE subscription_invoices SET status = 'failed' WHERE id = ?",
                         (inv["id"],))
            conn.commit()
            out["failed"] += 1
    return out


def _send_receipt(invoice: dict) -> str:
    sub = ks._one("SELECT * FROM subscriptions WHERE id = ?", (invoice["subscription_id"],))
    if not sub:
        return "no_subscription"
    parent = ks.parent_by_email(sub["parent_email"])
    if not parent or parent.get("sms_opt_out") or not (parent.get("phone") or "").strip():
        return "skipped"
    amount = f"£{invoice['amount_pence'] / 100:.2f}".replace(".00", "")
    month = dt.date.fromisoformat(invoice["period_start"]).strftime("%B")
    return ks.send_notice(
        parent["phone"],
        f"KS Sports: thanks — {amount} received for your {month} plan. See you on the pitch!",
        "subscription_receipt")
