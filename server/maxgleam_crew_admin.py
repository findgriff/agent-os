"""Max Gleam crew management — the office roster.

The crew-facing side (login, today's round, sign-off) lives in
server.maxgleam_crew; this is the *office* side: who's on the books, what you
pay them, when they're off, and what they've earned. It manages the
subcontractors table plus their leave (crew_availability) and pay history
(payroll_payments).

HQ-only surface — subcontractors belong to the tenant, not to any one partner,
so there's no partner-scoped view here. Runs against the maxgleam app DB via
server.partner's connection, like the other maxgleam_* modules.
"""
from __future__ import annotations

import os
import re
import time

from server import partner

DEFAULT_TENANT_ID = int(os.environ.get("MAXGLEAM_TENANT_ID", "2"))

LEAVE_KINDS = ("holiday", "sick", "unavailable")


def _conn():
    return partner._conn()


def _rows(sql: str, args=()) -> list[dict]:
    return [dict(r) for r in _conn().execute(sql, args).fetchall()]


def _one(sql: str, args=()) -> dict | None:
    r = _conn().execute(sql, args).fetchone()
    return dict(r) if r else None


def _today() -> str:
    return time.strftime("%Y-%m-%d")


def _int(v, default=0) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _crew(crew_id: int, tenant_id: int) -> dict | None:
    return _one("SELECT * FROM subcontractors WHERE id = ? AND tenant_id = ?",
                (crew_id, tenant_id))


# ── List ────────────────────────────────────────────────────────────

def list_crews(tenant_id: int = DEFAULT_TENANT_ID,
               include_inactive: bool = True) -> tuple[int, dict]:
    where = "WHERE tenant_id = ?" + ("" if include_inactive else " AND active = 1")
    crews = _rows(f"SELECT * FROM subcontractors {where} ORDER BY active DESC, name",
                  (tenant_id,))
    ids = [c["id"] for c in crews]
    jobs = _jobs_rollup(ids)
    pay = _pay_rollup(ids)
    on_leave = _on_leave_now(ids)

    out = []
    for c in crews:
        jo = jobs.get(c["id"], {})
        po = pay.get(c["id"], {})
        out.append({
            "id": c["id"], "name": c["name"], "phone": c["phone"], "email": c["email"],
            "company_name": c.get("company_name"),
            "rate_per_clean_pence": c["rate_per_clean"],
            "active": bool(c["active"]), "notes": c["notes"], "created_at": c["created_at"],
            "jobs_done": jo.get("done", 0), "upcoming": jo.get("upcoming", 0),
            "total_paid_pence": po.get("paid", 0), "last_paid_at": po.get("last"),
            "on_leave": c["id"] in on_leave,
        })
    active = [c for c in out if c["active"]]
    return 200, {
        "crews": out,
        "summary": {
            "total": len(out),
            "active": len(active),
            "on_leave": sum(1 for c in out if c["on_leave"]),
            "upcoming_jobs": sum(c["upcoming"] for c in out),
            "paid_total_pence": sum(c["total_paid_pence"] for c in out),
        },
    }


def _ph(ids):
    return ",".join("?" for _ in ids)


def _jobs_rollup(ids) -> dict:
    if not ids:
        return {}
    today = _today()
    rows = _rows(
        "SELECT subcontractor_id AS cid, "
        "  SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done, "
        "  SUM(CASE WHEN status = 'scheduled' AND scheduled_date >= ? THEN 1 ELSE 0 END) AS upcoming "
        f"FROM jobs WHERE subcontractor_id IN ({_ph(ids)}) GROUP BY subcontractor_id",
        [today] + list(ids))
    return {r["cid"]: r for r in rows}


def _pay_rollup(ids) -> dict:
    if not ids:
        return {}
    rows = _rows(
        "SELECT subcontractor_id AS cid, COALESCE(SUM(amount_pence),0) AS paid, "
        "       MAX(paid_at) AS last "
        f"FROM payroll_payments WHERE subcontractor_id IN ({_ph(ids)}) GROUP BY subcontractor_id",
        list(ids))
    return {r["cid"]: r for r in rows}


def _on_leave_now(ids) -> set:
    if not ids:
        return set()
    today = _today()
    rows = _rows(
        "SELECT DISTINCT subcontractor_id AS cid FROM crew_availability "
        f"WHERE subcontractor_id IN ({_ph(ids)}) AND date_from <= ? AND date_to >= ?",
        list(ids) + [today, today])
    return {r["cid"] for r in rows}


# ── Detail ──────────────────────────────────────────────────────────

def crew_detail(crew_id: int, tenant_id: int = DEFAULT_TENANT_ID) -> tuple[int, dict]:
    c = _crew(_int(crew_id), tenant_id)
    if not c:
        return 404, {"error": "that crew member is not on your books"}
    today = _today()
    jobs = _rows(
        "SELECT j.id, j.scheduled_date, j.status, j.price_pence, p.address "
        "FROM jobs j JOIN properties p ON p.id = j.property_id "
        "WHERE j.subcontractor_id = ? ORDER BY j.scheduled_date DESC LIMIT 40", (crew_id,))
    leave = _rows(
        "SELECT id, kind, date_from, date_to, notes FROM crew_availability "
        "WHERE subcontractor_id = ? AND date_to >= ? ORDER BY date_from", (crew_id, today))
    payroll = _rows(
        "SELECT id, date_from, date_to, jobs_done, amount_pence, paid_at "
        "FROM payroll_payments WHERE subcontractor_id = ? ORDER BY paid_at DESC LIMIT 24",
        (crew_id,))

    done = sum(1 for j in jobs if j["status"] == "done")
    upcoming = sum(1 for j in jobs if j["status"] == "scheduled" and j["scheduled_date"] >= today)
    total_paid = sum(p["amount_pence"] for p in payroll)
    return 200, {
        "crew": {
            "id": c["id"], "name": c["name"], "phone": c["phone"], "email": c["email"],
            "company_name": c.get("company_name"), "rate_per_clean_pence": c["rate_per_clean"],
            "active": bool(c["active"]), "notes": c["notes"], "created_at": c["created_at"],
        },
        "jobs": jobs, "leave": leave, "payroll": payroll,
        "stats": {
            "jobs_done": done, "upcoming": upcoming,
            "total_paid_pence": total_paid,
            "on_leave": crew_id in _on_leave_now([crew_id]),
        },
    }


# ── Create / update ─────────────────────────────────────────────────

def create_crew(body: dict, tenant_id: int = DEFAULT_TENANT_ID) -> tuple[int, dict]:
    name = (body.get("name") or "").strip()
    if not name:
        return 400, {"error": "a name is required"}
    rate = _int(body.get("rate_per_clean_pence"), 7000)
    if rate < 0:
        return 400, {"error": "the pay rate can't be negative"}
    conn = _conn()
    cur = conn.execute(
        "INSERT INTO subcontractors (tenant_id, name, phone, email, rate_per_clean, "
        " notes, company_name, active, status) VALUES (?,?,?,?,?,?,?,1,'active')",
        (tenant_id, name, (body.get("phone") or "").strip() or None,
         (body.get("email") or "").strip() or None, rate,
         (body.get("notes") or "").strip() or None,
         (body.get("company_name") or "").strip() or None))
    conn.commit()
    return crew_detail(cur.lastrowid, tenant_id)


def update_crew(crew_id: int, body: dict, tenant_id: int = DEFAULT_TENANT_ID) -> tuple[int, dict]:
    c = _crew(_int(crew_id), tenant_id)
    if not c:
        return 404, {"error": "that crew member is not on your books"}
    sets, args = [], []
    if "name" in body:
        name = (body.get("name") or "").strip()
        if not name:
            return 400, {"error": "a name is required"}
        sets.append("name = ?"); args.append(name)
    for field in ("phone", "email", "notes", "company_name"):
        if field in body and isinstance(body[field], str):
            sets.append(f"{field} = ?"); args.append(body[field].strip() or None)
    if "rate_per_clean_pence" in body:
        rate = _int(body["rate_per_clean_pence"])
        if rate < 0:
            return 400, {"error": "the pay rate can't be negative"}
        sets.append("rate_per_clean = ?"); args.append(rate)
    if "active" in body:
        on = 1 if body["active"] else 0
        sets.append("active = ?"); args.append(on)
        sets.append("status = ?"); args.append("active" if on else "inactive")
    if not sets:
        return crew_detail(crew_id, tenant_id)
    args.append(crew_id)
    conn = _conn()
    conn.execute(f"UPDATE subcontractors SET {', '.join(sets)} WHERE id = ?", args)
    conn.commit()
    return crew_detail(crew_id, tenant_id)


# ── Availability (leave) ────────────────────────────────────────────

def add_leave(crew_id: int, body: dict, tenant_id: int = DEFAULT_TENANT_ID) -> tuple[int, dict]:
    c = _crew(_int(crew_id), tenant_id)
    if not c:
        return 404, {"error": "that crew member is not on your books"}
    kind = (body.get("kind") or "unavailable").strip().lower()
    if kind not in LEAVE_KINDS:
        kind = "unavailable"
    d_from = (body.get("date_from") or "").strip()
    d_to = (body.get("date_to") or d_from).strip()
    if not _DATE.match(d_from) or not _DATE.match(d_to):
        return 400, {"error": "give a date range in YYYY-MM-DD form"}
    if d_to < d_from:
        return 400, {"error": "the end date is before the start date"}
    conn = _conn()
    cur = conn.execute(
        "INSERT INTO crew_availability (tenant_id, subcontractor_id, kind, date_from, "
        " date_to, notes) VALUES (?,?,?,?,?,?)",
        (tenant_id, crew_id, kind, d_from, d_to, (body.get("notes") or "").strip() or None))
    conn.commit()
    return 200, {"leave": _one("SELECT id, kind, date_from, date_to, notes "
                               "FROM crew_availability WHERE id = ?", (cur.lastrowid,))}


def delete_leave(leave_id: int, tenant_id: int = DEFAULT_TENANT_ID) -> tuple[int, dict]:
    conn = _conn()
    conn.execute("DELETE FROM crew_availability WHERE id = ? AND tenant_id = ?",
                 (_int(leave_id), tenant_id))
    conn.commit()
    return 200, {"ok": True}


# ── Payroll ─────────────────────────────────────────────────────────

def record_pay(crew_id: int, body: dict, tenant_id: int = DEFAULT_TENANT_ID) -> tuple[int, dict]:
    """Log a payroll payment to a crew for a period. The office enters what was
    actually paid — this is a record, not an automatic calculation."""
    c = _crew(_int(crew_id), tenant_id)
    if not c:
        return 404, {"error": "that crew member is not on your books"}
    amount = _int(body.get("amount_pence"))
    if amount <= 0:
        return 400, {"error": "enter the amount paid"}
    d_from = (body.get("date_from") or _today()).strip()
    d_to = (body.get("date_to") or d_from).strip()
    if not _DATE.match(d_from) or not _DATE.match(d_to):
        return 400, {"error": "give a date range in YYYY-MM-DD form"}
    jobs_done = _int(body.get("jobs_done"))
    conn = _conn()
    cur = conn.execute(
        "INSERT INTO payroll_payments (tenant_id, subcontractor_id, date_from, date_to, "
        " jobs_done, amount_pence) VALUES (?,?,?,?,?,?)",
        (tenant_id, crew_id, d_from, d_to, jobs_done, amount))
    conn.commit()
    return 200, {"payment": _one("SELECT id, date_from, date_to, jobs_done, amount_pence, "
                                 "paid_at FROM payroll_payments WHERE id = ?", (cur.lastrowid,))}
