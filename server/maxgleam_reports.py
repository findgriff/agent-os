"""Max Gleam reporting + time tracking.

Reads and writes the maxgleam database (/var/lib/maxgleam/app.db), NOT the
AGENT OS one — same rule as server.partner and server.maxgleam_ops, and the
same shared thread-local connection so a request thread holds one handle.

Reporting
---------
Every figure is derived from the live jobs table. Money comes from
jobs.price_pence rather than invoices: the estate bills mostly on the round
and invoices are only raised for a subset, so invoice totals would understate
revenue badly. A job counts as revenue on the day it was COMPLETED
(completed_at), falling back to scheduled_date when a job was marked done
without a timestamp.

Ratings are parsed out of jobs.signoff_note, where the customer sign-off flow
encodes them as a leading `[n/5]` tag — the live jobs table has no rating
column and belongs to another running application (see maxgleam_portal).

Time tracking
-------------
time_logs records actual minutes on site per job, so the estimate the router
uses (maxgleam_ops.SERVICE_MINUTES) can be checked against reality. A crew
member has at most one open log at a time; clocking in again while open is
rejected rather than silently opening a second row, which would double-count
every hours total on this page.
"""
from __future__ import annotations

import csv
import io
import os
import re
import sqlite3
import threading
import time

from server import partner
from server.maxgleam_ops import DEFAULT_TENANT_ID, SERVICE_MINUTES

MAXGLEAM_DB = os.environ.get("MAXGLEAM_DB", "/var/lib/maxgleam/app.db")

# A sign-off not returned within this window is overdue. Mirrors
# maxgleam_portal.AUTO_APPROVE_HOURS — imported lazily to avoid a cycle.
RETENTION_WEEKS = 4          # "cleaned recently" window for the retention rate
REVENUE_DAYS = 30            # revenue chart span
DAY = 86400

_local = threading.local()


def _conn() -> sqlite3.Connection:
    conn = partner._conn()
    if not getattr(_local, "reports_schema_ready", False):
        _ensure_schema(conn)
        _local.reports_schema_ready = True
    return conn


def _ensure_schema(conn: sqlite3.Connection) -> None:
    """Additive only — never alters a column maxgleam already owns."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS time_logs (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id           INTEGER REFERENCES jobs(id),
          subcontractor_id INTEGER REFERENCES subcontractors(id),
          clock_in         INTEGER NOT NULL,
          clock_out        INTEGER,
          total_minutes    INTEGER,
          notes            TEXT,
          created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )""")
    conn.execute("""CREATE INDEX IF NOT EXISTS idx_time_logs_crew
                    ON time_logs(subcontractor_id, clock_in)""")
    conn.execute("""CREATE INDEX IF NOT EXISTS idx_time_logs_job
                    ON time_logs(job_id, clock_in)""")
    # Partial index over open logs — the clock-in path checks this on every
    # call, and open rows are a handful next to the full history.
    conn.execute("""CREATE INDEX IF NOT EXISTS idx_time_logs_open
                    ON time_logs(subcontractor_id) WHERE clock_out IS NULL""")
    conn.commit()


def _rows(sql: str, args=()) -> list[dict]:
    cur = _conn().execute(sql, args)
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def _one(sql: str, args=()) -> dict | None:
    got = _rows(sql, args)
    return got[0] if got else None


# ── helpers ─────────────────────────────────────────────────────────────

def _rating_of(note: str | None) -> int | None:
    """Star rating encoded as a leading [n/5] in signoff_note."""
    m = re.match(r"^\[(\d)/5\]", (note or "").strip())
    return int(m.group(1)) if m else None


def _today() -> str:
    return time.strftime("%Y-%m-%d")


def _day_of(epoch: int) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(epoch))


def _day_start(epoch: int | None = None) -> int:
    """Local midnight for the day containing `epoch` (default: now)."""
    t = time.localtime(epoch if epoch is not None else time.time())
    return int(time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, -1)))


def _scope(tenant_id: int, company_id: int | None,
           alias: str = "j") -> tuple[str, list]:
    """WHERE fragment + args restricting to a tenant and, for a partner
    caller, that partner's own estate. Partners must never see the wider
    round — the same isolation rule the rest of the MG surface holds to."""
    where = f" AND {alias}.tenant_id = ?"
    args: list = [tenant_id]
    if company_id is not None:
        where += (f" AND ({alias}.partner_company_id = ?"
                  " OR p.partner_company_id = ?)")
        args += [company_id, company_id]
    return where, args


def _revenue_day(job: dict) -> str:
    """The day a completed job counts as revenue."""
    if job.get("completed_at"):
        return _day_of(int(job["completed_at"]))
    return job["scheduled_date"]


# ── reports ─────────────────────────────────────────────────────────────

def _done_jobs(tenant_id: int, company_id: int | None,
               since_epoch: int) -> list[dict]:
    """Completed jobs since a cutoff. Filtered in Python on the effective
    revenue day rather than in SQL: completed_at and scheduled_date are
    different types (epoch vs text), so one comparable expression per row is
    clearer than a COALESCE of two clashing formats inside the query."""
    where, args = _scope(tenant_id, company_id)
    since_day = _day_of(since_epoch)
    rows = _rows(
        """SELECT j.id, j.scheduled_date, j.completed_at, j.price_pence,
                  j.subcontractor_id, j.signoff_status, j.signoff_note,
                  j.property_id, p.address, p.postcode,
                  s.name AS crew_name, c.name AS customer_name
             FROM jobs j
             JOIN properties p ON p.id = j.property_id
             LEFT JOIN subcontractors s ON s.id = j.subcontractor_id
             LEFT JOIN customers c ON c.id = p.customer_id
            WHERE j.status = 'done'""" + where + " ORDER BY j.id DESC LIMIT 5000",
        tuple(args))
    return [r for r in rows if _revenue_day(r) >= since_day]


def _revenue_series(jobs: list[dict], days: int = REVENUE_DAYS) -> list[dict]:
    """One bucket per day for the last `days` days, oldest first. Empty days
    are kept at zero — a chart with the quiet days dropped out reads as a
    busier round than it is."""
    today = _day_start()
    buckets: dict[str, dict] = {}
    for i in range(days - 1, -1, -1):
        day = _day_of(today - i * DAY)
        buckets[day] = {"date": day, "revenue_pence": 0, "jobs": 0}
    for j in jobs:
        b = buckets.get(_revenue_day(j))
        if b:
            b["revenue_pence"] += j["price_pence"] or 0
            b["jobs"] += 1
    return list(buckets.values())


def _retention(tenant_id: int, company_id: int | None) -> dict:
    """Share of active recurring properties cleaned in the last N weeks.

    Ad-hoc properties (frequency_weeks = 0) are excluded: they are not on a
    round, so counting them as lapsed would drag the rate down for a reason
    that has nothing to do with retention.
    """
    # _scope's partner clause references j.*, and this query has no jobs row
    # on the outer side — build the property-only clause directly.
    clause = " AND p.tenant_id = ?"
    cargs: list = [tenant_id]
    if company_id is not None:
        clause += " AND p.partner_company_id = ?"
        cargs.append(company_id)

    total = _one("SELECT COUNT(*) AS n FROM properties p"
                 " WHERE p.active = 1 AND p.frequency_weeks > 0" + clause,
                 tuple(cargs))
    cutoff = _day_of(_day_start() - RETENTION_WEEKS * 7 * DAY)
    cleaned = _one(
        """SELECT COUNT(DISTINCT p.id) AS n
             FROM properties p
             JOIN jobs j ON j.property_id = p.id AND j.status = 'done'
            WHERE p.active = 1 AND p.frequency_weeks > 0
              AND COALESCE(DATE(j.completed_at, 'unixepoch'), j.scheduled_date) >= ?"""
        + clause, tuple([cutoff] + cargs))

    n_total = (total or {}).get("n") or 0
    n_cleaned = (cleaned or {}).get("n") or 0
    return {
        "active_properties": n_total,
        "cleaned_recently": n_cleaned,
        "lapsed": max(0, n_total - n_cleaned),
        "window_weeks": RETENTION_WEEKS,
        "rate_pct": round(100.0 * n_cleaned / n_total, 1) if n_total else 0.0,
    }


def _crew_performance(tenant_id: int, company_id: int | None,
                      jobs: list[dict]) -> list[dict]:
    """Per-crew completed jobs, revenue, average rating and actual minutes.

    Built from the same 30-day job set the rest of the page uses, so the crew
    table and the headline numbers can never disagree.
    """
    by_crew: dict[int, dict] = {}
    for j in jobs:
        cid = j["subcontractor_id"]
        if not cid:
            continue
        row = by_crew.setdefault(cid, {
            "crew_id": cid, "name": j.get("crew_name") or f"Crew #{cid}",
            "jobs_completed": 0, "revenue_pence": 0,
            "_ratings": [], "signed_off": 0,
        })
        row["jobs_completed"] += 1
        row["revenue_pence"] += j["price_pence"] or 0
        if j["signoff_status"] in ("signed", "auto-approved"):
            row["signed_off"] += 1
        rating = _rating_of(j["signoff_note"])
        if rating:
            row["_ratings"].append(rating)

    # Actual time on site, from any log closed in the same window.
    since = _day_start() - REVENUE_DAYS * DAY
    for t in _rows("""SELECT subcontractor_id AS cid,
                             COUNT(*) AS logs, SUM(total_minutes) AS mins
                        FROM time_logs
                       WHERE clock_out IS NOT NULL AND clock_in >= ?
                         AND subcontractor_id IS NOT NULL
                    GROUP BY subcontractor_id""", (since,)):
        row = by_crew.get(t["cid"])
        if row and t["logs"]:
            row["logged_jobs"] = t["logs"]
            row["avg_minutes"] = round((t["mins"] or 0) / t["logs"], 1)

    out = []
    for row in by_crew.values():
        ratings = row.pop("_ratings")
        row["avg_rating"] = round(sum(ratings) / len(ratings), 2) if ratings else None
        row["rated"] = len(ratings)
        row.setdefault("logged_jobs", 0)
        row.setdefault("avg_minutes", None)
        out.append(row)
    # Best first: most jobs, then best rating.
    out.sort(key=lambda r: (r["jobs_completed"], r["avg_rating"] or 0), reverse=True)
    return out


def _overdue_signoffs(tenant_id: int, company_id: int | None) -> dict:
    """Completed jobs whose sign-off is past the auto-approve window."""
    from server.maxgleam_portal import AUTO_APPROVE_HOURS
    cutoff = int(time.time()) - AUTO_APPROVE_HOURS * 3600
    where, args = _scope(tenant_id, company_id)
    rows = _rows(
        """SELECT j.id, j.scheduled_date, j.completed_at, j.price_pence,
                  p.address, s.name AS crew_name
             FROM jobs j
             JOIN properties p ON p.id = j.property_id
             LEFT JOIN subcontractors s ON s.id = j.subcontractor_id
            WHERE j.status = 'done'
              AND COALESCE(j.signoff_status, '') NOT IN ('signed', 'auto-approved')
              AND COALESCE(j.completed_at, 0) > 0
              AND j.completed_at < ?""" + where
        + " ORDER BY j.completed_at ASC LIMIT 200",
        tuple([cutoff] + args))
    return {
        "count": len(rows),
        "auto_approve_hours": AUTO_APPROVE_HOURS,
        "jobs": [{
            "job_id": r["id"], "address": r["address"],
            "scheduled_date": r["scheduled_date"],
            "completed_at": r["completed_at"],
            "crew_name": r["crew_name"],
            "price_pence": r["price_pence"] or 0,
            "days_overdue": max(0, int((time.time() - r["completed_at"]) // DAY)),
        } for r in rows],
    }


def reports(tenant_id: int = DEFAULT_TENANT_ID,
            company_id: int | None = None) -> tuple[int, dict]:
    """Every figure the reporting dashboard shows, in one round trip."""
    now = int(time.time())
    today0 = _day_start()
    since30 = today0 - (REVENUE_DAYS - 1) * DAY
    jobs = _done_jobs(tenant_id, company_id, since30)

    # This week runs Mon–today; this month runs from the 1st.
    lt = time.localtime()
    week_start = _day_of(today0 - lt.tm_wday * DAY)
    month_start = time.strftime("%Y-%m-01")

    week_jobs = [j for j in jobs if _revenue_day(j) >= week_start]
    month_jobs = [j for j in jobs if _revenue_day(j) >= month_start]
    revenue_30 = sum(j["price_pence"] or 0 for j in jobs)

    series = _revenue_series(jobs)
    ratings = [r for r in (_rating_of(j["signoff_note"]) for j in jobs) if r]

    # Actual vs estimated time, from closed logs in the same 30-day window.
    tl = _one("""SELECT COUNT(*) AS n, SUM(total_minutes) AS mins
                   FROM time_logs
                  WHERE clock_out IS NOT NULL AND clock_in >= ?""", (since30,))
    logged_n = (tl or {}).get("n") or 0
    logged_mins = (tl or {}).get("mins") or 0

    crew = _crew_performance(tenant_id, company_id, jobs)
    return 200, {
        "generated_at": now,
        "tenant_id": tenant_id,
        "window_days": REVENUE_DAYS,
        "revenue": {
            "series": series,
            "total_pence": revenue_30,
            "peak_pence": max((d["revenue_pence"] for d in series), default=0),
            "week_pence": sum(j["price_pence"] or 0 for j in week_jobs),
            "month_pence": sum(j["price_pence"] or 0 for j in month_jobs),
        },
        "jobs": {
            "completed_window": len(jobs),
            "completed_week": len(week_jobs),
            "completed_month": len(month_jobs),
            "week_start": week_start,
            "month_start": month_start,
            "avg_value_pence": round(revenue_30 / len(jobs)) if jobs else 0,
        },
        "ratings": {
            "average": round(sum(ratings) / len(ratings), 2) if ratings else None,
            "rated": len(ratings),
        },
        "retention": _retention(tenant_id, company_id),
        "crew": crew,
        "top_crew": crew[0] if crew else None,
        "overdue_signoffs": _overdue_signoffs(tenant_id, company_id),
        "time": {
            "logged_jobs": logged_n,
            "total_minutes": logged_mins,
            "avg_minutes": round(logged_mins / logged_n, 1) if logged_n else None,
            "estimated_minutes": SERVICE_MINUTES,
        },
    }


# ── CSV export ──────────────────────────────────────────────────────────

def _csv(header: list[str], rows: list[list]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(header)
    w.writerows(rows)
    return buf.getvalue()


def _pounds(pence) -> str:
    return f"{(pence or 0) / 100:.2f}"


EXPORTS = ("revenue", "jobs", "crew", "retention", "overdue", "time")


def export_csv(report: str, tenant_id: int = DEFAULT_TENANT_ID,
               company_id: int | None = None) -> tuple[int, str, str] | tuple[int, dict]:
    """One CSV per report. Returns a 3-tuple (status, body, content_type),
    which app.py sends raw."""
    if report not in EXPORTS:
        return 400, {"error": f"report must be one of: {', '.join(EXPORTS)}"}

    _status, data = reports(tenant_id, company_id)

    if report == "revenue":
        body = _csv(["date", "revenue_gbp", "jobs_completed"],
                    [[d["date"], _pounds(d["revenue_pence"]), d["jobs"]]
                     for d in data["revenue"]["series"]])
    elif report == "jobs":
        since30 = _day_start() - (REVENUE_DAYS - 1) * DAY
        body = _csv(
            ["job_id", "completed_day", "scheduled_date", "address", "postcode",
             "customer", "crew", "value_gbp", "signoff_status", "rating"],
            [[j["id"], _revenue_day(j), j["scheduled_date"], j["address"],
              j["postcode"] or "", j["customer_name"] or "", j["crew_name"] or "",
              _pounds(j["price_pence"]), j["signoff_status"] or "pending",
              _rating_of(j["signoff_note"]) or ""]
             for j in _done_jobs(tenant_id, company_id, since30)])
    elif report == "crew":
        body = _csv(
            ["crew_id", "name", "jobs_completed", "revenue_gbp", "avg_rating",
             "rated", "signed_off", "logged_jobs", "avg_minutes"],
            [[c["crew_id"], c["name"], c["jobs_completed"],
              _pounds(c["revenue_pence"]), c["avg_rating"] if c["avg_rating"] else "",
              c["rated"], c["signed_off"], c["logged_jobs"],
              c["avg_minutes"] if c["avg_minutes"] is not None else ""]
             for c in data["crew"]])
    elif report == "retention":
        r = data["retention"]
        body = _csv(["metric", "value"],
                    [["active_properties", r["active_properties"]],
                     ["cleaned_last_%dw" % r["window_weeks"], r["cleaned_recently"]],
                     ["lapsed", r["lapsed"]],
                     ["retention_rate_pct", r["rate_pct"]]])
    elif report == "overdue":
        body = _csv(
            ["job_id", "address", "scheduled_date", "crew", "value_gbp", "days_overdue"],
            [[j["job_id"], j["address"], j["scheduled_date"], j["crew_name"] or "",
              _pounds(j["price_pence"]), j["days_overdue"]]
             for j in data["overdue_signoffs"]["jobs"]])
    else:  # time
        body = _csv(
            ["log_id", "day", "job_id", "address", "crew", "clock_in", "clock_out",
             "total_minutes", "estimated_minutes", "notes"],
            [[t["id"], t["day"], t["job_id"] or "", t["address"] or "",
              t["crew_name"] or "", t["clock_in"], t["clock_out"] or "",
              t["total_minutes"] if t["total_minutes"] is not None else "",
              SERVICE_MINUTES, t["notes"] or ""]
             for t in _time_logs(tenant_id, company_id,
                                 since=_day_start() - (REVENUE_DAYS - 1) * DAY)])
    return 200, body, "text/csv"


# ── time tracking ───────────────────────────────────────────────────────

def _time_logs(tenant_id: int, company_id: int | None,
               since: int, until: int | None = None) -> list[dict]:
    """Logs started in a window, newest first, with job/crew context.

    A log with no job_id still belongs to the tenant via its crew, so the
    tenant filter is applied to the crew, not the job — otherwise a
    general-duties clock-in would vanish from the crew's own timesheet.
    """
    args: list = [since]
    where = " WHERE t.clock_in >= ?"
    if until is not None:
        where += " AND t.clock_in < ?"
        args.append(until)
    where += " AND (s.tenant_id = ? OR j.tenant_id = ?)"
    args += [tenant_id, tenant_id]
    if company_id is not None:
        where += " AND (j.partner_company_id = ? OR p.partner_company_id = ?)"
        args += [company_id, company_id]

    rows = _rows(
        """SELECT t.id, t.job_id, t.subcontractor_id, t.clock_in, t.clock_out,
                  t.total_minutes, t.notes, t.created_at,
                  s.name AS crew_name, p.address, p.postcode,
                  j.scheduled_date, j.price_pence
             FROM time_logs t
             LEFT JOIN subcontractors s ON s.id = t.subcontractor_id
             LEFT JOIN jobs j ON j.id = t.job_id
             LEFT JOIN properties p ON p.id = j.property_id""" + where
        + " ORDER BY t.clock_in DESC LIMIT 500", tuple(args))
    now = int(time.time())
    for r in rows:
        r["day"] = _day_of(r["clock_in"])
        r["open"] = r["clock_out"] is None
        # An open log still has elapsed time worth showing on the clock face.
        r["elapsed_minutes"] = (r["total_minutes"] if r["total_minutes"] is not None
                                else max(0, (now - r["clock_in"]) // 60))
        r["estimated_minutes"] = SERVICE_MINUTES
    return rows


def _crew_row(crew_id: int, tenant_id: int) -> dict | None:
    return _one("SELECT id, name, tenant_id FROM subcontractors"
                " WHERE id = ? AND tenant_id = ?", (crew_id, tenant_id))


def clock_in(body: dict, tenant_id: int = DEFAULT_TENANT_ID,
             company_id: int | None = None) -> tuple[int, dict]:
    """POST body: {crew_id, job_id?, notes?}."""
    try:
        crew_id = int(body.get("crew_id") or body.get("subcontractor_id") or 0)
    except (TypeError, ValueError):
        return 400, {"error": "crew_id must be a number"}
    if not crew_id:
        return 400, {"error": "crew_id is required"}
    crew = _crew_row(crew_id, tenant_id)
    if not crew:
        return 404, {"error": "crew member not found"}

    job_id = body.get("job_id")
    job = None
    if job_id not in (None, "", 0, "0"):
        try:
            job_id = int(job_id)
        except (TypeError, ValueError):
            return 400, {"error": "job_id must be a number"}
        where, args = _scope(tenant_id, company_id)
        job = _one("""SELECT j.id, j.scheduled_date, p.address
                        FROM jobs j JOIN properties p ON p.id = j.property_id
                       WHERE j.id = ?""" + where, tuple([job_id] + args))
        if not job:
            return 404, {"error": "job not found"}
    else:
        job_id = None

    open_log = _one("SELECT id, job_id, clock_in FROM time_logs"
                    " WHERE subcontractor_id = ? AND clock_out IS NULL"
                    " ORDER BY clock_in DESC LIMIT 1", (crew_id,))
    if open_log:
        # Two open logs would double-count every hours total on this page.
        return 409, {"error": "already clocked in — clock out first",
                     "open_log": {"id": open_log["id"], "job_id": open_log["job_id"],
                                  "clock_in": open_log["clock_in"]}}

    now = int(time.time())
    conn = _conn()
    cur = conn.execute(
        "INSERT INTO time_logs (job_id, subcontractor_id, clock_in, notes)"
        " VALUES (?,?,?,?)",
        (job_id, crew_id, now, (body.get("notes") or "").strip() or None))
    log_id = cur.lastrowid
    # Mirror the clock-in onto the job so the round board shows it in progress
    # — jobs.started_at already exists for exactly this.
    if job_id:
        conn.execute("UPDATE jobs SET started_at = COALESCE(started_at, ?)"
                     " WHERE id = ?", (now, job_id))
    conn.commit()
    return 200, {"log": {
        "id": log_id, "job_id": job_id, "subcontractor_id": crew_id,
        "clock_in": now, "clock_out": None, "total_minutes": None,
        "crew_name": crew["name"], "address": (job or {}).get("address"),
        "open": True, "elapsed_minutes": 0, "estimated_minutes": SERVICE_MINUTES,
    }}


def clock_out(body: dict, tenant_id: int = DEFAULT_TENANT_ID,
              company_id: int | None = None) -> tuple[int, dict]:
    """POST body: {crew_id} or {log_id}, plus optional notes."""
    log = None
    if body.get("log_id"):
        try:
            log = _one("SELECT * FROM time_logs WHERE id = ?", (int(body["log_id"]),))
        except (TypeError, ValueError):
            return 400, {"error": "log_id must be a number"}
    else:
        try:
            crew_id = int(body.get("crew_id") or body.get("subcontractor_id") or 0)
        except (TypeError, ValueError):
            return 400, {"error": "crew_id must be a number"}
        if not crew_id:
            return 400, {"error": "crew_id or log_id is required"}
        if not _crew_row(crew_id, tenant_id):
            return 404, {"error": "crew member not found"}
        log = _one("SELECT * FROM time_logs WHERE subcontractor_id = ?"
                   " AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1",
                   (crew_id,))
    if not log:
        return 404, {"error": "no open clock-in found"}
    if log["clock_out"] is not None:
        return 409, {"error": "that log is already clocked out"}

    now = int(time.time())
    # Round to the nearest minute, floor at 1: a 40-second call-back still
    # took someone off another job, and a 0-minute row reads as a mistake.
    minutes = max(1, round((now - log["clock_in"]) / 60))
    notes = (body.get("notes") or "").strip() or log["notes"]

    conn = _conn()
    conn.execute("UPDATE time_logs SET clock_out = ?, total_minutes = ?, notes = ?"
                 " WHERE id = ?", (now, minutes, notes, log["id"]))
    conn.commit()

    estimated = SERVICE_MINUTES
    return 200, {"log": {
        "id": log["id"], "job_id": log["job_id"],
        "subcontractor_id": log["subcontractor_id"],
        "clock_in": log["clock_in"], "clock_out": now,
        "total_minutes": minutes, "notes": notes, "open": False,
        "elapsed_minutes": minutes, "estimated_minutes": estimated,
        "variance_minutes": minutes - estimated,
    }}


def history(tenant_id: int = DEFAULT_TENANT_ID, company_id: int | None = None,
            day: str | None = None) -> tuple[int, dict]:
    """Time entries for one day (default today), plus the day's totals."""
    if day:
        try:
            t = time.strptime(day, "%Y-%m-%d")
        except ValueError:
            return 400, {"error": "day must be YYYY-MM-DD"}
        start = int(time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, -1)))
    else:
        day = _today()
        start = _day_start()

    logs = _time_logs(tenant_id, company_id, since=start, until=start + DAY)
    closed = [l for l in logs if not l["open"]]
    total_minutes = sum(l["total_minutes"] or 0 for l in closed)

    by_crew: dict[int, dict] = {}
    for l in logs:
        cid = l["subcontractor_id"]
        if not cid:
            continue
        row = by_crew.setdefault(cid, {
            "crew_id": cid, "name": l["crew_name"] or f"Crew #{cid}",
            "minutes": 0, "jobs": 0, "open": False,
        })
        if l["open"]:
            row["open"] = True
        else:
            row["minutes"] += l["total_minutes"] or 0
            row["jobs"] += 1
    crew_totals = sorted(by_crew.values(), key=lambda r: r["minutes"], reverse=True)

    return 200, {
        "day": day,
        "logs": logs,
        "open_count": sum(1 for l in logs if l["open"]),
        "summary": {
            "entries": len(logs),
            "completed": len(closed),
            "total_minutes": total_minutes,
            "total_hours": round(total_minutes / 60, 2),
            "avg_minutes": round(total_minutes / len(closed), 1) if closed else None,
            "estimated_minutes": SERVICE_MINUTES,
        },
        "by_crew": crew_totals,
    }


def board(tenant_id: int = DEFAULT_TENANT_ID, company_id: int | None = None,
          day: str | None = None) -> tuple[int, dict]:
    """What the /timeclock page needs to render: today's jobs, the crew list,
    and which crew are currently on the clock."""
    day = day or _today()
    where, args = _scope(tenant_id, company_id)
    jobs = _rows(
        """SELECT j.id, j.scheduled_date, j.status, j.price_pence,
                  j.subcontractor_id, j.started_at,
                  p.address, p.postcode, c.name AS customer_name,
                  s.name AS crew_name
             FROM jobs j
             JOIN properties p ON p.id = j.property_id
             LEFT JOIN customers c ON c.id = p.customer_id
             LEFT JOIN subcontractors s ON s.id = j.subcontractor_id
            WHERE j.scheduled_date = ?""" + where
        + " ORDER BY p.position, j.id LIMIT 300", tuple([day] + args))

    open_logs = {}
    for l in _rows("""SELECT t.id, t.job_id, t.subcontractor_id, t.clock_in,
                             s.name AS crew_name
                        FROM time_logs t
                        LEFT JOIN subcontractors s ON s.id = t.subcontractor_id
                       WHERE t.clock_out IS NULL
                         AND COALESCE(s.tenant_id, ?) = ?""",
                   (tenant_id, tenant_id)):
        l["elapsed_minutes"] = max(0, (int(time.time()) - l["clock_in"]) // 60)
        open_logs[l["subcontractor_id"]] = l

    # Minutes already logged today per job, so a second visit shows the total.
    logged: dict[int, int] = {}
    start = _day_start()
    for r in _rows("""SELECT job_id, SUM(total_minutes) AS mins FROM time_logs
                       WHERE job_id IS NOT NULL AND clock_out IS NOT NULL
                         AND clock_in >= ? GROUP BY job_id""", (start,)):
        logged[r["job_id"]] = r["mins"] or 0
    for j in jobs:
        j["logged_minutes"] = logged.get(j["id"], 0)
        j["estimated_minutes"] = SERVICE_MINUTES

    crews = _rows("SELECT id, name, company_name FROM subcontractors"
                  " WHERE tenant_id = ? AND active = 1 ORDER BY name",
                  (tenant_id,))
    for c in crews:
        c["open_log"] = open_logs.get(c["id"])

    return 200, {
        "day": day, "jobs": jobs, "crews": crews,
        "open_logs": list(open_logs.values()),
        "estimated_minutes": SERVICE_MINUTES,
    }
