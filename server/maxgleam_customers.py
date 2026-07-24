"""Max Gleam customers — the office-side CRM.

Everything already knows a customer by scattered rows: properties on a round,
jobs on those properties, invoices raised against them, comms sent to them.
This module pulls that together into one office view — a searchable book with
a per-customer record (properties, job history, invoices, notes) plus the
numbers that matter: lifetime value, what they owe, when they're next due.

No new tables: it reads customers / properties / jobs / invoices / comms_log
and writes only notes (comms_log kind='note') and edits to the customer's own
row. Scoped like the rest of Max Gleam — HQ sees the whole tenant, a partner
sees only customers behind properties their company manages.
"""
from __future__ import annotations

import json
import os
import time

from server import partner

DEFAULT_TENANT_ID = int(os.environ.get("MAXGLEAM_TENANT_ID", "2"))


def _conn():
    return partner._conn()


def _rows(sql: str, args=()) -> list[dict]:
    return [dict(r) for r in _conn().execute(sql, args).fetchall()]


def _one(sql: str, args=()) -> dict | None:
    r = _conn().execute(sql, args).fetchone()
    return dict(r) if r else None


def _today() -> str:
    return time.strftime("%Y-%m-%d")


def _tags(raw) -> list[str]:
    try:
        v = json.loads(raw or "[]")
        return [str(t) for t in v] if isinstance(v, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


# ── Scoping ─────────────────────────────────────────────────────────

def _in_scope(customer_id: int, tenant_id: int, company_id: int | None) -> dict | None:
    if company_id is None:
        return _one("SELECT * FROM customers WHERE id = ? AND tenant_id = ?",
                    (customer_id, tenant_id))
    return _one(
        "SELECT c.* FROM customers c JOIN properties p ON p.customer_id = c.id "
        " WHERE c.id = ? AND p.partner_company_id = ? LIMIT 1",
        (customer_id, company_id))


# ── List ────────────────────────────────────────────────────────────

def list_customers(tenant_id: int = DEFAULT_TENANT_ID, company_id: int | None = None,
                   search: str = "", include_archived: bool = False,
                   limit: int = 500) -> tuple[int, dict]:
    where, args = [], []
    if company_id is None:
        base = "SELECT c.* FROM customers c WHERE c.tenant_id = ?"
        args.append(tenant_id)
    else:
        # DISTINCT: a customer with several managed properties appears once.
        base = ("SELECT DISTINCT c.* FROM customers c "
                "JOIN properties p ON p.customer_id = c.id "
                "WHERE p.partner_company_id = ?")
        args.append(company_id)
    if not include_archived:
        where.append("c.archived = 0")
    q = (search or "").strip()
    if q:
        like = f"%{q}%"
        where.append("(c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR "
                     "EXISTS (SELECT 1 FROM properties px WHERE px.customer_id = c.id "
                     "        AND (px.address LIKE ? OR px.postcode LIKE ?)))")
        args += [like, like, like, like, like]
    sql = base + ("".join(f" AND {w}" for w in where)) + " ORDER BY c.name LIMIT ?"
    args.append(limit)
    customers = _rows(sql, args)

    ids = [c["id"] for c in customers]
    props = _props_rollup(ids)
    money = _money_rollup(ids)
    jobs = _jobs_rollup(ids)

    out = []
    for c in customers:
        pr = props.get(c["id"], {})
        mo = money.get(c["id"], {})
        jo = jobs.get(c["id"], {})
        out.append({
            "id": c["id"], "name": c["name"], "email": c["email"],
            "phone": c["phone"], "tags": _tags(c.get("tags")),
            "archived": bool(c["archived"]), "created_at": c["created_at"],
            "property_count": pr.get("n", 0), "active_properties": pr.get("active", 0),
            "outstanding_pence": mo.get("outstanding", 0),
            "ltv_pence": mo.get("paid", 0),
            "jobs_done": jo.get("done", 0),
            "next_job": jo.get("next"), "last_clean": jo.get("last"),
        })

    total_outstanding = sum(c["outstanding_pence"] for c in out)
    return 200, {
        "customers": out,
        "summary": {
            "total": len(out),
            "with_balance": sum(1 for c in out if c["outstanding_pence"] > 0),
            "outstanding_pence": total_outstanding,
            "ltv_pence": sum(c["ltv_pence"] for c in out),
        },
    }


def _placeholders(ids: list[int]) -> str:
    return ",".join("?" for _ in ids)


def _props_rollup(ids: list[int]) -> dict:
    if not ids:
        return {}
    rows = _rows(
        "SELECT customer_id, COUNT(*) AS n, "
        "       SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active "
        f"FROM properties WHERE customer_id IN ({_placeholders(ids)}) "
        "GROUP BY customer_id", ids)
    return {r["customer_id"]: r for r in rows}


def _money_rollup(ids: list[int]) -> dict:
    if not ids:
        return {}
    rows = _rows(
        "SELECT customer_id, "
        "  COALESCE(SUM(CASE WHEN status = 'unpaid' THEN amount_pence END), 0) AS outstanding, "
        "  COALESCE(SUM(CASE WHEN status = 'paid'   THEN amount_pence END), 0) AS paid "
        f"FROM invoices WHERE customer_id IN ({_placeholders(ids)}) "
        "GROUP BY customer_id", ids)
    return {r["customer_id"]: r for r in rows}


def _jobs_rollup(ids: list[int]) -> dict:
    if not ids:
        return {}
    today = _today()
    rows = _rows(
        "SELECT p.customer_id, "
        "  SUM(CASE WHEN j.status = 'done' THEN 1 ELSE 0 END) AS done, "
        "  MIN(CASE WHEN j.status = 'scheduled' AND j.scheduled_date >= ? "
        "           THEN j.scheduled_date END) AS next, "
        "  MAX(CASE WHEN j.status = 'done' THEN j.scheduled_date END) AS last "
        "FROM properties p JOIN jobs j ON j.property_id = p.id "
        f"WHERE p.customer_id IN ({_placeholders(ids)}) GROUP BY p.customer_id",
        [today] + ids)
    return {r["customer_id"]: r for r in rows}


# ── Detail ──────────────────────────────────────────────────────────

def customer_detail(customer_id: int, tenant_id: int = DEFAULT_TENANT_ID,
                    company_id: int | None = None) -> tuple[int, dict]:
    c = _in_scope(customer_id, tenant_id, company_id)
    if not c:
        return 404, {"error": "that customer is not on your account"}

    properties = _rows(
        "SELECT p.*, r.name AS round_name FROM properties p "
        "LEFT JOIN rounds r ON r.id = p.round_id "
        "WHERE p.customer_id = ? ORDER BY p.active DESC, p.address", (customer_id,))
    jobs = _rows(
        "SELECT j.id, j.scheduled_date, j.status, j.price_pence, j.rating, "
        "       j.completed_at, p.address FROM jobs j "
        "JOIN properties p ON p.id = j.property_id "
        "WHERE p.customer_id = ? ORDER BY j.scheduled_date DESC LIMIT 60", (customer_id,))
    invoices = _rows(
        "SELECT id, number, amount_pence, status, method, issued_at, paid_at "
        "FROM invoices WHERE customer_id = ? ORDER BY issued_at DESC LIMIT 60",
        (customer_id,))
    comms = _rows(
        "SELECT id, kind, content, created_at FROM comms_log "
        "WHERE customer_id = ? ORDER BY created_at DESC LIMIT 80", (customer_id,))

    ratings = [j["rating"] for j in jobs if j["rating"]]
    today = _today()
    recurring = sum(p["price_pence"] for p in properties if p["active"])
    stats = {
        "ltv_pence": sum(i["amount_pence"] for i in invoices if i["status"] == "paid"),
        "outstanding_pence": sum(i["amount_pence"] for i in invoices if i["status"] == "unpaid"),
        "jobs_done": sum(1 for j in jobs if j["status"] == "done"),
        "avg_rating": round(sum(ratings) / len(ratings), 1) if ratings else None,
        "active_properties": sum(1 for p in properties if p["active"]),
        "recurring_pence": recurring,
        "next_job": min((j["scheduled_date"] for j in jobs
                         if j["status"] == "scheduled" and j["scheduled_date"] >= today),
                        default=None),
        "last_clean": max((j["scheduled_date"] for j in jobs if j["status"] == "done"),
                          default=None),
    }
    return 200, {
        "customer": {
            "id": c["id"], "name": c["name"], "email": c["email"], "phone": c["phone"],
            "notes": c["notes"], "tags": _tags(c.get("tags")),
            "archived": bool(c["archived"]), "created_at": c["created_at"],
        },
        "properties": properties, "jobs": jobs, "invoices": invoices,
        "comms": comms, "stats": stats,
    }


# ── Edit + notes ────────────────────────────────────────────────────

def update_customer(customer_id: int, body: dict, tenant_id: int = DEFAULT_TENANT_ID,
                    company_id: int | None = None) -> tuple[int, dict]:
    c = _in_scope(customer_id, tenant_id, company_id)
    if not c:
        return 404, {"error": "that customer is not on your account"}

    sets, args = [], []
    if "name" in body:
        name = (body.get("name") or "").strip()
        if not name:
            return 400, {"error": "a name is required"}
        sets.append("name = ?"); args.append(name)
    for field in ("email", "phone", "notes"):
        if field in body and isinstance(body[field], str):
            sets.append(f"{field} = ?"); args.append(body[field].strip() or None)
    if "tags" in body:
        tags = body["tags"] if isinstance(body["tags"], list) else []
        sets.append("tags = ?"); args.append(json.dumps([str(t).strip() for t in tags if str(t).strip()]))
    if "archived" in body:
        sets.append("archived = ?"); args.append(1 if body["archived"] else 0)

    if not sets:
        return 200, {"customer": customer_detail(customer_id, tenant_id, company_id)[1]["customer"]}
    args.append(customer_id)
    conn = _conn()
    conn.execute(f"UPDATE customers SET {', '.join(sets)} WHERE id = ?", args)
    conn.commit()
    return 200, {"customer": customer_detail(customer_id, tenant_id, company_id)[1]["customer"]}


def add_note(customer_id: int, body: dict, tenant_id: int = DEFAULT_TENANT_ID,
             company_id: int | None = None) -> tuple[int, dict]:
    c = _in_scope(customer_id, tenant_id, company_id)
    if not c:
        return 404, {"error": "that customer is not on your account"}
    content = (body.get("content") or "").strip()
    if not content:
        return 400, {"error": "a note can't be empty"}
    conn = _conn()
    cur = conn.execute(
        "INSERT INTO comms_log (tenant_id, customer_id, kind, content) VALUES (?,?,?,?)",
        (c["tenant_id"], customer_id, "note", content[:2000]))
    conn.commit()
    return 200, {"note": _one("SELECT id, kind, content, created_at FROM comms_log WHERE id = ?",
                              (cur.lastrowid,))}
