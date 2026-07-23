"""Max Gleam — subcontractor commission tracking.

A commission is accrued once a job is both done and signed off (or
auto-approved), and sits at 'pending' until the office marks it paid.

Accrual is a sweep, not a hook. Jobs reach 'done' from several places — the
crew app, the office, a bulk status change, maxgleam's own endpoints — and
a hook on any one of them would silently miss the others. `accrue()` scans
for eligible jobs with no commission row and is strictly idempotent: a
UNIQUE index on job_id means running it twice, or racing two callers,
cannot pay anyone twice. It runs on every read of this module's endpoints,
so the list is never stale.

Rate basis
----------
The brief specifies commission = price * (rate_per_clean / 100), i.e. that
rate_per_clean is a percentage. In this database it is not: the column is
documented as "what you pay them per clean (pence)" and holds 8000 (£80)
and 14000 (£140) against jobs priced at 2000 (£20). Read as a percentage
those become £1,600 and £2,800 of commission on a £20 clean.

So the basis is chosen from the value: 1–100 is treated as a percentage,
anything above as a flat pence-per-clean rate. Which basis was used is
recorded in the commission's notes, so no figure here is unexplained.
MAXGLEAM_COMMISSION_BASIS=percent|flat forces one interpretation if the
office would rather be explicit than have it inferred.
"""
from __future__ import annotations

import datetime as dt
import logging
import os
import sqlite3
import threading
import time

from server import partner

log = logging.getLogger("agentos.mg_commissions")

DEFAULT_TENANT_ID = int(os.environ.get("MAXGLEAM_TENANT_ID", "2"))

# auto | percent | flat
BASIS_MODE = (os.environ.get("MAXGLEAM_COMMISSION_BASIS", "auto") or "auto").lower()

# A rate at or below this reads as a percentage; above it, as pence per clean.
PERCENT_CEILING = 100

STATUSES = ("pending", "paid")

# Only jobs the customer has accepted earn a commission.
SIGNED_OFF = ("signed", "auto-approved")

_local = threading.local()


def _conn() -> sqlite3.Connection:
    conn = partner._conn()
    if not getattr(_local, "schema_ready", False):
        _ensure_schema(conn)
        _local.schema_ready = True
    return conn


def _ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS commissions (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id        INTEGER NOT NULL,
          job_id           INTEGER NOT NULL REFERENCES jobs(id),
          subcontractor_id INTEGER NOT NULL REFERENCES subcontractors(id),
          amount_pence     INTEGER NOT NULL,
          status           TEXT NOT NULL DEFAULT 'pending',   -- pending|paid
          paid_at          INTEGER,
          notes            TEXT,
          created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )""")
    # The guarantee that a re-run of the sweep cannot accrue a job twice.
    conn.execute("""CREATE UNIQUE INDEX IF NOT EXISTS idx_commissions_job
                    ON commissions(job_id)""")
    conn.execute("""CREATE INDEX IF NOT EXISTS idx_commissions_crew
                    ON commissions(tenant_id, subcontractor_id, status)""")
    conn.commit()


def _rows(sql: str, args=()) -> list[dict]:
    return [dict(r) for r in _conn().execute(sql, args).fetchall()]


def _one(sql: str, args=()) -> dict | None:
    r = _conn().execute(sql, args).fetchone()
    return dict(r) if r else None


# -------------------------------------------------------------------- rate --

def calculate(price_pence: int, rate_per_clean: int) -> tuple[int, str]:
    """Commission for one job. Returns (amount_pence, basis_note).

    Never returns more than it can explain: the basis note travels with the
    figure into the commission row so an odd-looking payment can always be
    traced back to the rate that produced it.
    """
    price = max(0, int(price_pence or 0))
    rate = max(0, int(rate_per_clean or 0))
    if not rate or not price:
        return 0, "no rate or no price on the job"

    percent = (BASIS_MODE == "percent"
               or (BASIS_MODE == "auto" and rate <= PERCENT_CEILING))
    if percent:
        return round(price * rate / 100), f"{rate}% of £{price / 100:.2f}"
    # Flat rate: deliberately not capped at the job price. A subcontractor on
    # £80 per clean doing a £20 job is a pricing problem for the office to
    # see, not one for this module to hide by quietly paying them less.
    return rate, f"flat £{rate / 100:.2f} per clean"


# ----------------------------------------------------------------- accrual --

_ELIGIBLE = """
  SELECT j.id AS job_id, j.tenant_id, j.price_pence, j.subcontractor_id,
         j.scheduled_date, j.signoff_at, j.completed_at,
         s.rate_per_clean, s.name AS crew_name
    FROM jobs j
    JOIN subcontractors s ON s.id = j.subcontractor_id
   WHERE j.tenant_id = ?
     AND j.status = 'done'
     AND j.signoff_status IN ('signed','auto-approved')
     AND j.subcontractor_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM commissions c WHERE c.job_id = j.id)
   ORDER BY j.signoff_at ASC, j.id ASC
"""


def accrue(tenant_id: int = DEFAULT_TENANT_ID, limit: int = 500) -> dict:
    """Create pending commissions for every signed-off job that has none."""
    conn = _conn()
    created, skipped = [], []
    for job in _rows(_ELIGIBLE, (tenant_id,))[:limit]:
        amount, basis = calculate(job["price_pence"], job["rate_per_clean"])
        if amount <= 0:
            skipped.append({"job_id": job["job_id"], "reason": basis})
            continue
        try:
            conn.execute(
                "INSERT INTO commissions (tenant_id, job_id, subcontractor_id, "
                " amount_pence, status, notes) VALUES (?,?,?,?, 'pending', ?)",
                (job["tenant_id"] or tenant_id, job["job_id"],
                 job["subcontractor_id"], amount, basis))
            conn.commit()
        except sqlite3.IntegrityError:
            # Lost a race with a concurrent sweep — the other one accrued it.
            conn.rollback()
            continue
        created.append({"job_id": job["job_id"], "crew_name": job["crew_name"],
                        "amount_pence": amount, "basis": basis})
    return {"created": created, "created_count": len(created),
            "skipped": skipped, "skipped_count": len(skipped)}


def accrue_quietly(tenant_id: int = DEFAULT_TENANT_ID) -> None:
    """Accrual for callers that must not fail because of it — the sign-off
    path, mainly. A commission that misses its hook is picked up by the next
    read of the commissions list anyway."""
    try:
        accrue(tenant_id)
    except Exception:                                       # noqa: BLE001
        log.exception("maxgleam: commission accrual failed")


# ----------------------------------------------------------------- reading --

_SELECT = """
  SELECT co.id, co.tenant_id, co.job_id, co.subcontractor_id, co.amount_pence,
         co.status, co.paid_at, co.notes, co.created_at,
         s.name AS crew_name, s.company_name AS crew_company,
         s.rate_per_clean,
         j.scheduled_date, j.price_pence AS job_price_pence, j.signoff_at,
         p.address, p.postcode, p.partner_company_id,
         c.name AS customer_name
    FROM commissions co
    JOIN subcontractors s ON s.id = co.subcontractor_id
    LEFT JOIN jobs j ON j.id = co.job_id
    LEFT JOIN properties p ON p.id = j.property_id
    LEFT JOIN customers c ON c.id = p.customer_id
"""


def _dto(r: dict) -> dict:
    job_price = r.get("job_price_pence") or 0
    return {
        **r,
        # What the job leaves behind once the crew is paid. Negative is a
        # real answer, and the one the office most needs to see.
        "margin_pence": job_price - (r["amount_pence"] or 0),
        "margin_pct": (round((job_price - r["amount_pence"]) / job_price * 100)
                       if job_price else None),
    }


def _month_start(now: int | None = None) -> int:
    today = dt.date.fromtimestamp(now or time.time())
    return int(dt.datetime.combine(today.replace(day=1), dt.time.min).timestamp())


def _day_bounds(frm: str, to: str) -> tuple[int | None, int | None]:
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
        int(dt.datetime.combine(end + dt.timedelta(days=1), dt.time.min).timestamp())
        if end else None,
    )


def list_commissions(tenant_id: int = DEFAULT_TENANT_ID, company_id: int | None = None,
                     crew_id: int | None = None, status: str = "",
                     frm: str = "", to: str = "", limit: int = 500) -> tuple[int, dict]:
    """Commissions, newest first, with totals for whatever the filters selected.

    The date range applies to when the commission was accrued, which is when
    the job was signed off — not when it was paid. A crew asking "what am I
    owed for July's work" means the former.
    """
    accrue_quietly(tenant_id)

    sql = _SELECT + " WHERE co.tenant_id = ?"
    args: list = [tenant_id]
    if company_id is not None:
        sql += " AND p.partner_company_id = ?"
        args.append(company_id)
    if crew_id is not None:
        sql += " AND co.subcontractor_id = ?"
        args.append(crew_id)

    start, end = _day_bounds(frm, to)
    if start is not None:
        sql += " AND co.created_at >= ?"
        args.append(start)
    if end is not None:
        sql += " AND co.created_at < ?"
        args.append(end)

    sql += " ORDER BY co.created_at DESC, co.id DESC LIMIT ?"
    args.append(limit)

    rows = [_dto(r) for r in _rows(sql, tuple(args))]

    wanted = (status or "").strip().lower()
    shown = [r for r in rows if r["status"] == wanted] if wanted in STATUSES else rows

    by_crew: dict[int, dict] = {}
    for r in rows:
        m = by_crew.setdefault(r["subcontractor_id"], {
            "crew_id": r["subcontractor_id"], "name": r["crew_name"],
            "company_name": r["crew_company"], "rate_per_clean": r["rate_per_clean"],
            "jobs": 0, "pending_pence": 0, "paid_pence": 0, "total_pence": 0})
        m["jobs"] += 1
        m["total_pence"] += r["amount_pence"]
        m["pending_pence" if r["status"] == "pending" else "paid_pence"] += r["amount_pence"]

    return 200, {
        "commissions": shown,
        "summary": {
            "count": len(rows),
            "pending_count": sum(1 for r in rows if r["status"] == "pending"),
            "paid_count": sum(1 for r in rows if r["status"] == "paid"),
            "pending_pence": sum(r["amount_pence"] for r in rows if r["status"] == "pending"),
            "paid_pence": sum(r["amount_pence"] for r in rows if r["status"] == "paid"),
            "total_pence": sum(r["amount_pence"] for r in rows),
            "job_value_pence": sum(r["job_price_pence"] or 0 for r in rows),
        },
        "by_crew": sorted(by_crew.values(), key=lambda m: m["total_pence"], reverse=True),
        "crews": crews(tenant_id),
        "filter": {"crew_id": crew_id, "status": wanted or "all",
                   "from": (frm or "").strip(), "to": (to or "").strip()},
        "basis_mode": BASIS_MODE,
    }


def crews(tenant_id: int = DEFAULT_TENANT_ID) -> list[dict]:
    """Active subcontractors, for the crew filter."""
    return _rows(
        "SELECT id, name, company_name, rate_per_clean FROM subcontractors "
        " WHERE tenant_id = ? AND active = 1 ORDER BY name", (tenant_id,))


def summary(tenant_id: int = DEFAULT_TENANT_ID,
            company_id: int | None = None) -> tuple[int, dict]:
    """Total pending, and what has actually been paid out this month."""
    accrue_quietly(tenant_id)

    sql = _SELECT + " WHERE co.tenant_id = ?"
    args: list = [tenant_id]
    if company_id is not None:
        sql += " AND p.partner_company_id = ?"
        args.append(company_id)
    rows = _rows(sql, tuple(args))

    now = int(time.time())
    month_start = _month_start(now)
    pending = [r for r in rows if r["status"] == "pending"]
    # Paid *this month* is by payment date, not accrual date — this is the
    # cash-out figure, so a June job settled in July belongs to July.
    paid_month = [r for r in rows
                  if r["status"] == "paid" and (r["paid_at"] or 0) >= month_start]

    oldest = min((r["created_at"] for r in pending), default=None)

    by_crew: dict[int, dict] = {}
    for r in pending:
        m = by_crew.setdefault(r["subcontractor_id"], {
            "crew_id": r["subcontractor_id"], "name": r["crew_name"],
            "jobs": 0, "pending_pence": 0})
        m["jobs"] += 1
        m["pending_pence"] += r["amount_pence"]

    return 200, {
        "generated_at": now,
        "month_start": dt.date.fromtimestamp(month_start).isoformat(),
        "pending_count": len(pending),
        "pending_pence": sum(r["amount_pence"] for r in pending),
        "paid_this_month_count": len(paid_month),
        "paid_this_month_pence": sum(r["amount_pence"] for r in paid_month),
        "paid_all_time_pence": sum(r["amount_pence"] for r in rows
                                   if r["status"] == "paid"),
        "oldest_pending_at": oldest,
        "oldest_pending_days": int((now - oldest) / 86400) if oldest else None,
        "pending_by_crew": sorted(by_crew.values(),
                                  key=lambda m: m["pending_pence"], reverse=True),
        "basis_mode": BASIS_MODE,
    }


# ----------------------------------------------------------------- writing --

def mark_paid(commission_id: int, body: dict | None = None,
              tenant_id: int = DEFAULT_TENANT_ID,
              company_id: int | None = None) -> tuple[int, dict]:
    """Mark one commission paid. Already-paid is reported, never re-stamped."""
    row = _one(_SELECT + " WHERE co.id = ? AND co.tenant_id = ?",
               (commission_id, tenant_id))
    if not row:
        return 404, {"error": "commission not found"}
    if company_id is not None and row["partner_company_id"] != company_id:
        return 404, {"error": "commission not found"}
    if row["status"] == "paid":
        return 200, {"commission": _dto(row), "status": "already paid"}

    note = ((body or {}).get("notes") or "").strip()
    notes = f"{row['notes']} · {note}" if note and row["notes"] else (note or row["notes"])

    conn = _conn()
    conn.execute("UPDATE commissions SET status = 'paid', paid_at = ?, notes = ? "
                 " WHERE id = ? AND status != 'paid'",
                 (int(time.time()), notes, commission_id))
    conn.commit()

    fresh = _one(_SELECT + " WHERE co.id = ?", (commission_id,))
    log.info("maxgleam: commission %s marked paid (%sp to %s)",
             commission_id, row["amount_pence"], row["crew_name"])
    return 200, {"commission": _dto(fresh), "status": "paid"}
