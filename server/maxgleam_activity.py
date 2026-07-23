"""Max Gleam staff activity log — who did what, when.

Reads and writes the maxgleam database (/var/lib/maxgleam/app.db), sharing the
thread-local connection with server.partner / maxgleam_ops / maxgleam_reports.

Why a new table rather than audit_log
-------------------------------------
audit_log is HTTP-request shaped (method + path + redacted body) and is
written by the other maxgleam application. It answers "what endpoint was
called"; it cannot answer "did Craig finish the Hoole round". This table
records OPERATIONAL events — clock-ins, completed jobs, sign-offs, alerts —
with the actor attached, which is what an activity feed actually needs.
audit_log is still folded in by the backfill, so office logins and admin
actions are not lost from the timeline.

Idempotency
-----------
Every row carries a `source_key` (e.g. "job:26:completed"). It is UNIQUE, so
the backfill can run as often as it likes and derived history is written
exactly once. Live events pass source_key=None and are always inserted.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time

from server import partner
from server.maxgleam_ops import DEFAULT_TENANT_ID

# actor_type values. 'system' is anything with no human behind it — the
# scheduler, the alert sweep, an auto-approval timing out.
ACTOR_TYPES = ("crew", "user", "partner", "customer", "system")

_local = threading.local()


def _conn() -> sqlite3.Connection:
    conn = partner._conn()
    if not getattr(_local, "activity_schema_ready", False):
        _ensure_schema(conn)
        _local.activity_schema_ready = True
    return conn


def _ensure_schema(conn: sqlite3.Connection) -> None:
    """Additive only — never alters a column maxgleam already owns."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS staff_activity (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id   INTEGER NOT NULL,
          actor_type  TEXT NOT NULL DEFAULT 'system',
          actor_id    INTEGER,
          actor_name  TEXT,
          action      TEXT NOT NULL,
          entity_type TEXT,
          entity_id   INTEGER,
          detail      TEXT,
          meta_json   TEXT NOT NULL DEFAULT '{}',
          source_key  TEXT,
          created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )""")
    conn.execute("""CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_activity_source
                    ON staff_activity(source_key) WHERE source_key IS NOT NULL""")
    conn.execute("""CREATE INDEX IF NOT EXISTS idx_staff_activity_tenant
                    ON staff_activity(tenant_id, created_at)""")
    conn.execute("""CREATE INDEX IF NOT EXISTS idx_staff_activity_actor
                    ON staff_activity(actor_type, actor_id, created_at)""")
    conn.commit()


def _rows(sql: str, args=()) -> list[dict]:
    cur = _conn().execute(sql, args)
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def _one(sql: str, args=()):
    got = _rows(sql, args)
    return got[0] if got else None


# ── writing ─────────────────────────────────────────────────────────────

def log(action: str, *, tenant_id: int = DEFAULT_TENANT_ID,
        actor_type: str = "system", actor_id: int | None = None,
        actor_name: str | None = None, entity_type: str | None = None,
        entity_id: int | None = None, detail: str | None = None,
        meta: dict | None = None, source_key: str | None = None,
        at: int | None = None) -> int | None:
    """Record one event. Returns the row id, or None if source_key collided.

    Never raises: an activity row failing to write must not take down the
    clock-in that produced it. A lost log line is a smaller problem than a
    crew member who cannot start their day.
    """
    if actor_type not in ACTOR_TYPES:
        actor_type = "system"
    try:
        conn = _conn()
        cur = conn.execute(
            """INSERT OR IGNORE INTO staff_activity
                 (tenant_id, actor_type, actor_id, actor_name, action,
                  entity_type, entity_id, detail, meta_json, source_key, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (tenant_id, actor_type, actor_id, actor_name, action,
             entity_type, entity_id, detail, json.dumps(meta or {}),
             source_key, at or int(time.time())))
        conn.commit()
        # rowcount, not lastrowid: an OR IGNORE that collided leaves lastrowid
        # pointing at whatever this cursor inserted last, which would read as
        # a fresh write and inflate every backfill count.
        return cur.lastrowid if cur.rowcount else None
    except sqlite3.Error:
        return None


# ── reading ─────────────────────────────────────────────────────────────

def feed(tenant_id: int = DEFAULT_TENANT_ID, *, company_id: int | None = None,
         day: str | None = None, since: int | None = None,
         actor_type: str | None = None, actor_id: int | None = None,
         action: str | None = None, limit: int = 200) -> tuple[int, dict]:
    """The activity timeline, newest first, plus a per-actor roll-up.

    A partner caller is scoped to jobs on their own estate. Events with no
    job attached are dropped for a partner rather than shown unscoped — an
    office login is not a partner's business.
    """
    where = ["a.tenant_id = ?"]
    args: list = [tenant_id]

    if day:
        try:
            t = time.strptime(day, "%Y-%m-%d")
        except ValueError:
            return 400, {"error": "day must be YYYY-MM-DD"}
        start = int(time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, -1)))
        where.append("a.created_at >= ? AND a.created_at < ?")
        args += [start, start + 86400]
    elif since:
        where.append("a.created_at >= ?")
        args.append(since)

    if actor_type:
        where.append("a.actor_type = ?"); args.append(actor_type)
    if actor_id:
        where.append("a.actor_id = ?"); args.append(actor_id)
    if action:
        where.append("a.action = ?"); args.append(action)
    if company_id is not None:
        where.append("""a.entity_type = 'job' AND a.entity_id IN (
                          SELECT j.id FROM jobs j
                          JOIN properties p ON p.id = j.property_id
                          WHERE j.partner_company_id = ? OR p.partner_company_id = ?)""")
        args += [company_id, company_id]

    limit = max(1, min(1000, limit))
    rows = _rows(
        "SELECT a.* FROM staff_activity a WHERE " + " AND ".join(where)
        + " ORDER BY a.created_at DESC, a.id DESC LIMIT ?", tuple(args + [limit]))

    for r in rows:
        try:
            r["meta"] = json.loads(r.pop("meta_json") or "{}")
        except (TypeError, ValueError):
            r["meta"] = {}
        r.pop("source_key", None)
        r["day"] = time.strftime("%Y-%m-%d", time.localtime(r["created_at"]))

    by_actor: dict[str, dict] = {}
    for r in rows:
        key = f'{r["actor_type"]}:{r["actor_id"] or 0}'
        entry = by_actor.setdefault(key, {
            "actor_type": r["actor_type"], "actor_id": r["actor_id"],
            "name": r["actor_name"] or r["actor_type"].title(),
            "events": 0, "last_at": r["created_at"],
        })
        entry["events"] += 1
        entry["last_at"] = max(entry["last_at"], r["created_at"])

    counts: dict[str, int] = {}
    for r in rows:
        counts[r["action"]] = counts.get(r["action"], 0) + 1

    return 200, {
        "activity": rows,
        "count": len(rows),
        "limit": limit,
        "by_actor": sorted(by_actor.values(), key=lambda a: a["events"], reverse=True),
        "by_action": sorted(({"action": k, "count": v} for k, v in counts.items()),
                            key=lambda a: a["count"], reverse=True),
        "actions": sorted(counts),
    }


# ── backfill ────────────────────────────────────────────────────────────

def backfill(tenant_id: int = DEFAULT_TENANT_ID, limit: int = 2000) -> dict:
    """Derive historical activity from what the estate already recorded.

    Runs on first use so the feed is not empty on day one, and is safe to
    repeat: every derived row has a stable source_key behind a UNIQUE index.
    """
    written = {"job_completed": 0, "job_signed_off": 0, "clock_in": 0,
               "clock_out": 0, "audit": 0, "comms": 0}

    for j in _rows(
        """SELECT j.id, j.completed_at, j.scheduled_date, j.signoff_status,
                  j.signoff_at, j.price_pence, p.address,
                  j.subcontractor_id, s.name AS crew_name
             FROM jobs j
             JOIN properties p ON p.id = j.property_id
             LEFT JOIN subcontractors s ON s.id = j.subcontractor_id
            WHERE j.tenant_id = ? AND j.status = 'done'
         ORDER BY j.completed_at DESC LIMIT ?""", (tenant_id, limit)):
        stamp = j["completed_at"] or None
        if stamp:
            if log("job_completed", tenant_id=tenant_id,
                   actor_type="crew" if j["subcontractor_id"] else "system",
                   actor_id=j["subcontractor_id"], actor_name=j["crew_name"],
                   entity_type="job", entity_id=j["id"],
                   detail=j["address"], at=stamp,
                   meta={"price_pence": j["price_pence"] or 0},
                   source_key=f'job:{j["id"]}:completed'):
                written["job_completed"] += 1
        if j["signoff_status"] in ("signed", "auto-approved") and j["signoff_at"]:
            auto = j["signoff_status"] == "auto-approved"
            if log("job_signed_off", tenant_id=tenant_id,
                   actor_type="system" if auto else "customer",
                   actor_name="Auto-approved" if auto else "Customer",
                   entity_type="job", entity_id=j["id"], detail=j["address"],
                   at=j["signoff_at"], meta={"status": j["signoff_status"]},
                   source_key=f'job:{j["id"]}:signoff'):
                written["job_signed_off"] += 1

    for t in _rows(
        """SELECT t.id, t.job_id, t.subcontractor_id, t.clock_in, t.clock_out,
                  t.total_minutes, s.name AS crew_name, p.address
             FROM time_logs t
             LEFT JOIN subcontractors s ON s.id = t.subcontractor_id
             LEFT JOIN jobs j ON j.id = t.job_id
             LEFT JOIN properties p ON p.id = j.property_id
            ORDER BY t.clock_in DESC LIMIT ?""", (limit,)):
        if log("clock_in", tenant_id=tenant_id, actor_type="crew",
               actor_id=t["subcontractor_id"], actor_name=t["crew_name"],
               entity_type="job", entity_id=t["job_id"],
               detail=t["address"] or "General duties", at=t["clock_in"],
               source_key=f'timelog:{t["id"]}:in'):
            written["clock_in"] += 1
        if t["clock_out"]:
            if log("clock_out", tenant_id=tenant_id, actor_type="crew",
                   actor_id=t["subcontractor_id"], actor_name=t["crew_name"],
                   entity_type="job", entity_id=t["job_id"],
                   detail=t["address"] or "General duties", at=t["clock_out"],
                   meta={"total_minutes": t["total_minutes"]},
                   source_key=f'timelog:{t["id"]}:out'):
                written["clock_out"] += 1

    # Office actions, from the other application's request audit.
    for a in _rows("""SELECT id, user_id, user_email, method, path, created_at
                        FROM audit_log WHERE tenant_id = ?
                    ORDER BY id DESC LIMIT ?""", (tenant_id, limit)):
        if log("office_action", tenant_id=tenant_id, actor_type="user",
               actor_id=a["user_id"], actor_name=a["user_email"],
               entity_type="request", entity_id=a["id"],
               detail=f'{a["method"]} {a["path"]}', at=a["created_at"],
               source_key=f'audit:{a["id"]}'):
            written["audit"] += 1

    for c in _rows("""SELECT id, customer_id, kind, content, created_at
                        FROM comms_log WHERE tenant_id = ?
                    ORDER BY id DESC LIMIT ?""", (tenant_id, limit)):
        if log("customer_comms", tenant_id=tenant_id, actor_type="system",
               actor_name="Comms", entity_type="customer", entity_id=c["customer_id"],
               detail=f'{c["kind"]}: {(c["content"] or "")[:120]}', at=c["created_at"],
               source_key=f'comms:{c["id"]}'):
            written["comms"] += 1

    written["total"] = sum(v for k, v in written.items() if k != "total")
    return written


def ensure_backfilled(tenant_id: int = DEFAULT_TENANT_ID) -> None:
    """Backfill once, the first time anything asks for the feed."""
    if getattr(_local, "backfilled", False):
        return
    _local.backfilled = True
    row = _one("SELECT COUNT(*) AS n FROM staff_activity WHERE tenant_id = ?",
               (tenant_id,))
    if not (row or {}).get("n"):
        backfill(tenant_id)
