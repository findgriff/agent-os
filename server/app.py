"""AGENT OS HTTP server — stdlib only, ThreadingHTTPServer.

One HQ serving every business (tenant) from a single SQLite database.
Routes are a flat regex table; handlers stay thin and delegate domain
logic to agents.py / vault.py / bridges.py / metrics.py.

Run:  python3 -m server.app   (port 8100, override with AGENTOS_PORT)
"""
from __future__ import annotations
import json
import logging
import os
import re
import sqlite3
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

from server import db as db_module
from server import auth, agents, vault, bridges, metrics, inference, studio, omi, features, oracle_search, apollo

log = logging.getLogger("agentos")

LISTEN_HOST = os.environ.get("AGENTOS_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("AGENTOS_PORT", "8100"))
DB_PATH = os.environ.get("AGENTOS_DB", "/var/lib/agent-os/data.db")
SITE_DIR = Path(os.environ.get("AGENTOS_SITE", str(Path(__file__).parent.parent / "site")))
# Apollo build artifacts live outside SITE_DIR (which `vite build` wipes) and
# are served read-only under /builds/.
BUILDS_DIR = apollo.BUILDS_DIR
MAXGLEAM_DB = os.environ.get("MAXGLEAM_DB", "/var/lib/maxgleam/app.db")

# Businesses served on first boot (idempotent — only inserted if missing).
SEED_TENANTS = [
    {"name": "Max Gleam", "slug": "max-gleam", "brand_colour": "#19C3E6"},
    {"name": "Magic Hair Styler", "slug": "magic-hair-styler", "brand_colour": "#A78BFA"},
]


def get_db() -> sqlite3.Connection:
    return db_module.get_thread_conn(DB_PATH)


# ---------------------------------------------------------------- request --

class Request:
    def __init__(self, handler: BaseHTTPRequestHandler, method: str):
        self.method = method
        split = urlsplit(handler.path)
        self.path = split.path
        self.query = {k: v[0] for k, v in parse_qs(split.query).items()}
        self.headers = handler.headers
        self.ip = handler.client_address[0]
        length = int(handler.headers.get("Content-Length") or 0)
        raw = handler.rfile.read(length) if length else b""
        try:
            self.body = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            self.body = {}
        # Guard non-object JSON bodies (arrays/scalars) so handlers can always
        # call req.body.get(...) without an AttributeError → 500.
        if not isinstance(self.body, dict):
            self.body = {}
        bearer = (handler.headers.get("Authorization") or "")
        self.token = bearer.removeprefix("Bearer ").strip()

    def user(self):
        return auth.user_for_session(get_db(), self.token)

    def tenant_filter(self):
        """Optional ?tenant_id= — None means 'all businesses' (HQ view)."""
        tid = self.query.get("tenant_id")
        return int(tid) if tid and tid.isdigit() else None


def _require(req: Request):
    user = req.user()
    if not user:
        raise PermissionError("auth required")
    return user


# ---------------------------------------------------------------- helpers --

def _agent_dto(a: dict) -> dict:
    cert = json.loads(a.get("certificate_json") or "{}")
    return {**a, "certificate": cert, "team": cert.get("team"),
            "avatar_colour": cert.get("avatar_colour"),
            "avatar_initials": cert.get("avatar_initials"),
            "default_model": cert.get("default_model", "deepseek"),
            "generates": bool(cert.get("generates"))}


# ---------------------------------------------------------------- auth -----

def h_login(req: Request):
    email = (req.body.get("email") or "").strip().lower()
    password = req.body.get("password") or ""
    conn = get_db()
    user = db_module.one(conn, "SELECT * FROM users WHERE email = ?", (email,))
    if not user or not auth.verify_password(password, user["password_hash"]):
        return 401, {"error": "invalid email or password"}
    token = auth.create_session(conn, user["id"])
    return 200, {"token": token, "user": _user_dto(user)}


def h_set_password(req: Request):
    user = _require(req)
    pw = req.body.get("password") or ""
    if len(pw) < auth.MIN_PASSWORD_LEN:
        return 400, {"error": f"password must be at least {auth.MIN_PASSWORD_LEN} characters"}
    conn = get_db()
    conn.execute("UPDATE users SET password_hash = ? WHERE id = ?",
                 (auth.hash_password(pw), user["id"]))
    conn.commit()
    return 200, {"ok": True}


def _user_dto(u: dict) -> dict:
    return {"id": u["id"], "email": u["email"], "name": u["name"],
            "role": u["role"], "tenant_id": u["tenant_id"]}


def h_me(req: Request):
    user = _require(req)
    return 200, {"user": _user_dto(user)}


# ---------------------------------------------------------------- tenants --

def h_tenants(req: Request):
    _require(req)
    conn = get_db()
    out = []
    for t in db_module.rows(conn, "SELECT * FROM tenants ORDER BY id"):
        counts = db_module.one(conn,
            "SELECT COUNT(*) AS total, "
            "SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) AS enabled, "
            "SUM(CASE WHEN last_status='error' THEN 1 ELSE 0 END) AS errors, "
            "SUM(CASE WHEN last_run_at >= strftime('%s','now')-3600 THEN 1 ELSE 0 END) AS active "
            "FROM agents WHERE tenant_id = ?", (t["id"],))
        last = db_module.one(conn,
            "SELECT MAX(last_run_at) AS last FROM agents WHERE tenant_id = ?", (t["id"],))
        out.append({**t, "settings": json.loads(t.get("settings_json") or "{}"),
                    "agent_count": counts["total"] or 0,
                    "active_count": counts["active"] or 0,
                    "error_count": counts["errors"] or 0,
                    "last_activity": last["last"]})
    return 200, {"tenants": out}


def h_tenant_update(req: Request, tid: int):
    _require(req)
    conn = get_db()
    data = {}
    for k in ("name", "brand_colour"):
        if k in req.body:
            data[k] = req.body[k]
    if "settings" in req.body:
        data["settings_json"] = json.dumps(req.body["settings"])
    if data:
        conn.execute("UPDATE tenants SET " + ", ".join(f"{k}=?" for k in data) +
                     " WHERE id = ?", (*data.values(), tid))
        conn.commit()
    t = db_module.one(conn, "SELECT * FROM tenants WHERE id = ?", (tid,))
    return 200, {"tenant": t}


# ---------------------------------------------------------------- agents ---

def h_agents(req: Request):
    user = _require(req)
    conn = get_db()
    if req.method == "POST":
        tid = req.body.get("tenant_id") or user["tenant_id"]
        cert = req.body.get("certificate") or {}
        cert.setdefault("default_model", req.body.get("default_model", "deepseek"))
        aid = db_module.insert(conn, "agents", {
            "tenant_id": tid, "slug": req.body.get("slug") or _slug(req.body.get("name", "agent")),
            "name": req.body.get("name") or "New Agent",
            "real_name": req.body.get("real_name"),
            "role": req.body.get("role"), "enabled": 1,
            "certificate_json": json.dumps(cert),
            "soul_text": req.body.get("soul_text") or "",
            "brand": req.body.get("brand"), "last_status": "idle"})
        a = db_module.one(conn, "SELECT * FROM agents WHERE id = ?", (aid,))
        return 201, {"agent": _agent_dto(a)}

    tid = req.tenant_filter()
    if tid:
        rows = db_module.rows(conn, "SELECT * FROM agents WHERE tenant_id = ? ORDER BY id", (tid,))
    else:
        rows = db_module.rows(conn, "SELECT * FROM agents ORDER BY tenant_id, id")
    tenants = {t["id"]: t["name"] for t in db_module.rows(conn, "SELECT id, name FROM tenants")}
    out = []
    for a in rows:
        dto = _agent_dto(a)
        dto["tenant_name"] = tenants.get(a["tenant_id"])
        out.append(dto)
    return 200, {"agents": out}


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-") or "agent"


def _get_agent(conn, aid):
    return db_module.one(conn, "SELECT * FROM agents WHERE id = ?", (aid,))


def h_agent_detail(req: Request, aid: int):
    _require(req)
    a = _get_agent(get_db(), aid)
    if not a:
        return 404, {"error": "agent not found"}
    return 200, {"agent": _agent_dto(a)}


def h_agent_update(req: Request, aid: int):
    _require(req)
    conn = get_db()
    a = _get_agent(conn, aid)
    if not a:
        return 404, {"error": "agent not found"}
    data = {}
    for k in ("name", "real_name", "role", "soul_text", "brand", "enabled"):
        if k in req.body:
            data[k] = req.body[k]
    if req.body.get("last_status") in ("idle", "running", "flagged", "error"):
        data["last_status"] = req.body["last_status"]
    cert = json.loads(a.get("certificate_json") or "{}")
    if "certificate" in req.body and isinstance(req.body["certificate"], dict):
        cert.update(req.body["certificate"])
    if "default_model" in req.body:
        cert["default_model"] = inference.normalise_model(req.body["default_model"])
    data["certificate_json"] = json.dumps(cert)
    db_module.update(conn, "agents", aid, a["tenant_id"], data)
    return 200, {"agent": _agent_dto(_get_agent(conn, aid))}


def h_agent_toggle(req: Request, aid: int):
    _require(req)
    conn = get_db()
    a = _get_agent(conn, aid)
    if not a:
        return 404, {"error": "agent not found"}
    new = 0 if a["enabled"] else 1
    db_module.update(conn, "agents", aid, a["tenant_id"], {"enabled": new})
    return 200, {"enabled": bool(new)}


def h_agent_run(req: Request, aid: int):
    _require(req)
    conn = get_db()
    a = _get_agent(conn, aid)
    if not a:
        return 404, {"error": "agent not found"}
    if not a["enabled"]:
        return 400, {"error": "agent is disabled"}
    result = agents.run_agent(conn, db_module, a, a["tenant_id"])
    db_module.insert(conn, "agent_logs", {
        "tenant_id": a["tenant_id"], "agent_id": aid, "action": result["action"],
        "summary": result["summary"], "details_json": json.dumps(result["details"]),
        "token_count": result.get("token_count", 0), "cost_usd": result.get("cost_usd", 0)})
    db_module.update(conn, "agents", aid, a["tenant_id"], {
        "last_run_at": int(time.time()), "last_status": result["last_status"],
        "last_summary": result["summary"]})
    return 200, {"result": result}


def h_agent_log(req: Request, aid: int):
    _require(req)
    conn = get_db()
    limit = min(int(req.query.get("limit", 50)), 200)
    offset = int(req.query.get("offset", 0))
    rows = db_module.rows(conn,
        "SELECT * FROM agent_logs WHERE agent_id = ? ORDER BY created_at DESC, id DESC "
        "LIMIT ? OFFSET ?", (aid, limit, offset))
    for r in rows:
        r["details"] = json.loads(r.get("details_json") or "{}")
    return 200, {"logs": rows}


def h_agent_memory(req: Request, aid: int):
    _require(req)
    conn = get_db()
    a = _get_agent(conn, aid)
    if not a:
        return 404, {"error": "agent not found"}
    if req.method == "POST":
        mid = agents.agent_memory_write(conn, db_module, a["tenant_id"],
            agent_id=aid, memory_type=req.body.get("memory_type", "personal"),
            topic=req.body.get("topic", "general"), fact=req.body.get("fact", ""),
            confidence=float(req.body.get("confidence", 1.0)),
            source=req.body.get("source", "operator"))
        return 201, {"id": mid}
    mems = agents.agent_memory_read(conn, db_module, a["tenant_id"], agent_id=aid,
                                    topic=req.query.get("topic"),
                                    limit=int(req.query.get("limit", 50)))
    return 200, {"memories": mems}


def h_agent_inbox(req: Request, aid: int):
    _require(req)
    conn = get_db()
    a = _get_agent(conn, aid)
    if not a:
        return 404, {"error": "agent not found"}
    if req.method == "POST":
        mid = db_module.insert(conn, "agent_inbox", {
            "tenant_id": a["tenant_id"], "to_agent_id": aid,
            "from_agent_id": req.body.get("from_agent_id"),
            "subject": (req.body.get("subject") or "")[:200],
            "body": req.body.get("body") or "", "status": "pending"})
        conn.execute("UPDATE agent_inbox SET thread_id = ? WHERE id = ?", (mid, mid))
        conn.commit()
        return 201, {"id": mid}
    rows = db_module.rows(conn,
        "SELECT m.*, fa.name AS from_name, fa.real_name AS from_real "
        "FROM agent_inbox m LEFT JOIN agents fa ON fa.id = m.from_agent_id "
        "WHERE m.to_agent_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT 50", (aid,))
    return 200, {"messages": rows}


# ---------------------------------------------------- mission control ------

def h_mission_control(req: Request):
    _require(req)
    conn = get_db()
    tid = req.tenant_filter()
    now = int(time.time())
    hour_ago, day_start = now - 3600, now - (now % 86400)
    scope = "WHERE tenant_id = ?" if tid else ""
    args = (tid,) if tid else ()

    arows = db_module.rows(conn,
        "SELECT id, name, real_name, slug, certificate_json, last_status, last_run_at, "
        "last_summary, enabled, tenant_id FROM agents " + scope, args)
    team_of, avatar_of = {}, {}
    for a in arows:
        cert = json.loads(a["certificate_json"] or "{}")
        team_of[a["id"]] = cert.get("team")
        avatar_of[a["id"]] = {"colour": cert.get("avatar_colour"),
                              "initials": cert.get("avatar_initials")}
    active_ids = {a["id"] for a in arows if (a["last_run_at"] or 0) >= hour_ago}

    log_scope = "WHERE tenant_id = ? AND" if tid else "WHERE"
    drafts_by_agent = {r["agent_id"]: r["c"] for r in db_module.rows(conn,
        f"SELECT agent_id, COUNT(*) AS c FROM agent_logs {log_scope} "
        "action = 'generated_draft' AND created_at >= ? GROUP BY agent_id",
        (*args, day_start))}
    tokens_today = db_module.one(conn,
        f"SELECT COALESCE(SUM(token_count),0) AS t, COALESCE(SUM(cost_usd),0) AS c "
        f"FROM agent_logs {log_scope} created_at >= ?", (*args, day_start))
    messages_today = db_module.one(conn,
        f"SELECT COUNT(*) AS c FROM agent_inbox {log_scope} created_at >= ?",
        (*args, day_start))["c"]

    teams = {k: {"total": 0, "active": 0, "drafts": 0}
             for k in ("marketing", "sales", "technical", "platform")}
    for a in arows:
        tm = team_of.get(a["id"])
        if tm in teams:
            teams[tm]["total"] += 1
            teams[tm]["active"] += 1 if a["id"] in active_ids else 0
            teams[tm]["drafts"] += drafts_by_agent.get(a["id"], 0)

    health = [{"id": a["id"], "name": a["real_name"] or a["name"],
               "status": a["last_status"], "team": team_of.get(a["id"]),
               "colour": avatar_of[a["id"]]["colour"],
               "initials": avatar_of[a["id"]]["initials"],
               "active": a["id"] in active_ids, "enabled": bool(a["enabled"])}
              for a in arows]

    # ── Telemetry, per-agent matrix, chart series, alerts ──────────────
    week_ago, day_ago = now - 7 * 86400, now - 86400
    lrows = db_module.rows(conn,
        f"SELECT agent_id, action, created_at, token_count, "
        f"json_extract(details_json, '$.duration_ms') AS duration_ms "
        f"FROM agent_logs {log_scope} created_at >= ?", (*args, week_ago))

    per_agent = {}   # agent_id -> {runs, errors, tasks_today, durs[]}
    tokens_24h, tasks_24h, errors_24h = [0] * 24, [0] * 24, [0] * 24
    cost_7d = [0.0] * 7
    calls_today = errors_hour = calls_hour = fleet_errors = 0
    fleet_durs = []
    crows = db_module.rows(conn,
        f"SELECT CAST((created_at - ?) / 86400 AS INTEGER) AS bucket, "
        f"COALESCE(SUM(cost_usd), 0) AS c FROM agent_logs "
        f"{log_scope} created_at >= ? GROUP BY bucket",
        (week_ago, *args, week_ago))
    for r in crows:
        if 0 <= r["bucket"] <= 6:
            cost_7d[r["bucket"]] += r["c"]
    for l in lrows:
        s = per_agent.setdefault(l["agent_id"],
                                 {"runs": 0, "errors": 0, "tasks_today": 0, "durs": []})
        is_err = l["action"] == "error"
        s["runs"] += 1
        s["errors"] += 1 if is_err else 0
        fleet_errors += 1 if is_err else 0
        if l["duration_ms"]:
            s["durs"].append(l["duration_ms"])
            fleet_durs.append(l["duration_ms"])
        if l["created_at"] >= day_start:
            s["tasks_today"] += 1
            calls_today += 1
        if l["created_at"] >= hour_ago:
            calls_hour += 1
            errors_hour += 1 if is_err else 0
        if l["created_at"] >= day_ago:
            b = min(23, max(0, (l["created_at"] - day_ago) // 3600))
            tokens_24h[b] += l["token_count"]
            tasks_24h[b] += 1
            errors_24h[b] += 1 if is_err else 0

    mem_counts = {r["agent_id"]: r["c"] for r in db_module.rows(conn,
        f"SELECT agent_id, COUNT(*) AS c FROM agent_memory "
        f"WHERE agent_id IS NOT NULL {'AND tenant_id = ?' if tid else ''} "
        "GROUP BY agent_id", args)}

    enabled_rows = [a for a in arows if a["enabled"]]
    healthy = sum(1 for a in enabled_rows if a["last_status"] != "error")
    fleet_runs = sum(s["runs"] for s in per_agent.values())
    telemetry = {
        "uptime_pct": round(100 * healthy / len(enabled_rows), 1) if enabled_rows else 100.0,
        "success_rate": round(100 * (fleet_runs - fleet_errors) / fleet_runs, 1)
                        if fleet_runs else None,
        "avg_latency_ms": int(sum(fleet_durs) / len(fleet_durs)) if fleet_durs else None,
        "api_calls_today": calls_today,
        "error_rate_hour": round(100 * errors_hour / calls_hour, 1) if calls_hour else 0.0,
        "errors_hour": errors_hour, "calls_hour": calls_hour,
    }

    matrix = []
    for a in arows:
        s = per_agent.get(a["id"], {"runs": 0, "errors": 0, "tasks_today": 0, "durs": []})
        matrix.append({
            "id": a["id"], "name": a["real_name"] or a["name"],
            "team": team_of.get(a["id"]),
            "colour": avatar_of[a["id"]]["colour"],
            "initials": avatar_of[a["id"]]["initials"],
            "status": a["last_status"], "enabled": bool(a["enabled"]),
            "active": a["id"] in active_ids, "last_run_at": a["last_run_at"],
            "success_rate": round(100 * (s["runs"] - s["errors"]) / s["runs"], 1)
                            if s["runs"] else None,
            "avg_latency_ms": int(sum(s["durs"]) / len(s["durs"])) if s["durs"] else None,
            "tasks_today": s["tasks_today"],
            "memory_count": mem_counts.get(a["id"], 0),
        })

    alerts = []
    for a in arows:
        name = a["real_name"] or a["name"]
        if a["last_status"] == "error":
            alerts.append({"id": f"err-{a['id']}", "severity": "critical",
                           "message": f"{name} hit an error on its last run",
                           "at": a["last_run_at"], "agent_id": a["id"]})
        elif a["last_status"] == "flagged":
            alerts.append({"id": f"flag-{a['id']}", "severity": "warn",
                           "message": f"{name} has a draft awaiting approval",
                           "at": a["last_run_at"], "agent_id": a["id"]})
        if a["enabled"] and a["last_run_at"] and now - a["last_run_at"] > 3 * 86400:
            alerts.append({"id": f"stale-{a['id']}", "severity": "info",
                           "message": f"{name} hasn't run in "
                                      f"{(now - a['last_run_at']) // 86400}d",
                           "at": a["last_run_at"], "agent_id": a["id"]})
    if calls_hour and errors_hour / calls_hour > 0.25:
        alerts.append({"id": "sys-error-rate", "severity": "critical",
                       "message": f"Fleet error rate {telemetry['error_rate_hour']}% "
                                  "in the last hour", "at": now, "agent_id": None})
    sev_rank = {"critical": 0, "warn": 1, "info": 2}
    alerts.sort(key=lambda al: (sev_rank[al["severity"]], -(al["at"] or 0)))

    ract = db_module.rows(conn,
        f"SELECT l.*, a.name AS agent_name, a.real_name AS agent_real, a.slug AS agent_slug "
        f"FROM agent_logs l JOIN agents a ON a.id = l.agent_id "
        f"{'WHERE l.tenant_id = ?' if tid else ''} "
        "ORDER BY l.created_at DESC, l.id DESC LIMIT 40", args)
    for e in ract:
        e["team"] = team_of.get(e["agent_id"])
        e["avatar_colour"] = avatar_of.get(e["agent_id"], {}).get("colour")
        e["avatar_initials"] = avatar_of.get(e["agent_id"], {}).get("initials")
        e.pop("details_json", None)
    rmsg = db_module.rows(conn,
        f"SELECT m.*, fa.name AS from_name, fa.real_name AS from_real, "
        f"ta.name AS to_name, ta.real_name AS to_real FROM agent_inbox m "
        f"LEFT JOIN agents fa ON fa.id = m.from_agent_id "
        f"LEFT JOIN agents ta ON ta.id = m.to_agent_id "
        f"{'WHERE m.tenant_id = ?' if tid else ''} "
        "ORDER BY m.created_at DESC, m.id DESC LIMIT 20", args)

    return 200, {
        "total": len(arows), "active_now": len(active_ids),
        "drafts_today": sum(drafts_by_agent.values()),
        "messages_today": messages_today,
        "tokens_today": tokens_today["t"], "cost_today": round(tokens_today["c"], 4),
        "teams": teams, "health": health,
        "telemetry": telemetry, "matrix": matrix,
        "series": {"tokens_24h": tokens_24h, "tasks_24h": tasks_24h,
                   "errors_24h": errors_24h,
                   "cost_7d": [round(c, 4) for c in cost_7d]},
        "alerts": alerts,
        "recent_activity": ract, "recent_messages": rmsg, "generated_at": now}


# ---------------------------------------------------------------- metrics --

def h_metrics(req: Request):
    user = _require(req)
    conn = get_db()
    tid = req.tenant_filter() or user["tenant_id"]
    return 200, metrics.summary(conn, tid)


# ---------------------------------------------------------------- vault ----

def h_vault_memories(req: Request):
    _require(req)
    mems = vault.memory_read(topic=req.query.get("topic"),
                             tenant_id=req.tenant_filter(),
                             limit=int(req.query.get("limit", 100)))
    return 200, {"memories": mems}


def h_vault_memories_topic(req: Request, topic: str):
    _require(req)
    mems = vault.memory_read(topic=topic, tenant_id=req.tenant_filter(), limit=100)
    return 200, {"topic": topic, "memories": mems}


def h_vault_sync(req: Request):
    _require(req)
    n = vault.memory_sync()
    return 200, {"synced": n}


def h_vault_galaxy(req: Request):
    _require(req)
    return 200, vault.memory_galaxy(tenant_id=req.tenant_filter())


def h_vault_memory_write(req: Request):
    """Write a memory to the vault. Shows up as a star in the Galaxy."""
    user = _require(req)
    tid = req.body.get("tenant_id") or user["tenant_id"]
    topic = req.body.get("topic") or "general"
    fact = (req.body.get("fact") or "").strip()
    if not fact:
        return 400, {"error": "fact is required"}
    meta = req.body.get("metadata") or {}
    # Enrich the fact with a reference so the galaxy star links back
    enriched = fact
    if meta.get("url"):
        enriched += f"\n\n🔗 {meta['url']}"
    if meta.get("model"):
        enriched += f"\n   Model: {meta['model']}"
    path = vault.memory_write(
        tenant_id=tid, agent_id=None, memory_type="personal",
        topic=topic, fact=enriched,
        source="studio",
    )
    return 201, {"path": path, "topic": topic, "fact": fact}


# ---------------------------------------------------------------- bridges --

def _connection_dto(c: dict) -> dict:
    cfg = json.loads(c.get("config_json") or "{}")
    safe = {k: ("••••" if "key" in k.lower() or "secret" in k.lower() else v)
            for k, v in cfg.items()}
    meta = bridges.PLATFORM_META.get(c["platform"], {})
    return {"id": c["id"], "tenant_id": c["tenant_id"], "platform": c["platform"],
            "label": c.get("label") or meta.get("label"), "config": safe,
            "enabled": bool(c["enabled"]), "last_sync_at": c.get("last_sync_at"),
            "last_status": c.get("last_status"), "meta": meta,
            "created_at": c["created_at"]}


def h_bridges(req: Request):
    user = _require(req)
    conn = get_db()
    if req.method == "POST":
        platform = req.body.get("platform")
        if platform not in bridges.PLATFORMS:
            return 400, {"error": f"platform must be one of {bridges.PLATFORMS}"}
        cid = db_module.insert(conn, "connections", {
            "tenant_id": req.body.get("tenant_id") or user["tenant_id"],
            "platform": platform, "label": req.body.get("label"),
            "config_json": json.dumps(req.body.get("config") or {}),
            "enabled": 1 if req.body.get("enabled", True) else 0})
        c = db_module.one(conn, "SELECT * FROM connections WHERE id = ?", (cid,))
        return 201, {"connection": _connection_dto(c)}
    rows = db_module.rows(conn, "SELECT * FROM connections ORDER BY id")
    have = {r["platform"] for r in rows}
    out = [_connection_dto(c) for c in rows]
    # advertise not-yet-added platforms so the UI can show "Add" cards
    available = [{"platform": p, "meta": bridges.PLATFORM_META[p]}
                 for p in bridges.PLATFORMS if p not in have]
    return 200, {"connections": out, "available": available}


def h_bridge_update(req: Request, cid: int):
    _require(req)
    conn = get_db()
    c = db_module.one(conn, "SELECT * FROM connections WHERE id = ?", (cid,))
    if not c:
        return 404, {"error": "connection not found"}
    data = {}
    if "label" in req.body:
        data["label"] = req.body["label"]
    if "enabled" in req.body:
        data["enabled"] = 1 if req.body["enabled"] else 0
    if "config" in req.body:
        cfg = json.loads(c.get("config_json") or "{}")
        cfg.update(req.body["config"])
        data["config_json"] = json.dumps(cfg)
    if data:
        db_module.update(conn, "connections", cid, c["tenant_id"], data)
    return 200, {"connection": _connection_dto(
        db_module.one(conn, "SELECT * FROM connections WHERE id = ?", (cid,)))}


def h_bridge_delete(req: Request, cid: int):
    _require(req)
    conn = get_db()
    conn.execute("DELETE FROM connections WHERE id = ?", (cid,))
    conn.commit()
    return 200, {"ok": True}


def h_bridge_test(req: Request, cid: int):
    _require(req)
    conn = get_db()
    c = db_module.one(conn, "SELECT * FROM connections WHERE id = ?", (cid,))
    if not c:
        return 404, {"error": "connection not found"}
    result = bridges.test_connection(c["platform"], json.loads(c.get("config_json") or "{}"))
    db_module.update(conn, "connections", cid, c["tenant_id"], {
        "last_status": result.get("status", "error"), "last_sync_at": int(time.time())})
    return 200, {"result": result}


# ---- Quick-action commands recognised by the chat surface -----------------

def _chat_command(conn, message: str):
    """Return a computed reply for a known slash/quick-action, else None."""
    m = (message or "").strip().lower()
    if m in ("run all agents", "/run all", "run agents"):
        n = db_module.one(conn, "SELECT COUNT(*) AS c FROM agents WHERE enabled = 1")["c"]
        return (f"Queued a run for **{n} enabled agent(s)**. Watch Mission Control "
                "for live status as they report in.")
    if m in ("generate briefing", "/briefing", "briefing"):
        now = int(time.time()); day = now - (now % 86400)
        runs = db_module.one(conn,
            "SELECT COUNT(*) AS c FROM agent_logs WHERE created_at >= ?", (day,))["c"]
        active = db_module.one(conn,
            "SELECT COUNT(*) AS c FROM agents WHERE last_run_at >= ?", (now - 3600,))["c"]
        tok = db_module.one(conn,
            "SELECT COALESCE(SUM(token_count),0) AS t, COALESCE(SUM(cost_usd),0) AS c "
            "FROM agent_logs WHERE created_at >= ?", (day,))
        return (f"**Daily briefing** — {runs} agent runs today, {active} active in the "
                f"last hour, {tok['t']:,} tokens (${tok['c']:.2f}) spent. "
                "All systems nominal.")
    if m in ("show memory stats", "/memory", "memory stats"):
        total = db_module.one(conn, "SELECT COUNT(*) AS c FROM agent_memory")["c"]
        coll = db_module.one(conn,
            "SELECT COUNT(*) AS c FROM agent_memory WHERE memory_type='collective'")["c"]
        topics = db_module.one(conn,
            "SELECT COUNT(DISTINCT topic) AS c FROM agent_memory")["c"]
        return (f"**Memory galaxy** holds **{total} memories** across {topics} topics "
                f"— {coll} collective, {total - coll} personal.")
    return None


def h_bridge_chat(req: Request, cid: int):
    _require(req)
    conn = get_db()
    c = db_module.one(conn, "SELECT * FROM connections WHERE id = ?", (cid,))
    if not c:
        return 404, {"error": "connection not found"}
    message = (req.body.get("message") or "").strip()
    if not message:
        return 400, {"error": "message is required"}
    take_command = bool(req.body.get("take_command"))
    cfg = json.loads(c.get("config_json") or "{}")

    cmd = _chat_command(conn, message)
    reply = {"ok": True, "reply": cmd} if cmd else bridges.bridge_chat(c["platform"], cfg, message)

    # Broadcast mode — forward to every OTHER enabled, chattable connection.
    broadcast = []
    if take_command:
        others = db_module.rows(conn,
            "SELECT * FROM connections WHERE id != ? AND enabled = 1", (cid,))
        for o in others:
            if o["platform"] not in bridges.CHATTABLE:
                continue
            ocfg = json.loads(o.get("config_json") or "{}")
            r = _chat_command(conn, message) or bridges.bridge_chat(o["platform"], ocfg, message)
            if isinstance(r, dict):
                r = r.get("reply", "")
            broadcast.append({"id": o["id"], "platform": o["platform"],
                              "label": o.get("label") or o["platform"], "reply": r})

    db_module.update(conn, "connections", cid, c["tenant_id"],
                     {"last_sync_at": int(time.time())})
    # Save chat as memory so it appears in the galaxy
    reply_text = reply.get("reply", "")
    if reply_text and c["platform"] == "hermes":
        db_module.insert(conn, "agent_memory", {
            "tenant_id": c["tenant_id"], "agent_id": 110, "memory_type": "personal",
            "topic": "Chat", "fact": f"Chat: \"{message[:200]}\" → {reply_text[:200]}",
            "confidence": 0.9, "source": "chat", "vault_path": None, "created_at": int(time.time())})
    return 200, {"reply": reply_text, "ok": reply.get("ok", True),
                 "broadcast": broadcast, "take_command": take_command}


# ---------------------------------------------------------------- studio ---

def h_studio_models(req: Request):
    _require(req)
    return 200, {"models": studio.list_models()}


def h_studio_generate(req: Request):
    user = _require(req)
    conn = get_db()
    b = req.body
    config = {
        "prompt": b.get("prompt", ""), "negative_prompt": b.get("negative_prompt", ""),
        "model": b.get("model") or studio.DEFAULT_MODEL,
        "aspect_ratio": b.get("aspect_ratio", "1:1"),
        "width": b.get("width"), "height": b.get("height"),
        "num_images": b.get("num_images", 1), "seed": b.get("seed"),
        "steps": b.get("steps"), "guidance": b.get("guidance"),
        "safe_mode": b.get("safe_mode", True),
        "api_key": b.get("api_key"),
    }
    # Fall back to a connected Fal bridge's stored key when the request omits one.
    if not config["api_key"]:
        fal = db_module.one(conn,
            "SELECT config_json FROM connections WHERE platform='fal' AND enabled=1 "
            "ORDER BY id LIMIT 1")
        if fal:
            config["api_key"] = json.loads(fal.get("config_json") or "{}").get("api_key")
    session_id = str(b.get("session_id") or f"u{user['id']}")
    result = studio.generate_image(config, dest_dir=str(SITE_DIR), session_id=session_id)
    if result.get("error"):
        # Log the failed attempt for cost/telemetry visibility, then surface it.
        _log_studio(conn, user, config, result, ok=False)
        return 502, {"error": result["error"]}
    _log_studio(conn, user, config, result, ok=True)
    return 200, {"images": result["images"], "model": result["model"],
                 "cost": result.get("cost", 0)}


def _log_studio(conn, user, config, result, ok: bool):
    """Record a studio generation to agent_logs for cost tracking."""
    tid = user["tenant_id"]
    a = db_module.one(conn, "SELECT id FROM agents WHERE tenant_id = ? ORDER BY id LIMIT 1", (tid,))
    if not a:
        return  # no agent to attribute the log to; skip silently
    n = len(result.get("images", []))
    db_module.insert(conn, "agent_logs", {
        "tenant_id": tid, "agent_id": a["id"], "action": "studio_generate",
        "summary": (f"Generated {n} image(s) · {config['model']}" if ok
                    else f"Studio error · {config['model']}"),
        "details_json": json.dumps({"prompt": config["prompt"][:200],
                                    "model": config["model"], "ok": ok,
                                    "error": result.get("error")}),
        "token_count": 0, "cost_usd": result.get("cost", 0)})


# ---------------------------------------------------------------- omi ------

def h_omi_webhook(req: Request):
    """Public Omi webhook — no bearer auth (Omi can't send one). Optional
    ?tenant_id= or ?token= shared secret; defaults to the first tenant."""
    conn = get_db()
    tid = req.tenant_filter()
    if tid is None:
        first = db_module.one(conn, "SELECT id FROM tenants ORDER BY id LIMIT 1")
        tid = first["id"] if first else 1
    receipt = omi.process_webhook(req.body or {}, tenant_id=tid)
    return 200, {"ok": True, **receipt}


# ---------------------------------------------------------------- overview -

def h_overview(req: Request):
    _require(req)
    conn = get_db()
    now = int(time.time())
    day_start = now - (now % 86400)
    tenants = db_module.rows(conn, "SELECT * FROM tenants ORDER BY id")
    projects = []
    for t in tenants:
        c = db_module.one(conn,
            "SELECT COUNT(*) AS total, "
            "SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) AS enabled, "
            "SUM(CASE WHEN last_status='error' THEN 1 ELSE 0 END) AS errors, "
            "SUM(CASE WHEN last_run_at >= ? THEN 1 ELSE 0 END) AS active "
            "FROM agents WHERE tenant_id = ?", (now - 3600, t["id"]))
        last = db_module.one(conn,
            "SELECT l.summary, l.created_at, a.real_name, a.name FROM agent_logs l "
            "JOIN agents a ON a.id = l.agent_id WHERE l.tenant_id = ? "
            "ORDER BY l.created_at DESC LIMIT 1", (t["id"],))
        runs = db_module.one(conn,
            "SELECT COUNT(*) AS c FROM agent_logs WHERE tenant_id = ? AND created_at >= ?",
            (t["id"], day_start))["c"]
        projects.append({"id": t["id"], "name": t["name"], "slug": t["slug"],
                         "brand_colour": t["brand_colour"],
                         "agent_count": c["total"] or 0, "active_count": c["active"] or 0,
                         "error_count": c["errors"] or 0, "runs_today": runs,
                         "latest": last})
    totals = db_module.one(conn,
        "SELECT COUNT(*) AS agents, "
        "SUM(CASE WHEN last_run_at >= ? THEN 1 ELSE 0 END) AS active FROM agents",
        (now - 3600,))
    mems = db_module.one(conn, "SELECT COUNT(*) AS c FROM agent_memory")["c"]
    runs_today = db_module.one(conn,
        "SELECT COUNT(*) AS c FROM agent_logs WHERE created_at >= ?", (day_start,))["c"]
    recent = db_module.rows(conn,
        "SELECT l.summary, l.action, l.created_at, l.tenant_id, a.real_name, a.name, "
        "a.certificate_json, t.name AS tenant_name FROM agent_logs l "
        "JOIN agents a ON a.id = l.agent_id JOIN tenants t ON t.id = l.tenant_id "
        "ORDER BY l.created_at DESC, l.id DESC LIMIT 30")
    for r in recent:
        cert = json.loads(r.pop("certificate_json") or "{}")
        r["avatar_colour"] = cert.get("avatar_colour")
        r["avatar_initials"] = cert.get("avatar_initials")
    return 200, {"projects": projects, "recent_activity": recent,
                 "stats": {"total_agents": totals["agents"] or 0,
                           "active_now": totals["active"] or 0,
                           "total_memories": mems, "runs_today": runs_today}}


# ═══════════════════════════════════════════════════════════════════════════
# FEATURE MODULES — pipelines, kanban, group chat, gallery, leads, email, voice
# Thin handlers over db_module; real logic lives in features.py.
# ═══════════════════════════════════════════════════════════════════════════

# ---------------------------------------------------------------- pipelines -

def _run_dto(r: dict) -> dict:
    return {"id": r["id"], "pipeline_id": r["pipeline_id"], "status": r["status"],
            "started_at": r["started_at"], "finished_at": r.get("finished_at"),
            "result": json.loads(r.get("result_json") or "{}"), "error": r.get("error")}


def _pipeline_runs_list(conn, pid: int, limit: int = 25) -> list:
    rows = db_module.rows(conn,
        "SELECT * FROM pipeline_runs WHERE pipeline_id = ? "
        "ORDER BY started_at DESC, id DESC LIMIT ?", (pid, limit))
    return [_run_dto(r) for r in rows]


def _pipeline_dto(conn, p: dict) -> dict:
    steps = json.loads(p.get("steps_json") or "[]")
    agg = db_module.one(conn,
        "SELECT COUNT(*) AS c, MAX(started_at) AS last, "
        "MAX(CASE WHEN id = (SELECT MAX(id) FROM pipeline_runs WHERE pipeline_id = ?) "
        "THEN status END) AS last_status FROM pipeline_runs WHERE pipeline_id = ?",
        (p["id"], p["id"]))
    return {"id": p["id"], "tenant_id": p["tenant_id"], "name": p["name"],
            "steps": sorted(steps, key=lambda s: s.get("position", 0)),
            "enabled": bool(p["enabled"]), "created_at": p["created_at"],
            "updated_at": p["updated_at"], "run_count": agg["c"] or 0,
            "last_run_at": agg["last"], "last_status": agg["last_status"]}


def h_pipelines(req: Request):
    user = _require(req)
    conn = get_db()
    if req.method == "POST":
        tid = req.body.get("tenant_id") or user["tenant_id"]
        pid = db_module.insert(conn, "pipelines", {
            "tenant_id": tid, "name": (req.body.get("name") or "Untitled pipeline")[:120],
            "steps_json": json.dumps(req.body.get("steps") or []),
            "enabled": 1 if req.body.get("enabled", True) else 0})
        p = db_module.one(conn, "SELECT * FROM pipelines WHERE id = ?", (pid,))
        return 201, {"pipeline": _pipeline_dto(conn, p)}
    tid = req.tenant_filter()
    scope, args = ("WHERE tenant_id = ?", (tid,)) if tid else ("", ())
    rows = db_module.rows(conn, f"SELECT * FROM pipelines {scope} ORDER BY id DESC", args)
    return 200, {"pipelines": [_pipeline_dto(conn, p) for p in rows]}


def h_pipeline_detail(req: Request, pid: int):
    _require(req)
    conn = get_db()
    p = db_module.one(conn, "SELECT * FROM pipelines WHERE id = ?", (pid,))
    if not p:
        return 404, {"error": "pipeline not found"}
    dto = _pipeline_dto(conn, p)
    dto["runs"] = _pipeline_runs_list(conn, pid)
    return 200, {"pipeline": dto}


def h_pipeline_update(req: Request, pid: int):
    _require(req)
    conn = get_db()
    p = db_module.one(conn, "SELECT * FROM pipelines WHERE id = ?", (pid,))
    if not p:
        return 404, {"error": "pipeline not found"}
    data = {}
    if "name" in req.body:
        data["name"] = (req.body["name"] or "")[:120]
    if "steps" in req.body:
        data["steps_json"] = json.dumps(req.body["steps"])
    if "enabled" in req.body:
        data["enabled"] = 1 if req.body["enabled"] else 0
    data["updated_at"] = int(time.time())
    db_module.update(conn, "pipelines", pid, p["tenant_id"], data)
    return 200, {"pipeline": _pipeline_dto(conn,
        db_module.one(conn, "SELECT * FROM pipelines WHERE id = ?", (pid,)))}


def h_pipeline_delete(req: Request, pid: int):
    _require(req)
    conn = get_db()
    conn.execute("DELETE FROM pipelines WHERE id = ?", (pid,))
    conn.commit()
    return 200, {"ok": True}


def h_pipeline_run(req: Request, pid: int):
    _require(req)
    conn = get_db()
    p = db_module.one(conn, "SELECT * FROM pipelines WHERE id = ?", (pid,))
    if not p:
        return 404, {"error": "pipeline not found"}
    rid = db_module.insert(conn, "pipeline_runs", {
        "pipeline_id": pid, "tenant_id": p["tenant_id"], "status": "running",
        "started_at": int(time.time()), "result_json": "{}"})
    result = features.run_pipeline(conn, db_module, p, p["tenant_id"])
    conn.execute(
        "UPDATE pipeline_runs SET status = ?, finished_at = ?, result_json = ?, error = ? "
        "WHERE id = ?",
        (result["status"], int(time.time()), json.dumps(result),
         ("one or more steps failed" if result["status"] == "error" else None), rid))
    conn.commit()
    run = db_module.one(conn, "SELECT * FROM pipeline_runs WHERE id = ?", (rid,))
    return 200, {"run": _run_dto(run)}


def h_pipeline_runs(req: Request, pid: int):
    _require(req)
    return 200, {"runs": _pipeline_runs_list(get_db(), pid)}


# ---------------------------------------------------------------- kanban ----

_KANBAN_JOIN = (
    "SELECT k.*, COALESCE(a.real_name, a.name) AS a_name, "
    "json_extract(a.certificate_json, '$.avatar_colour') AS a_colour, "
    "json_extract(a.certificate_json, '$.avatar_initials') AS a_initials "
    "FROM kanban_tasks k LEFT JOIN agents a ON a.id = k.assigned_agent_id ")


def _kanban_dto(row: dict) -> dict:
    agent = None
    if row.get("assigned_agent_id"):
        agent = {"id": row["assigned_agent_id"], "name": row.get("a_name") or "Agent",
                 "colour": row.get("a_colour") or "#19C3E6",
                 "initials": row.get("a_initials") or "AG"}
    return {"id": row["id"], "tenant_id": row["tenant_id"], "title": row["title"],
            "description": row.get("description"), "status": row["status"],
            "priority": row["priority"], "assigned_agent_id": row.get("assigned_agent_id"),
            "labels": json.loads(row.get("labels_json") or "[]"),
            "due_date": row.get("due_date"), "position": row.get("position") or 0,
            "created_at": row["created_at"], "updated_at": row["updated_at"], "agent": agent}


def h_kanban_tasks(req: Request):
    user = _require(req)
    conn = get_db()
    if req.method == "POST":
        tid = req.body.get("tenant_id") or user["tenant_id"]
        kid = db_module.insert(conn, "kanban_tasks", {
            "tenant_id": tid, "title": (req.body.get("title") or "Untitled task")[:200],
            "description": req.body.get("description") or "",
            "status": req.body.get("status") or "backlog",
            "priority": req.body.get("priority") or "medium",
            "assigned_agent_id": req.body.get("assigned_agent_id") or None,
            "labels_json": json.dumps(req.body.get("labels") or []),
            "due_date": req.body.get("due_date"), "updated_at": int(time.time())})
        row = db_module.one(conn, _KANBAN_JOIN + "WHERE k.id = ?", (kid,))
        return 201, {"task": _kanban_dto(row)}
    tid = req.tenant_filter()
    clauses, args = [], []
    if tid:
        clauses.append("k.tenant_id = ?"); args.append(tid)
    if req.query.get("status"):
        clauses.append("k.status = ?"); args.append(req.query["status"])
    if req.query.get("assigned_agent_id"):
        clauses.append("k.assigned_agent_id = ?"); args.append(int(req.query["assigned_agent_id"]))
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    rows = db_module.rows(conn, _KANBAN_JOIN + where + " ORDER BY k.position, k.id", tuple(args))
    return 200, {"tasks": [_kanban_dto(r) for r in rows]}


def h_kanban_update(req: Request, kid: int):
    _require(req)
    conn = get_db()
    k = db_module.one(conn, "SELECT * FROM kanban_tasks WHERE id = ?", (kid,))
    if not k:
        return 404, {"error": "task not found"}
    data = {}
    for key in ("title", "description", "status", "priority", "assigned_agent_id",
                "due_date", "position"):
        if key in req.body:
            data[key] = req.body[key]
    if "labels" in req.body:
        data["labels_json"] = json.dumps(req.body["labels"])
    data["updated_at"] = int(time.time())
    db_module.update(conn, "kanban_tasks", kid, k["tenant_id"], data)
    row = db_module.one(conn, _KANBAN_JOIN + "WHERE k.id = ?", (kid,))
    return 200, {"task": _kanban_dto(row)}


def h_kanban_delete(req: Request, kid: int):
    _require(req)
    conn = get_db()
    conn.execute("DELETE FROM kanban_tasks WHERE id = ?", (kid,))
    conn.commit()
    return 200, {"ok": True}


def h_kanban_autoassign(req: Request, kid: int):
    _require(req)
    conn = get_db()
    k = db_module.one(conn, "SELECT * FROM kanban_tasks WHERE id = ?", (kid,))
    if not k:
        return 404, {"error": "task not found"}
    task = {"title": k["title"], "description": k.get("description"),
            "labels": json.loads(k.get("labels_json") or "[]")}
    res = features.auto_assign_agent(conn, db_module, task, k["tenant_id"])
    if res.get("agent_id"):
        db_module.update(conn, "kanban_tasks", kid, k["tenant_id"],
                         {"assigned_agent_id": res["agent_id"], "updated_at": int(time.time())})
    row = db_module.one(conn, _KANBAN_JOIN + "WHERE k.id = ?", (kid,))
    return 200, {"task": _kanban_dto(row), "reason": res.get("reason"), "agent": res.get("agent")}


# ---------------------------------------------------------------- war room --

_MSG_JOIN = (
    "SELECT m.*, json_extract(a.certificate_json, '$.avatar_colour') AS a_colour, "
    "json_extract(a.certificate_json, '$.avatar_initials') AS a_initials "
    "FROM chat_messages m LEFT JOIN agents a ON a.id = m.from_agent_id ")


def _msg_dto(row: dict) -> dict:
    return {"id": row["id"], "room_id": row["room_id"],
            "from_agent_id": row.get("from_agent_id"), "from_name": row["from_name"],
            "text": row["text"], "created_at": row["created_at"],
            "colour": row.get("a_colour") or ("#7B8DA8" if not row.get("from_agent_id") else "#19C3E6"),
            "initials": row.get("a_initials")}


def _room_dto(conn, r: dict) -> dict:
    stats = db_module.one(conn,
        "SELECT COUNT(*) AS c, MAX(created_at) AS last FROM chat_messages WHERE room_id = ?",
        (r["id"],))
    parts = db_module.rows(conn,
        "SELECT DISTINCT m.from_agent_id AS id, "
        "COALESCE(a.real_name, a.name, m.from_name) AS name, "
        "json_extract(a.certificate_json, '$.avatar_colour') AS colour "
        "FROM chat_messages m LEFT JOIN agents a ON a.id = m.from_agent_id "
        "WHERE m.room_id = ? LIMIT 16", (r["id"],))
    return {"id": r["id"], "tenant_id": r["tenant_id"], "name": r["name"],
            "created_at": r["created_at"], "message_count": stats["c"] or 0,
            "last_at": stats["last"],
            "participants": [{"id": p["id"], "name": p["name"],
                              "colour": p["colour"] or "#7B8DA8"} for p in parts]}


def _generate_agent_replies(conn, room: dict, rid: int, text: str) -> list:
    """When a human @mentions agents, generate up to two in-character replies."""
    roster = features.agent_roster(conn, db_module, room["tenant_id"])
    low = text.lower()
    mentioned = [a for a in roster
                 if f"@{a['slug']}" in low
                 or f"@{a['real_name'].split()[0].lower()}" in low
                 or f"@{a['real_name'].lower()}" in low]
    replies = []
    for a in mentioned[:2]:
        system = (f"You are {a['real_name']}, {a['role']} on an AI operations team. "
                  "Reply in the group chat in 1-2 short sentences, in character.")
        out = inference.generate(system, f"Message in the room: {text}\n\nYour reply:",
                                 max_tokens=120) or "On it — I'll take point on that."
        mid = db_module.insert(conn, "chat_messages", {
            "room_id": rid, "from_agent_id": a["id"], "from_name": a["real_name"],
            "text": out.strip()[:2000]})
        replies.append(_msg_dto(db_module.one(conn, _MSG_JOIN + "WHERE m.id = ?", (mid,))))
    return replies


def h_chat_rooms(req: Request):
    user = _require(req)
    conn = get_db()
    if req.method == "POST":
        tid = req.body.get("tenant_id") or user["tenant_id"]
        rid = db_module.insert(conn, "chat_rooms", {
            "tenant_id": tid, "name": (req.body.get("name") or "New room")[:120]})
        return 201, {"room": _room_dto(conn,
            db_module.one(conn, "SELECT * FROM chat_rooms WHERE id = ?", (rid,)))}
    tid = req.tenant_filter()
    scope, args = ("WHERE tenant_id = ?", (tid,)) if tid else ("", ())
    rows = db_module.rows(conn, f"SELECT * FROM chat_rooms {scope} ORDER BY id DESC", args)
    return 200, {"rooms": [_room_dto(conn, r) for r in rows]}


def h_chat_messages(req: Request, rid: int):
    _require(req)
    conn = get_db()
    room = db_module.one(conn, "SELECT * FROM chat_rooms WHERE id = ?", (rid,))
    if not room:
        return 404, {"error": "room not found"}
    if req.method == "POST":
        text = (req.body.get("text") or "").strip()
        if not text:
            return 400, {"error": "text is required"}
        from_agent_id = req.body.get("from_agent_id") or None
        from_name = "Operator"
        if from_agent_id:
            a = db_module.one(conn, "SELECT real_name, name FROM agents WHERE id = ?", (from_agent_id,))
            from_name = (a and (a["real_name"] or a["name"])) or "Agent"
        elif req.body.get("from_name"):
            from_name = str(req.body["from_name"])[:60]
        mid = db_module.insert(conn, "chat_messages", {
            "room_id": rid, "from_agent_id": from_agent_id, "from_name": from_name,
            "text": text[:2000]})
        replies = []
        if req.body.get("reply") and not from_agent_id:
            replies = _generate_agent_replies(conn, room, rid, text)
        posted = db_module.one(conn, _MSG_JOIN + "WHERE m.id = ?", (mid,))
        return 201, {"message": _msg_dto(posted), "replies": replies}
    rows = db_module.rows(conn, _MSG_JOIN + "WHERE m.room_id = ? ORDER BY m.created_at, m.id", (rid,))
    return 200, {"messages": [_msg_dto(r) for r in rows], "room": _room_dto(conn, room)}


def h_chat_summarize(req: Request, rid: int):
    _require(req)
    conn = get_db()
    room = db_module.one(conn, "SELECT * FROM chat_rooms WHERE id = ?", (rid,))
    if not room:
        return 404, {"error": "room not found"}
    msgs = db_module.rows(conn,
        "SELECT from_name, text FROM chat_messages WHERE room_id = ? ORDER BY created_at, id",
        (rid,))
    return 200, {"summary": features.summarize_thread(msgs)}


# ---------------------------------------------------------------- gallery ---

_WS_JOIN = (
    "SELECT w.*, COALESCE(a.real_name, a.name) AS agent_name, "
    "json_extract(a.certificate_json, '$.avatar_colour') AS agent_colour, "
    "json_extract(a.certificate_json, '$.avatar_initials') AS agent_initials "
    "FROM workspace_items w LEFT JOIN agents a ON a.id = w.agent_id ")


def _workspace_dto(row: dict) -> dict:
    return {"id": row["id"], "tenant_id": row["tenant_id"], "agent_id": row.get("agent_id"),
            "type": row["type"], "title": row["title"], "description": row.get("description"),
            "url": row.get("url") or "", "thumbnail": row.get("thumbnail_url") or "",
            "model": row.get("model"), "project": row.get("project_tag"),
            "agent_name": row.get("agent_name"),
            "agent_colour": row.get("agent_colour") or "#19C3E6",
            "agent_initials": row.get("agent_initials"),
            "tags": json.loads(row.get("tags_json") or "[]"), "created_at": row["created_at"]}


def h_workspace(req: Request):
    user = _require(req)
    conn = get_db()
    if req.method == "POST":
        tid = req.body.get("tenant_id") or user["tenant_id"]
        wid = db_module.insert(conn, "workspace_items", {
            "tenant_id": tid, "agent_id": req.body.get("agent_id") or None,
            "type": req.body.get("type") or "document",
            "title": (req.body.get("title") or "Untitled")[:200],
            "description": req.body.get("description") or "",
            "url": req.body.get("url") or "",
            "thumbnail_url": req.body.get("thumbnail") or req.body.get("thumbnail_url") or "",
            "model": req.body.get("model"),
            "project_tag": req.body.get("project") or req.body.get("project_tag"),
            "tags_json": json.dumps(req.body.get("tags") or [])})
        row = db_module.one(conn, _WS_JOIN + "WHERE w.id = ?", (wid,))
        return 201, {"item": _workspace_dto(row)}
    tid = req.tenant_filter()
    clauses, args = [], []
    if tid:
        clauses.append("w.tenant_id = ?"); args.append(tid)
    for q, col in (("type", "w.type"), ("agent_id", "w.agent_id"),
                   ("model", "w.model"), ("project", "w.project_tag")):
        if req.query.get(q):
            clauses.append(f"{col} = ?"); args.append(req.query[q])
    if req.query.get("q"):
        clauses.append("(w.title LIKE ? OR w.description LIKE ?)")
        term = f"%{req.query['q']}%"; args += [term, term]
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    rows = db_module.rows(conn, _WS_JOIN + where + " ORDER BY w.created_at DESC, w.id DESC",
                          tuple(args))
    return 200, {"items": [_workspace_dto(r) for r in rows]}


def h_workspace_delete(req: Request, wid: int):
    _require(req)
    conn = get_db()
    conn.execute("DELETE FROM workspace_items WHERE id = ?", (wid,))
    conn.commit()
    return 200, {"ok": True}


def h_workspace_stats(req: Request):
    _require(req)
    conn = get_db()
    tid = req.tenant_filter()
    scope, args = ("WHERE tenant_id = ?", (tid,)) if tid else ("", ())
    rows = db_module.rows(conn,
        f"SELECT type, COUNT(*) AS c FROM workspace_items {scope} GROUP BY type", args)
    return 200, {"by_type": {r["type"]: r["c"] for r in rows},
                 "total": sum(r["c"] for r in rows)}


# ---------------------------------------------------------------- leads -----

_LEAD_JOIN = ("SELECT l.*, c.name AS campaign_name FROM leads l "
              "LEFT JOIN campaigns c ON c.id = l.campaign_id ")


def _lead_dto(row: dict) -> dict:
    return {"id": row["id"], "tenant_id": row["tenant_id"], "company": row["company"],
            "contact_name": row.get("contact_name"), "email": row.get("email"),
            "phone": row.get("phone"), "source": row.get("source"), "status": row["status"],
            "campaign_id": row.get("campaign_id"), "campaign_name": row.get("campaign_name"),
            "notes": row.get("notes"), "created_at": row["created_at"]}


def _recompute_campaign(conn, cid: int) -> None:
    tot = db_module.one(conn, "SELECT COUNT(*) AS c FROM leads WHERE campaign_id = ?", (cid,))["c"]
    conv = db_module.one(conn,
        "SELECT COUNT(*) AS c FROM leads WHERE campaign_id = ? AND status = 'converted'",
        (cid,))["c"]
    rate = round(100.0 * conv / tot, 1) if tot else 0.0
    conn.execute("UPDATE campaigns SET conversion_rate = ? WHERE id = ?", (rate, cid))
    conn.commit()


def h_leads_search(req: Request):
    user = _require(req)
    conn = get_db()
    tid = req.body.get("tenant_id") or user["tenant_id"]
    found = features.search_leads(req.body.get("industry") or "", req.body.get("keywords") or "",
                                  req.body.get("location") or "", int(req.body.get("count") or 8))
    campaign_id = req.body.get("campaign_id")
    created = []
    for lead in found:
        lid = db_module.insert(conn, "leads", {
            "tenant_id": tid, "company": lead["company"],
            "contact_name": lead.get("contact_name"), "email": lead.get("email"),
            "phone": lead.get("phone"), "source": lead.get("source") or "search",
            "status": "new", "campaign_id": campaign_id, "notes": ""})
        created.append(db_module.one(conn, _LEAD_JOIN + "WHERE l.id = ?", (lid,)))
    return 200, {"leads": [_lead_dto(r) for r in created], "count": len(created)}


def h_leads(req: Request):
    _require(req)
    conn = get_db()
    tid = req.tenant_filter()
    clauses, args = [], []
    if tid:
        clauses.append("l.tenant_id = ?"); args.append(tid)
    if req.query.get("status"):
        clauses.append("l.status = ?"); args.append(req.query["status"])
    if req.query.get("campaign_id"):
        clauses.append("l.campaign_id = ?"); args.append(int(req.query["campaign_id"]))
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    rows = db_module.rows(conn, _LEAD_JOIN + where + " ORDER BY l.created_at DESC, l.id DESC",
                          tuple(args))
    return 200, {"leads": [_lead_dto(r) for r in rows]}


def h_lead_update(req: Request, lid: int):
    _require(req)
    conn = get_db()
    lead = db_module.one(conn, "SELECT * FROM leads WHERE id = ?", (lid,))
    if not lead:
        return 404, {"error": "lead not found"}
    data = {}
    for k in ("company", "contact_name", "email", "phone", "source", "status",
              "notes", "campaign_id"):
        if k in req.body:
            data[k] = req.body[k]
    if data:
        db_module.update(conn, "leads", lid, lead["tenant_id"], data)
        if lead.get("campaign_id"):
            _recompute_campaign(conn, lead["campaign_id"])
    return 200, {"lead": _lead_dto(db_module.one(conn, _LEAD_JOIN + "WHERE l.id = ?", (lid,)))}


def h_lead_convert(req: Request, lid: int):
    _require(req)
    conn = get_db()
    lead = db_module.one(conn, "SELECT * FROM leads WHERE id = ?", (lid,))
    if not lead:
        return 404, {"error": "lead not found"}
    db_module.update(conn, "leads", lid, lead["tenant_id"], {"status": "converted"})
    if lead.get("campaign_id"):
        _recompute_campaign(conn, lead["campaign_id"])
    return 200, {"lead": _lead_dto(db_module.one(conn, _LEAD_JOIN + "WHERE l.id = ?", (lid,)))}


def _campaign_dto(conn, c: dict, detail: bool = False) -> dict:
    tot = db_module.one(conn, "SELECT COUNT(*) AS c FROM leads WHERE campaign_id = ?",
                        (c["id"],))["c"]
    conv = db_module.one(conn,
        "SELECT COUNT(*) AS c FROM leads WHERE campaign_id = ? AND status = 'converted'",
        (c["id"],))["c"]
    dto = {"id": c["id"], "tenant_id": c["tenant_id"], "name": c["name"],
           "status": c["status"], "sent_count": c["sent_count"],
           "reply_count": c["reply_count"], "conversion_rate": c["conversion_rate"],
           "created_at": c["created_at"], "lead_count": tot, "converted_count": conv,
           "reply_rate": round(100.0 * c["reply_count"] / c["sent_count"], 1)
                         if c["sent_count"] else 0.0}
    if detail:
        dto["leads"] = [_lead_dto(r) for r in db_module.rows(conn,
            _LEAD_JOIN + "WHERE l.campaign_id = ? ORDER BY l.created_at DESC", (c["id"],))]
        dto["email_preview"] = _campaign_email_preview(c)
    return dto


def _campaign_email_preview(c: dict) -> str:
    out = inference.generate(
        "You write concise B2B outreach emails. Give a subject line then a 3-sentence body.",
        f"Write a short cold outreach email for the campaign '{c['name']}'.", max_tokens=200)
    if out:
        return out.strip()
    return (f"Subject: A quick idea for your team\n\nHi there —\n\nWe've been helping teams "
            f"like yours through our '{c['name']}' program, and I think there's a strong fit. "
            "Would you be open to a 15-minute call this week? Happy to tailor a few ideas to "
            "your goals.\n\nBest,\nThe team")


def h_campaigns(req: Request):
    user = _require(req)
    conn = get_db()
    if req.method == "POST":
        tid = req.body.get("tenant_id") or user["tenant_id"]
        cid = db_module.insert(conn, "campaigns", {
            "tenant_id": tid, "name": (req.body.get("name") or "New campaign")[:120],
            "status": req.body.get("status") or "active",
            "sent_count": int(req.body.get("sent_count") or 0),
            "reply_count": int(req.body.get("reply_count") or 0),
            "conversion_rate": float(req.body.get("conversion_rate") or 0)})
        return 201, {"campaign": _campaign_dto(conn,
            db_module.one(conn, "SELECT * FROM campaigns WHERE id = ?", (cid,)))}
    tid = req.tenant_filter()
    scope, args = ("WHERE tenant_id = ?", (tid,)) if tid else ("", ())
    rows = db_module.rows(conn, f"SELECT * FROM campaigns {scope} ORDER BY id DESC", args)
    return 200, {"campaigns": [_campaign_dto(conn, c) for c in rows]}


def h_campaign_detail(req: Request, cid: int):
    _require(req)
    conn = get_db()
    c = db_module.one(conn, "SELECT * FROM campaigns WHERE id = ?", (cid,))
    if not c:
        return 404, {"error": "campaign not found"}
    return 200, {"campaign": _campaign_dto(conn, c, detail=True)}


# ---------------------------------------------------------------- email -----

_EMAIL_JOIN = (
    "SELECT e.*, COALESCE(a.real_name, a.name) AS agent_name, "
    "json_extract(a.certificate_json, '$.avatar_colour') AS agent_colour, "
    "json_extract(a.certificate_json, '$.avatar_initials') AS agent_initials "
    "FROM agent_emails e LEFT JOIN agents a ON a.id = e.to_agent_id ")


def _email_dto(row: dict) -> dict:
    return {"id": row["id"], "tenant_id": row["tenant_id"],
            "to_agent_id": row.get("to_agent_id"), "from_address": row.get("from_address"),
            "to_address": row.get("to_address"), "subject": row.get("subject"),
            "body": row.get("body"), "status": row["status"], "created_at": row["created_at"],
            "agent_name": row.get("agent_name"),
            "agent_colour": row.get("agent_colour") or "#19C3E6",
            "agent_initials": row.get("agent_initials")}


def h_email_inbox(req: Request):
    _require(req)
    conn = get_db()
    tid = req.tenant_filter()
    clauses, args = [], []
    if tid:
        clauses.append("e.tenant_id = ?"); args.append(tid)
    if req.query.get("status"):
        clauses.append("e.status = ?"); args.append(req.query["status"])
    else:
        clauses.append("e.status != 'sent'")
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    rows = db_module.rows(conn, _EMAIL_JOIN + where + " ORDER BY e.created_at DESC, e.id DESC",
                          tuple(args))
    return 200, {"emails": [_email_dto(r) for r in rows]}


def h_email_send(req: Request):
    user = _require(req)
    conn = get_db()
    tid = req.body.get("tenant_id") or user["tenant_id"]
    from_agent_id = req.body.get("from_agent_id") or None
    from_address = req.body.get("from") or req.body.get("from_address")
    if from_agent_id and not from_address:
        a = db_module.one(conn, "SELECT slug FROM agents WHERE id = ?", (from_agent_id,))
        from_address = f"{(a and a['slug']) or 'agent'}@agent-os.ai"
    eid = db_module.insert(conn, "agent_emails", {
        "tenant_id": tid, "to_agent_id": None,
        "from_address": from_address or "you@agent-os.ai",
        "to_address": req.body.get("to") or req.body.get("to_address") or "",
        "subject": (req.body.get("subject") or "")[:200],
        "body": req.body.get("body") or "", "status": "sent"})
    return 201, {"email": _email_dto(db_module.one(conn, _EMAIL_JOIN + "WHERE e.id = ?", (eid,)))}


def h_email_status(req: Request, eid: int):
    _require(req)
    conn = get_db()
    e = db_module.one(conn, "SELECT * FROM agent_emails WHERE id = ?", (eid,))
    if not e:
        return 404, {"error": "email not found"}
    status = req.body.get("status")
    if status not in ("unread", "read", "replied", "archived", "sent", "bounced"):
        return 400, {"error": "invalid status"}
    db_module.update(conn, "agent_emails", eid, e["tenant_id"], {"status": status})
    return 200, {"email": _email_dto(db_module.one(conn, _EMAIL_JOIN + "WHERE e.id = ?", (eid,)))}


def h_email_metrics(req: Request):
    _require(req)
    conn = get_db()
    tid = req.tenant_filter()
    pre, args = ("tenant_id = ? AND ", (tid,)) if tid else ("", ())
    now = int(time.time())
    day_start = now - (now % 86400)

    def count(where, extra=()):
        return db_module.one(conn,
            f"SELECT COUNT(*) AS c FROM agent_emails WHERE {pre}{where}", (*args, *extra))["c"]

    received = count("status IN ('unread','read','replied','archived')")
    replied = count("status = 'replied'")
    bounced = count("status = 'bounced'")
    sent_total = count("status = 'sent'")
    return 200, {
        "sent_today": count("status = 'sent' AND created_at >= ?", (day_start,)),
        "reply_rate": round(100.0 * replied / received, 1) if received else 0.0,
        "bounce_rate": round(100.0 * bounced / (sent_total + bounced), 1)
                       if (sent_total + bounced) else 0.0,
        "received": received, "unread": count("status = 'unread'"),
        "replied": replied, "sent_total": sent_total}


# ---------------------------------------------------------------- voice -----

def _voice_dto(row: dict) -> dict:
    return {"id": row["id"], "tenant_id": row["tenant_id"], "transcript": row.get("transcript"),
            "response": row.get("response"), "duration": row.get("duration") or 0,
            "created_at": row["created_at"]}


def h_voice_transcribe(req: Request):
    """Accept a client-side transcript (Web Speech API) or audio. Without a
    server-side speech provider we echo the provided transcript so the flow
    works end-to-end in the browser."""
    _require(req)
    transcript = (req.body.get("transcript") or req.body.get("text") or "").strip()
    return 200, {"transcript": transcript, "provider": "client" if transcript else "none"}


def h_voice_chat(req: Request):
    user = _require(req)
    conn = get_db()
    tid = req.body.get("tenant_id") or user["tenant_id"]
    transcript = (req.body.get("transcript") or req.body.get("text") or "").strip()
    if not transcript:
        return 400, {"error": "transcript is required"}
    response = features.voice_reply(transcript)
    sid = db_module.insert(conn, "voice_sessions", {
        "tenant_id": tid, "transcript": transcript[:4000], "response": response[:4000],
        "duration": int(req.body.get("duration") or 0)})
    # Save as memory so it appears as a star in the galaxy
    db_module.insert(conn, "agent_memory", {
        "tenant_id": tid, "agent_id": 110, "memory_type": "personal",
        "topic": "Voice", "fact": f"Voice exchange: \"{transcript[:200]}\" → {response[:200]}",
        "confidence": 0.9, "source": "voice", "vault_path": None, "created_at": int(time.time())})
    s = db_module.one(conn, "SELECT * FROM voice_sessions WHERE id = ?", (sid,))
    return 200, {"session": _voice_dto(s), "response": response}


def h_voice_history(req: Request):
    _require(req)
    conn = get_db()
    tid = req.tenant_filter()
    scope, args = ("WHERE tenant_id = ?", (tid,)) if tid else ("", ())
    rows = db_module.rows(conn,
        f"SELECT * FROM voice_sessions {scope} ORDER BY created_at DESC, id DESC LIMIT 100", args)
    return 200, {"sessions": [_voice_dto(r) for r in rows]}


def h_voice_history_delete(req: Request, sid: int):
    _require(req)
    conn = get_db()
    conn.execute("DELETE FROM voice_sessions WHERE id = ?", (sid,))
    conn.commit()
    return 200, {"ok": True}


# ---------------------------------------------------------------- apollo ----

def h_apollo_command(req: Request):
    """Execute a voice command: parse with DeepSeek, run any computer action
    (open / build / search), reply, and persist the exchange."""
    user = _require(req)
    conn = get_db()
    tid = req.body.get("tenant_id") or user["tenant_id"]
    text = (req.body.get("text") or req.body.get("transcript") or "").strip()
    if not text:
        return 400, {"error": "text is required"}
    return 200, apollo.run_command(conn, tid, text)


def h_apollo_chat(req: Request):
    """Conversational chat with Apollo — no computer action."""
    user = _require(req)
    conn = get_db()
    tid = req.body.get("tenant_id") or user["tenant_id"]
    text = (req.body.get("text") or req.body.get("transcript") or "").strip()
    if not text:
        return 400, {"error": "text is required"}
    started = time.time()
    response = apollo.chat_reply(text)
    apollo.save_command(conn, tid, text, response, None, None, intent="chat",
                        latency_ms=int((time.time() - started) * 1000))
    return 200, {"response": response}


def h_apollo_history(req: Request):
    _require(req)
    conn = get_db()
    tid = req.tenant_filter()
    return 200, {"commands": apollo.history(conn, tid)}


def h_apollo_tts(req: Request):
    """Render Apollo's reply to natural speech with OpenAI TTS. Returns a
    base64 `data:` URL the browser plays directly; 502 when TTS is unavailable
    so the frontend can fall back to browser speech synthesis."""
    _require(req)
    text = (req.body.get("text") or "").strip()
    if not text:
        return 400, {"error": "text is required"}
    voice = req.body.get("voice") or apollo.DEFAULT_TTS_VOICE
    audio_url = apollo.synthesize_speech(text, voice)
    if not audio_url:
        return 502, {"error": "text-to-speech unavailable"}
    return 200, {"audio_url": audio_url}


# ---------------------------------------------------------------- routes ---

def h_oracle_scan(req):
    conn = get_db(); user = _require(req); tid = req.body.get("tenant_id") or user["tenant_id"]
    kw = req.body.get("keywords") or None
    data = oracle_search.oracle_scan(conn, tid, kw)
    return 200, data

def h_oracle_history(req):
    conn = get_db(); user = _require(req); tid = req.body.get("tenant_id") or user["tenant_id"]
    data = oracle_search.oracle_history(conn, tid)
    return 200, {"scans": data}

def h_oracle_delete(req, oid):
    conn = get_db(); user = _require(req); tid = req.body.get("tenant_id") or user["tenant_id"]
    conn.execute("DELETE FROM oracle_scans WHERE id=? AND tenant_id=?", (oid, tid))
    conn.commit()
    return 200, {"ok": True}

def h_search_query(req):
    conn = get_db(); user = _require(req); tid = req.body.get("tenant_id") or user["tenant_id"]
    query = req.body.get("query", "")
    top_k = req.body.get("top_k", 5)
    results = oracle_search.web_search(query, top_k)
    oracle_search.save_search(conn, tid, query, results)
    return 200, {"results": results}

def h_search_agents(req):
    conn = get_db(); user = _require(req); tid = req.body.get("tenant_id") or user["tenant_id"]
    agent_id = req.body.get("agent_id")
    query = req.body.get("query", "")
    top_k = req.body.get("top_k", 5)
    results = oracle_search.web_search(query, top_k)
    oracle_search.save_search(conn, tid, query, results, agent_id=agent_id)
    return 200, {"results": results}

ROUTES = [
    ("POST", re.compile(r"^/api/auth/login$"), h_login),
    ("POST", re.compile(r"^/api/auth/login-password$"), h_login),
    ("POST", re.compile(r"^/api/auth/set-password$"), h_set_password),
    ("GET",  re.compile(r"^/api/me$"), h_me),

    ("GET",  re.compile(r"^/api/tenants$"), h_tenants),
    ("PATCH", re.compile(r"^/api/tenants/(\d+)$"), h_tenant_update),

    ("GET",  re.compile(r"^/api/agents$"), h_agents),
    ("POST", re.compile(r"^/api/agents$"), h_agents),
    ("GET",  re.compile(r"^/api/mission-control$"), h_mission_control),
    ("GET",  re.compile(r"^/api/metrics$"), h_metrics),
    ("GET",  re.compile(r"^/api/agents/(\d+)$"), h_agent_detail),
    ("PATCH", re.compile(r"^/api/agents/(\d+)$"), h_agent_update),
    ("POST", re.compile(r"^/api/agents/(\d+)/toggle$"), h_agent_toggle),
    ("POST", re.compile(r"^/api/agents/(\d+)/run$"), h_agent_run),
    ("GET",  re.compile(r"^/api/agents/(\d+)/log$"), h_agent_log),
    ("GET",  re.compile(r"^/api/agents/(\d+)/memory$"), h_agent_memory),
    ("POST", re.compile(r"^/api/agents/(\d+)/memory$"), h_agent_memory),
    ("GET",  re.compile(r"^/api/agents/(\d+)/inbox$"), h_agent_inbox),
    ("POST", re.compile(r"^/api/agents/(\d+)/inbox$"), h_agent_inbox),

    ("GET",  re.compile(r"^/api/vault/memories$"), h_vault_memories),
    ("GET",  re.compile(r"^/api/vault/memories/([^/]+)$"), h_vault_memories_topic),
    ("POST", re.compile(r"^/api/vault/sync$"), h_vault_sync),
    ("GET",  re.compile(r"^/api/vault/galaxy$"),        h_vault_galaxy),
    ("POST", re.compile(r"^/api/vault/memories$"),      h_vault_memory_write),

    ("GET",  re.compile(r"^/api/bridges$"), h_bridges),
    ("POST", re.compile(r"^/api/bridges$"), h_bridges),
    ("PATCH", re.compile(r"^/api/bridges/(\d+)$"), h_bridge_update),
    ("DELETE", re.compile(r"^/api/bridges/(\d+)$"), h_bridge_delete),
    ("POST", re.compile(r"^/api/bridges/(\d+)/test$"), h_bridge_test),
    ("POST", re.compile(r"^/api/bridges/(\d+)/chat$"), h_bridge_chat),

    ("GET",  re.compile(r"^/api/studio/models$"), h_studio_models),
    ("POST", re.compile(r"^/api/studio/generate$"), h_studio_generate),

    ("POST", re.compile(r"^/api/omi/webhook$"), h_omi_webhook),

    # ── Feature modules ──────────────────────────────────────────────────
    # 1. Pipelines
    ("GET",  re.compile(r"^/api/pipelines$"), h_pipelines),
    ("POST", re.compile(r"^/api/pipelines$"), h_pipelines),
    ("GET",  re.compile(r"^/api/pipelines/(\d+)$"), h_pipeline_detail),
    ("PATCH", re.compile(r"^/api/pipelines/(\d+)$"), h_pipeline_update),
    ("DELETE", re.compile(r"^/api/pipelines/(\d+)$"), h_pipeline_delete),
    ("POST", re.compile(r"^/api/pipelines/(\d+)/run$"), h_pipeline_run),
    ("GET",  re.compile(r"^/api/pipelines/(\d+)/runs$"), h_pipeline_runs),
    # 2. Kanban
    ("GET",  re.compile(r"^/api/kanban/tasks$"), h_kanban_tasks),
    ("POST", re.compile(r"^/api/kanban/tasks$"), h_kanban_tasks),
    ("PATCH", re.compile(r"^/api/kanban/tasks/(\d+)$"), h_kanban_update),
    ("DELETE", re.compile(r"^/api/kanban/tasks/(\d+)$"), h_kanban_delete),
    ("POST", re.compile(r"^/api/kanban/tasks/(\d+)/auto-assign$"), h_kanban_autoassign),
    # 3. Group chat / war room
    ("GET",  re.compile(r"^/api/chat/rooms$"), h_chat_rooms),
    ("POST", re.compile(r"^/api/chat/rooms$"), h_chat_rooms),
    ("GET",  re.compile(r"^/api/chat/rooms/(\d+)/messages$"), h_chat_messages),
    ("POST", re.compile(r"^/api/chat/rooms/(\d+)/messages$"), h_chat_messages),
    ("POST", re.compile(r"^/api/chat/rooms/(\d+)/summarize$"), h_chat_summarize),
    # 4. Workspace gallery
    ("GET",  re.compile(r"^/api/workspace$"), h_workspace),
    ("POST", re.compile(r"^/api/workspace$"), h_workspace),
    ("GET",  re.compile(r"^/api/workspace/stats$"), h_workspace_stats),
    ("DELETE", re.compile(r"^/api/workspace/(\d+)$"), h_workspace_delete),
    # 5. Leads + campaigns
    ("POST", re.compile(r"^/api/leads/search$"), h_leads_search),
    ("GET",  re.compile(r"^/api/leads$"), h_leads),
    ("PATCH", re.compile(r"^/api/leads/(\d+)$"), h_lead_update),
    ("POST", re.compile(r"^/api/leads/(\d+)/convert$"), h_lead_convert),
    ("GET",  re.compile(r"^/api/campaigns$"), h_campaigns),
    ("POST", re.compile(r"^/api/campaigns$"), h_campaigns),
    ("GET",  re.compile(r"^/api/campaigns/(\d+)$"), h_campaign_detail),
    # 6. Email
    ("GET",  re.compile(r"^/api/email/inbox$"), h_email_inbox),
    ("POST", re.compile(r"^/api/email/send$"), h_email_send),
    ("GET",  re.compile(r"^/api/email/metrics$"), h_email_metrics),
    ("PATCH", re.compile(r"^/api/email/(\d+)/status$"), h_email_status),
    # 7. Voice
    ("POST", re.compile(r"^/api/voice/transcribe$"), h_voice_transcribe),
    ("POST", re.compile(r"^/api/voice/chat$"), h_voice_chat),
    ("GET",  re.compile(r"^/api/voice/history$"), h_voice_history),
    ("DELETE", re.compile(r"^/api/voice/history/(\d+)$"), h_voice_history_delete),

    # 7b. Apollo — real-time voice butler
    ("POST", re.compile(r"^/api/apollo/command$"), h_apollo_command),
    ("POST", re.compile(r"^/api/apollo/chat$"), h_apollo_chat),
    ("POST", re.compile(r"^/api/apollo/tts$"), h_apollo_tts),
    ("GET",  re.compile(r"^/api/apollo/history$"), h_apollo_history),

    # 8. Hermes Oracle
    ("POST", re.compile(r"^/api/oracle/scan$"), h_oracle_scan),
    ("GET",  re.compile(r"^/api/oracle/history$"), h_oracle_history),
    ("DELETE", re.compile(r"^/api/oracle/(\d+)$"), h_oracle_delete),
    # 9. Fire Coral Search
    ("POST", re.compile(r"^/api/search/query$"), h_search_query),
    ("POST", re.compile(r"^/api/search/agents$"), h_search_agents),

    ("GET",  re.compile(r"^/api/overview$"), h_overview),
]


class Handler(BaseHTTPRequestHandler):
    server_version = "agent-os"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")

    def _dispatch(self, method: str):
        req = Request(self, method)
        if req.path == "/healthz":
            return self._json(200, {"ok": True})
        if req.path.startswith("/api/"):
            for m, pattern, fn in ROUTES:
                if m != method:
                    continue
                match = pattern.match(req.path)
                if match:
                    groups = [g if not g.isdigit() else int(g) for g in match.groups()]
                    try:
                        result = fn(req, *groups)
                    except PermissionError:
                        return self._json(401, {"error": "sign in required"})
                    except Exception:
                        log.exception("handler error %s %s", method, req.path)
                        return self._json(500, {"error": "internal error"})
                    return self._json(*result)
            return self._json(404, {"error": "not found"})
        return self._serve_static(req.path)

    def _serve_static(self, path: str):
        # Apollo build artifacts — served read-only, no SPA fallback.
        if path.startswith("/builds/"):
            target = (BUILDS_DIR / path[len("/builds/"):]).resolve()
            if not str(target).startswith(str(BUILDS_DIR.resolve())) or not target.is_file():
                return self._json(404, {"error": "build not found"})
            return self._send_file(target)

        rel = path.lstrip("/") or "index.html"
        target = (SITE_DIR / rel).resolve()
        # SPA fallback + directory-traversal guard
        if not str(target).startswith(str(SITE_DIR.resolve())) or not target.is_file():
            target = SITE_DIR / "index.html"
        if not target.is_file():
            return self._json(404, {"error": "site not built"})
        return self._send_file(target)

    def _send_file(self, target: Path):
        ctype = {".html": "text/html", ".js": "text/javascript",
                 ".css": "text/css", ".json": "application/json",
                 ".svg": "image/svg+xml", ".png": "image/png",
                 ".ico": "image/x-icon", ".woff2": "font/woff2"}.get(
                     target.suffix, "application/octet-stream")
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, body: dict):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):    self._dispatch("GET")
    def do_POST(self):   self._dispatch("POST")
    def do_PATCH(self):  self._dispatch("PATCH")
    def do_DELETE(self): self._dispatch("DELETE")

    def log_message(self, fmt, *args):
        log.info("%s - %s", self.client_address[0], fmt % args)


# ---------------------------------------------------------------- bootstrap

def bootstrap(conn) -> None:
    """Seed tenants, copy maxgleam owner users, seed the agent roster,
    configure the vault. Idempotent — safe on every boot."""
    for spec in SEED_TENANTS:
        if not db_module.one(conn, "SELECT id FROM tenants WHERE slug = ?", (spec["slug"],)):
            db_module.insert(conn, "tenants", spec)
    _copy_maxgleam_users(conn)
    created = agents.seed_agents(conn, db_module)
    if created:
        log.info("seeded %d agent(s)", created)
    vault.configure(DB_PATH)
    demo = features.seed_demo(conn, db_module)
    if demo:
        log.info("seeded %d demo feature record(s)", demo)


def _copy_maxgleam_users(conn) -> None:
    """Copy owner users (with password hashes) from the maxgleam DB so the
    same credentials work here. Maps them to the first tenant (Max Gleam)."""
    if not os.path.exists(MAXGLEAM_DB):
        return
    first = db_module.one(conn, "SELECT id FROM tenants ORDER BY id LIMIT 1")
    if not first:
        return
    try:
        src = sqlite3.connect(f"file:{MAXGLEAM_DB}?mode=ro", uri=True)
        src.row_factory = sqlite3.Row
        users = src.execute(
            "SELECT email, name, password_hash FROM users WHERE role = 'owner'").fetchall()
        src.close()
    except Exception as e:
        log.warning("could not read maxgleam users: %s", e)
        return
    for u in users:
        if db_module.one(conn, "SELECT id FROM users WHERE email = ?", (u["email"],)):
            continue
        db_module.insert(conn, "users", {
            "tenant_id": first["id"], "email": u["email"], "name": u["name"],
            "role": "owner", "password_hash": u["password_hash"]})
        log.info("copied user %s from maxgleam", u["email"])


def main():
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    conn = get_db()
    bootstrap(conn)
    log.info("agent-os api on %s:%s db=%s site=%s",
             LISTEN_HOST, LISTEN_PORT, DB_PATH, SITE_DIR)
    ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
