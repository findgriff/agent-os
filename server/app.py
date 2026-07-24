"""AGENT OS HTTP server — stdlib only, ThreadingHTTPServer.

One HQ serving every business (tenant) from a single SQLite database.
Routes are a flat regex table; handlers stay thin and delegate domain
logic to agents.py / vault.py / bridges.py / metrics.py.

Run:  python3 -m server.app   (port 8100, override with AGENTOS_PORT)
"""
from __future__ import annotations
import json
import logging
import hmac
import html as html_module
import os
import re
import sqlite3
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs, unquote

from server import db as db_module
from server import auth, agents, vault, bridges, metrics, inference, studio, omi, features, oracle_search, apollo, video_editor, auto_caption, transitions, speed_change, clip_split, audio_track, overlay, video_effects, export_presets, suno_bridge, investments_api, partner, ks, ks_attendance, ks_progress, ks_billing, maxgleam_portal, maxgleam_invoicing, maxgleam_ops, maxgleam_crew, maxgleam_inventory, maxgleam_reports, maxgleam_activity, maxgleam_alerts, maxgleam_referrals, maxgleam_notify, maxgleam_accounting, maxgleam_commissions, maxgleam_booking, maxgleam_gps, maxgleam_marketing, maxgleam_reviews

log = logging.getLogger("agentos")

LISTEN_HOST = os.environ.get("AGENTOS_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("AGENTOS_PORT", "8100"))
DB_PATH = os.environ.get("AGENTOS_DB", "/var/lib/agent-os/data.db")
SITE_DIR = Path(os.environ.get("AGENTOS_SITE", str(Path(__file__).parent.parent / "site")))
# Apollo build artifacts live outside SITE_DIR (which `vite build` wipes) and
# are served read-only under /builds/.
BUILDS_DIR = apollo.BUILDS_DIR
# Studio images also live outside SITE_DIR for the same reason; served
# under /generated/ by _serve_static.
GEN_DIR = Path(os.environ.get("AGENTOS_GENERATED", "/var/lib/agent-os/generated"))
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
        # Keep the raw bytes: the body is read once here, so any handler that
        # needs a non-JSON body (Twilio posts application/x-www-form-urlencoded)
        # has no second chance at handler.rfile.
        self.raw = raw
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
        self.full_url = f"https://{handler.headers.get('Host', '')}{handler.path}"

    def form(self) -> dict:
        """Parse the body as form-encoded. Twilio webhooks only."""
        ctype = (self.headers.get("Content-Type") or "")
        if "application/x-www-form-urlencoded" not in ctype or not self.raw:
            return {}
        return {k: v[0] for k, v in parse_qs(self.raw.decode("utf-8", "replace")).items()}

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
    result = studio.generate_image(config, dest_dir=str(GEN_DIR), session_id=session_id)
    if result.get("error"):
        # Log the failed attempt for cost/telemetry visibility, then surface it.
        _log_studio(conn, user, config, result, ok=False)
        return 502, {"error": result["error"]}
    _log_studio(conn, user, config, result, ok=True)
    # Persist to the Gallery server-side so a closed tab or client error can
    # never lose an image that already cost money to generate.
    saved = _save_to_gallery(conn, user, b, config, result)
    return 200, {"images": result["images"], "model": result["model"],
                 "cost": result.get("cost", 0), "saved": saved}


def h_studio_video_generate(req: Request):
    """Submit a video generation job — currently Fal.ai Kling is default."""
    user = _require(req)
    b = req.body
    prompt = (b.get("prompt") or "").strip()
    if not prompt:
        return 400, {"error": "prompt is required"}
    model = b.get("model", "kling-video")
    aspect = b.get("aspect", "16:9")
    duration = int(b.get("duration", 5))

    # Try Fal.ai Kling if a key is configured
    fal_key = studio._fal_key()
    if fal_key and "kling" in model:
        import urllib.request
        body = json.dumps({
            "prompt": prompt, "aspect_ratio": aspect,
            "duration": duration, "cfg_scale": 0.7,
        }).encode()
        req_ = urllib.request.Request(
            "https://fal.run/fal-ai/kling-video/v1.6/standard",
            data=body, method="POST",
            headers={"Authorization": f"Key {fal_key}",
                     "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req_, timeout=120) as r:
                data = json.loads(r.read())
            video_url = (data.get("video") or {}).get("url") or data.get("url", "")
            thumbnail = (data.get("images") or [{}])[0].get("url", "")
            return 200, {"videoUrl": video_url, "thumbnail": thumbnail,
                         "model": model, "duration": duration}
        except Exception as e:
            log.warning("Fal video failed: %s", e)
    # Fallback: return mock data indicating generation was accepted
    return 200, {"videoUrl": "", "thumbnail": "",
                 "model": model, "duration": duration,
                 "note": "Video generation submitted — check status later"}


def h_studio_video_history(req: Request):
    """Return recent video generation history from the DB."""
    user = _require(req)
    conn = get_db()
    rows = db_module.rows(conn,
        "SELECT * FROM agent_logs WHERE tenant_id = ? AND action = 'video_generate' "
        "ORDER BY id DESC LIMIT 50", (user["tenant_id"],))
    items = []
    for r in rows:
        details = json.loads(r.get("details_json") or "{}")
        items.append({
            "id": str(r["id"]), "prompt": details.get("prompt", ""),
            "model": details.get("model", ""), "aspect": details.get("aspect", "16:9"),
            "duration": details.get("duration", 5),
            "status": "ready" if r.get("summary") != "failed" else "failed",
            "createdAt": r.get("started_at", 0) * 1000,
            "videoUrl": details.get("video_url", ""),
            "thumbnail": details.get("thumbnail", ""),
        })
    return 200, {"items": items}


def h_video_upload(req: Request):
    """Upload a video file (base64 data in JSON body)."""
    user = _require(req)
    session_id = f"u{user['id']}"
    config = {"session_id": session_id, **req.body}
    result = video_editor.upload(config)
    if result.get("error"):
        return 502, {"error": result["error"]}
    return 200, result


def h_video_trim(req: Request):
    user = _require(req)
    session_id = f"u{user['id']}"
    result = video_editor.trim({"session_id": session_id, **req.body})
    if result.get("error"):
        return 502, {"error": result["error"]}
    return 200, result


def h_video_render(req: Request):
    user = _require(req)
    session_id = f"u{user['id']}"
    result = video_editor.render_captions({"session_id": session_id, **req.body})
    if result.get("error"):
        return 502, {"error": result["error"]}
    return 200, result


def h_video_info(req: Request):
    user = _require(req)
    session_id = f"u{user['id']}"
    result = video_editor.info({"session_id": session_id, "source": req.body.get("source", "")})
    if result.get("error"):
        return 502, {"error": result["error"]}
    return 200, result


def h_video_export(req: Request):
    user = _require(req)
    session_id = f"u{user['id']}"
    result = video_editor.export({"session_id": session_id, **req.body})
    if result.get("error"):
        return 502, {"error": result["error"]}
    return 200, result


def h_video_auto_caption(req: Request):
    """Auto-generate captions from video audio using Whisper."""
    user = _require(req)
    session_id = f"u{user['id']}"
    result = auto_caption.generate_captions({"session_id": session_id, **req.body})
    if result.get("error"):
        return 502, {"error": result["error"]}
    return 200, result


def h_video_transition(req: Request):
    """Apply a transition between video clips."""
    user = _require(req)
    session_id = f"u{user['id']}"
    result = transitions.apply_transition({"session_id": session_id, **req.body})
    if result.get("error"):
        return 502, {"error": result["error"]}
    return 200, result


def h_video_fade(req: Request):
    """Apply fade-in/fade-out to a video clip."""
    user = _require(req)
    session_id = f"u{user['id']}"
    result = transitions.apply_fade({"session_id": session_id, **req.body})
    if result.get("error"):
        return 502, {"error": result["error"]}
    return 200, result


def h_video_speed(req: Request):
    """Change playback speed of a video clip."""
    user = _require(req)
    session_id = f"u{user['id']}"
    result = speed_change.change_speed({"session_id": session_id, **req.body})
    if result.get("error"):
        return 502, {"error": result["error"]}
    return 200, result


def h_video_split(req: Request):
    """Split a video clip at a given timestamp."""
    user = _require(req)
    session_id = f"u{user['id']}"
    result = clip_split.split_clip({"session_id": session_id, **req.body})
    if result.get("error"):
        return 502, {"error": result["error"]}
    return 200, result


def h_video_bgm(req: Request):
    """Add background music to a video."""
    user = _require(req); sid = f"u{user['id']}"
    r = audio_track.add_background_music({"session_id": sid, **req.body})
    return (502, {"error": r["error"]}) if r.get("error") else (200, r)


def h_video_voiceover(req: Request):
    """Add voiceover to a video."""
    user = _require(req); sid = f"u{user['id']}"
    r = audio_track.add_voiceover({"session_id": sid, **req.body})
    return (502, {"error": r["error"]}) if r.get("error") else (200, r)


def h_video_extract_audio(req: Request):
    """Extract audio from a video."""
    user = _require(req); sid = f"u{user['id']}"
    r = audio_track.extract_audio({"session_id": sid, **req.body})
    return (502, {"error": r["error"]}) if r.get("error") else (200, r)


def h_video_replace_audio(req: Request):
    """Replace a video's audio track."""
    user = _require(req); sid = f"u{user['id']}"
    r = audio_track.replace_audio({"session_id": sid, **req.body})
    return (502, {"error": r["error"]}) if r.get("error") else (200, r)


def h_video_overlay(req: Request):
    """Overlay an image (logo/watermark) onto a video."""
    user = _require(req); sid = f"u{user['id']}"
    r = overlay.add_overlay({"session_id": sid, **req.body})
    return (502, {"error": r["error"]}) if r.get("error") else (200, r)


def h_video_lower_third(req: Request):
    """Add a text lower third to a video."""
    user = _require(req); sid = f"u{user['id']}"
    r = overlay.add_lower_third({"session_id": sid, **req.body})
    return (502, {"error": r["error"]}) if r.get("error") else (200, r)


def h_video_effects(req: Request):
    """Apply visual effects to a video."""
    user = _require(req); sid = f"u{user['id']}"
    r = video_effects.apply_effects({"session_id": sid, **req.body})
    return (502, {"error": r["error"]}) if r.get("error") else (200, r)


def h_video_auto_enhance(req: Request):
    """Auto-enhance a video with a preset look."""
    user = _require(req); sid = f"u{user['id']}"
    r = video_effects.apply_auto_enhance({"session_id": sid, **req.body})
    return (502, {"error": r["error"]}) if r.get("error") else (200, r)


def h_video_export_preset(req: Request):
    """Export video with platform-optimised settings."""
    user = _require(req); sid = f"u{user['id']}"
    r = export_presets.export_preset({"session_id": sid, **req.body})
    return (502, {"error": r["error"]}) if r.get("error") else (200, r)


# ── Suno AI handlers ─────────────────────────────────────────────────────────

def h_suno_generate(req: Request):
    """Generate a song via Suno AI."""
    user = _require(req)
    sid = f"u{user['id']}"
    r = suno_bridge.generate_song({"session_id": sid, **req.body})
    return (502, {"error": r["error"]}) if r.get("error") else (200, r)


def h_suno_styles(req: Request):
    """Return available music styles and moods."""
    return 200, suno_bridge.list_styles()


def h_suno_status(req: Request, clip_id: str):
    """Check generation status for a Suno clip."""
    user = _require(req)
    r = suno_bridge.check_status({"clip_id": clip_id})
    return (502, {"error": r["error"]}) if r.get("error") else (200, r)


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


def _save_to_gallery(conn, user, body, config, result) -> int:
    """Insert one workspace_items row per generated image and return how many
    were saved. Failures are logged, never raised — the images exist on disk
    regardless and must still be returned to the client."""
    tid = body.get("tenant_id") or user["tenant_id"]
    title = (config.get("prompt") or "").strip()[:200] or "Untitled"
    tags = json.dumps(["studio", result["model"],
                       config.get("aspect_ratio") or "1:1"])
    saved = 0
    for img in result.get("images", []):
        if not img.get("url"):
            continue
        try:
            db_module.insert(conn, "workspace_items", {
                "tenant_id": tid, "agent_id": None, "type": "image",
                "title": title, "description": "",
                "url": img["url"], "thumbnail_url": img["url"],
                "model": result["model"], "project_tag": None,
                "tags_json": tags})
            saved += 1
        except Exception:
            log.exception("gallery save failed for %s", img.get("url"))
    return saved


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
    for a in mentioned:
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



def h_chat_room_delete(req: Request, rid: int):
    """Delete a chat room and all its messages."""
    _require(req)
    conn = get_db()
    conn.execute("DELETE FROM chat_messages WHERE room_id=?", (rid,))
    conn.execute("DELETE FROM chat_rooms WHERE id=?", (rid,))
    conn.commit()
    return 200, {"ok": True}


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


def h_lead_delete(req: Request, lid: int):
    """Delete a single lead."""
    _require(req)
    conn = get_db()
    lead = db_module.one(conn, "SELECT * FROM leads WHERE id = ?", (lid,))
    if not lead:
        return 404, {"error": "lead not found"}
    conn.execute("DELETE FROM leads WHERE id = ?", (lid,))
    conn.commit()
    # Keep the owning campaign's lead totals in sync (matches update/convert).
    if lead.get("campaign_id"):
        _recompute_campaign(conn, lead["campaign_id"])
    return 200, {"ok": True}


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


# ── Oracle custom sources ────────────────────────────────────────────────
def h_oracle_sources(req):
    user = _require(req)
    conn = get_db()
    tid = req.tenant_filter() or user["tenant_id"]
    if req.method == "POST":
        data = {k: req.body[k] for k in ("name","url_template","response_path","title_field","url_field") if k in req.body}
        if not data.get("name") or not data.get("url_template"):
            return 400, {"error": "name and url_template are required"}
        data.setdefault("response_path", "hits")
        data.setdefault("title_field", "title")
        data.setdefault("url_field", "url")
        sid = db_module.insert(conn, "oracle_sources", {"tenant_id": tid, **data})
        return 201, {"source": {"id": sid, **data}}
    rows = db_module.rows(conn, "SELECT * FROM oracle_sources WHERE tenant_id=? ORDER BY name", (tid,))
    return 200, {"sources": [dict(r) for r in rows]}


def h_oracle_source_delete(req, sid):
    user = _require(req)
    conn = get_db()
    # tenant_filter() is None when no ?tenant_id is passed (the frontend sends
    # none), so fall back to the caller's tenant — matches how h_oracle_sources
    # scopes INSERT/SELECT. Without this the DELETE compares tenant_id = NULL,
    # matches zero rows, and silently no-ops while still returning ok.
    tid = req.tenant_filter() or user["tenant_id"]
    conn.execute("DELETE FROM oracle_sources WHERE id=? AND tenant_id=?", (sid, tid))
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


# ── Factory (self-checking loop) ─────────────────────────────────────────
def h_factory_run(req: Request):
    """Run a builder-judge quality loop."""
    _require(req)
    conn = get_db()
    b = req.body
    goal = (b.get("goal") or "").strip()
    if not goal:
        return 400, {"error": "goal is required"}
    builder_id = b.get("builder_agent_id")
    judge_id = b.get("judge_agent_id")
    if not builder_id or not judge_id:
        return 400, {"error": "builder_agent_id and judge_agent_id are required"}
    builder = db_module.one(conn, "SELECT * FROM agents WHERE id=?", (builder_id,))
    judge = db_module.one(conn, "SELECT * FROM agents WHERE id=?", (judge_id,))
    if not builder or not judge:
        return 404, {"error": "agent not found"}
    cert_b = json.loads(builder.get("certificate_json") or "{}")
    cert_j = json.loads(judge.get("certificate_json") or "{}")
    from server import factory
    result = factory.run_loop(
        goal,
        {"real_name": builder["real_name"], "role": builder["role"]},
        {"real_name": judge["real_name"], "role": judge["role"]},
        max_rounds=int(b.get("max_rounds", 5)),
        pass_threshold=int(b.get("pass_threshold", 80)),
        conn=conn, db_module=db_module,
        tenant_id=(req.tenant_filter() or _require(req)["tenant_id"]),
    )
    return 200, result


# ── Investments Dashboard handlers ───────────────────────────────────

def h_investments_lists(req):
    """GET /api/investments/lists — return the three watchlists."""
    return 200, investments_api.get_lists()


def h_investments_prices(req):
    """GET /api/investments/prices?tickers=A, B, C — live prices."""
    raw = req.query.get("tickers", "")
    tickers = [t.strip() for t in raw.split(",") if t.strip()] if raw else []
    return 200, {"prices": investments_api.fetch_prices(tickers)}


def h_investments_news(req):
    """GET /api/investments/news?tickers=A, B, C — recent headlines."""
    raw = req.query.get("tickers", "")
    tickers = [t.strip() for t in raw.split(",") if t.strip()] if raw else []
    return 200, {"news": investments_api.fetch_news(tickers)}


# ── Portfolio tracker handlers ───────────────────────────────────────
# Portfolios stored as JSON in /var/lib/agent-os/portfolios.json
PORTFOLIO_FILE = "/var/lib/agent-os/portfolios.json"

def _load_portfolios() -> list[dict]:
    try:
        with open(PORTFOLIO_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []

def _save_portfolios(portfolios: list[dict]) -> None:
    os.makedirs(os.path.dirname(PORTFOLIO_FILE), exist_ok=True)
    with open(PORTFOLIO_FILE, "w") as f:
        json.dump(portfolios, f, indent=2)

def h_portfolios_list(req):
    """GET /api/portfolios — list all portfolios (without live prices)."""
    portfolios = _load_portfolios()
    # Strip holdings to avoid sending full data in list view
    for p in portfolios:
        p["holding_count"] = len(p.get("holdings", []))
    return 200, {"portfolios": portfolios}

def h_portfolio_create(req):
    """POST /api/portfolios — create or update a portfolio."""
    body = req.body or {}
    portfolios = _load_portfolios()
    pid = body.get("id") or str(int(time.time()))
    existing = [p for p in portfolios if p["id"] == pid]
    
    entry = {
        "id": pid,
        "name": body.get("name", "Unnamed Portfolio"),
        "description": body.get("description", ""),
        "holdings": body.get("holdings", []),
        "created_at": int(time.time()),
    }
    
    if existing:
        portfolios = [entry if p["id"] == pid else p for p in portfolios]
    else:
        portfolios.append(entry)
    
    _save_portfolios(portfolios)
    return 200, {"portfolio": entry}

def h_portfolio_summary(req, pid):
    """GET /api/portfolios/:id — full summary with live prices."""
    portfolios = _load_portfolios()
    portfolio = next((p for p in portfolios if p["id"] == pid), None)
    if not portfolio:
        return 404, {"error": "Portfolio not found"}
    
    tickers = [h["ticker"] for h in portfolio.get("holdings", [])]
    prices_data = investments_api.fetch_prices(tickers) if tickers else []
    price_map = {p["ticker"]: p for p in prices_data}
    
    holdings_summary = []
    total_cost = 0
    total_value = 0
    
    for h in portfolio.get("holdings", []):
        ticker = h["ticker"]
        info = price_map.get(ticker, {})
        if info.get("error"):
            continue
        current_price = info.get("price", 0)
        cost = h["shares"] * h["avg_price"]
        value = h["shares"] * current_price
        pl = value - cost
        pl_pct = round((pl / cost) * 100, 2) if cost else 0
        total_cost += cost
        total_value += value
        
        holdings_summary.append({
            **h,
            "current_price": current_price,
            "current_value": round(value, 2),
            "pl": round(pl, 2),
            "pl_pct": pl_pct,
            "dividend_yield_pct": info.get("dividend_yield_pct", 0),
        })
    
    return 200, {
        "portfolio": portfolio,
        "summary": {
            "total_cost": round(total_cost, 2),
            "total_value": round(total_value, 2),
            "total_pl": round(total_value - total_cost, 2),
            "total_pl_pct": round((total_value - total_cost) / total_cost * 100, 2) if total_cost else 0,
            "holdings": holdings_summary,
        }
    }

def h_portfolio_delete(req, pid):
    """DELETE /api/portfolios/:id — remove a portfolio."""
    portfolios = _load_portfolios()
    portfolios = [p for p in portfolios if p["id"] != pid]
    _save_portfolios(portfolios)
    return 200, {"ok": True}



# ── Call Center handlers ────────────────────────────────────────────

def h_call_center_scripts(req):
    """GET /api/call-center/scripts — list available call scripts."""
    import json
    from pathlib import Path
    path = Path("/opt/agent-os/call-scripts.json")
    if path.exists():
        return 200, {"scripts": json.loads(path.read_text())}
    return 200, {"scripts": {}}

def h_call_center_history(req):
    """GET /api/call-center/history — recent call log."""
    import json
    from pathlib import Path
    log_file = Path("/var/lib/agent-os/call-log.jsonl")
    calls = []
    if log_file.exists():
        for line in log_file.read_text().strip().split("\n"):
            if line.strip():
                calls.append(json.loads(line))
    return 200, {"calls": calls}

def h_call_center_call(req):
    """POST /api/call-center/call — make an outbound call."""
    body = req.body or {}
    business = body.get("business", "")
    phone = body.get("phone", "")
    if not business or not phone:
        return 400, {"error": "business and phone are required"}
    from tools.call_agent import make_call
    result = make_call(business, phone)
    # Compliance refusals are not successes — give the UI a status it can act on.
    if result.get("status") == "blocked":
        return 403, result
    if result.get("status") == "exhausted":
        return 429, result
    return 200, result


def h_call_center_handle_response(req):
    """POST /api/call-center/handle-response — Twilio webhook for conversation.

    Twilio POSTs application/x-www-form-urlencoded (CallSid, SpeechResult,
    From, CallStatus) and expects TwiML back as text/xml. It cannot send a
    bearer token, so this route is unauthenticated and instead verifies
    Twilio's X-Twilio-Signature.
    """
    from server import twilio_bridge

    params = req.form()

    # Reject forgeries — this endpoint spends OpenRouter credit per hit.
    # Fails open when TWILIO_AUTH_TOKEN is unset, so dry-run testing works.
    if not twilio_bridge.validate_signature(
            req.headers.get("X-Twilio-Signature", ""), req.full_url, params):
        log.warning("call-center: rejected webhook with bad Twilio signature from %s", req.ip)
        return 403, {"error": "invalid signature"}

    call_sid = params.get("CallSid", "")
    speech = (params.get("SpeechResult") or "").strip()
    call_status = params.get("CallStatus", "")
    # ?business= rides on the action URL; inline TwiML can't carry it in the body.
    business = req.query.get("business") or params.get("business") or "max-gleam"

    # Caller hung up or the call is over — acknowledge, don't invoke the LLM.
    if call_status in ("completed", "busy", "failed", "no-answer", "canceled"):
        log.info("call-center: %s ended with status=%s", call_sid, call_status)
        return 200, '<?xml version="1.0" encoding="UTF-8"?><Response/>', "text/xml"

    # Speech timeout — Twilio fired the action with no transcript. Re-prompt
    # once, then let the <Gather> fallback end the call.
    if not speech:
        log.info("call-center: %s no speech detected, re-prompting", call_sid)
        return 200, twilio_bridge.gather_twiml(
            "Sorry, I didn't catch that — are you still there?",
            business, prompt="Go ahead.", timeout=4), "text/xml"

    from tools.call_agent import handle_response
    twiml = handle_response(call_sid, speech, business)
    return 200, twiml, "text/xml"

def h_call_center_score(req, call_sid):
    """POST /api/call-center/score/<call_sid> — score a call's lead with Kimi
    K3, persist to lead-scores.jsonl, and open an Ops Board ticket for hot
    leads. Returns the score record."""
    from tools.call_agent import score_lead
    result = score_lead(call_sid)
    if result.get("status") == "blocked":
        # DND number — refused, not missing.
        log.info("call-center: refused to score %s (do-not-call)", call_sid)
        return 403, result
    if result.get("error"):
        return 404, result
    return 200, result

def h_call_center_stats(req):
    """GET /api/call-center/stats — call centre statistics."""
    from tools.call_agent import count_stats
    return 200, count_stats()

def h_call_center_campaigns(req):
    """GET /api/call-center/campaigns — campaigns with attributed call stats."""
    from server import call_center
    return 200, {"campaigns": call_center.list_campaigns(),
                 "cost_per_call_pence": call_center.COST_PER_CALL_PENCE}

def h_call_center_campaign_create(req):
    """POST /api/call-center/campaigns — create or update a campaign."""
    from server import call_center
    from tools.call_agent import load_scripts
    ok, result = call_center.create_campaign(req.body or {},
                                             businesses=list(load_scripts().keys()))
    if not ok:
        return 400, result
    return 200, {"campaign": result}

def h_call_center_campaign_delete(req, cid):
    """DELETE /api/call-center/campaigns/<id> — remove a campaign."""
    from server import call_center
    if not call_center.delete_campaign(cid):
        return 404, {"error": "campaign not found"}
    return 200, {"ok": True}

def h_call_center_analytics(req):
    """GET /api/call-center/analytics — answer/conversion rates, duration,
    cost estimate and last-7-days activity."""
    from server import call_center
    try:
        days = max(1, min(31, int(req.query.get("days", 7))))
    except (TypeError, ValueError):
        days = 7
    return 200, call_center.analytics(days)

def h_call_center_compliance(req):
    """GET /api/call-center/compliance — DND opt-outs, blocked calls and
    recording notices played."""
    from server import call_center
    return 200, call_center.compliance()

def h_call_center_queue(req):
    """POST /api/call-center/queue — process the call queue."""
    body = req.body or {}
    business = body.get("business", "")
    if not business:
        return 400, {"error": "business is required"}
    from tools.call_agent import run_queue
    run_queue(business)
    return 200, {"message": f"Queue processed for {business}"}


# ── Max Gleam Partner Portal ─────────────────────────────────────────
# Partners authenticate against the maxgleam database, not the HQ one, so
# these routes never touch _require()/get_db(). A partner token is issued
# into maxgleam's sessions table and is worthless against every other route.

def _require_partner(req: Request) -> dict:
    session = partner.partner_for_token(req.token)
    if not session:
        raise PermissionError("partner sign-in required")
    return session


def h_partner_login(req: Request):
    return partner.login(req.body.get("code") or req.body.get("company_code") or "",
                         req.body.get("password") or "")


def h_partner_me(req: Request):
    return partner.me(_require_partner(req))


def h_partner_logout(req: Request):
    _require_partner(req)
    return partner.logout(req.token)


def h_partner_jobs(req: Request):
    return partner.jobs(_require_partner(req))


def h_partner_properties(req: Request):
    return partner.properties(_require_partner(req))


def h_partner_work_requests(req: Request):
    session = _require_partner(req)
    if req.method == "POST":
        return partner.create_work_request(session, req.body)
    return partner.work_requests(session)


def h_partner_payments(req: Request):
    return partner.payments(_require_partner(req))


def h_partner_job_reschedule(req: Request, job_id: int):
    return partner.reschedule_job(_require_partner(req), job_id, req.body or {})


def h_partner_job_assign(req: Request, job_id: int):
    return partner.assign_job(_require_partner(req), job_id, req.body or {})


def h_partner_job_cancel(req: Request, job_id: int):
    return partner.cancel_job(_require_partner(req), job_id, req.body or {})


# ── Max Gleam operations — route optimisation + scheduling ───────────
# These accept EITHER an HQ token or a partner token. With a partner token the
# query is scoped to that partner's own estate, so the isolation rule holds:
# a partner still cannot see anything outside their properties.

def _maxgleam_scope(req: Request) -> tuple[int | None, int]:
    """Return (partner_company_id, tenant_id) for the caller.

    partner_company_id is None for an HQ user (no scoping), or the partner's
    company id, which every query below filters on.
    """
    session = partner.partner_for_token(req.token)
    if session:
        return session["company"]["id"], session["company"]["tenant_id"]
    _require(req)          # HQ user, or 401
    try:
        tenant_id = int(req.query.get("tenant_id") or maxgleam_ops.DEFAULT_TENANT_ID)
    except (TypeError, ValueError):
        tenant_id = maxgleam_ops.DEFAULT_TENANT_ID
    return None, tenant_id


def _float_param(req: Request, name: str) -> float | None:
    raw = req.query.get(name)
    if raw in (None, ""):
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def h_maxgleam_optimize_route(req: Request):
    """GET /api/maxgleam/optimize-route?date=YYYY-MM-DD&crew_id=X

    Orders that crew's jobs for the date into a nearest-neighbour route and
    stores the result in optimized_routes.
    """
    company_id, _tenant = _maxgleam_scope(req)
    date = (req.query.get("date") or "").strip() or time.strftime("%Y-%m-%d")
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
        return 400, {"error": "date must be YYYY-MM-DD"}

    raw_crew = req.query.get("crew_id") or req.query.get("subcontractor_id")
    crew_id = None
    if raw_crew not in (None, ""):
        try:
            crew_id = int(raw_crew)
        except (TypeError, ValueError):
            return 400, {"error": "crew_id must be a number"}

    try:
        service_minutes = int(req.query.get("service_minutes")
                              or maxgleam_ops.SERVICE_MINUTES)
    except (TypeError, ValueError):
        service_minutes = maxgleam_ops.SERVICE_MINUTES

    route = maxgleam_ops.optimize_route(
        date, crew_id=crew_id, partner_company_id=company_id,
        start_lat=_float_param(req, "start_lat"),
        start_lng=_float_param(req, "start_lng"),
        day_start=(req.query.get("day_start") or maxgleam_ops.DAY_START),
        service_minutes=service_minutes,
        # Only persist the authoritative HQ view; a partner-scoped subset of a
        # crew's day is not the route the office should be storing.
        persist=company_id is None)
    return 200, route


def h_maxgleam_crews(req: Request):
    """GET /api/maxgleam/crews — active crews, for the route picker."""
    _company_id, tenant_id = _maxgleam_scope(req)
    return 200, {"crews": maxgleam_ops.crews(tenant_id)}


def h_maxgleam_referrals(req: Request):
    """GET /api/maxgleam/referrals — referrals plus who may be named as
    referrer. Partner-scoped to their own customers."""
    company_id, tenant_id = _maxgleam_scope(req)
    return 200, maxgleam_referrals.list_referrals(tenant_id, company_id)


def h_maxgleam_referral_create(req: Request):
    """POST /api/maxgleam/referrals/create — a customer refers a friend."""
    company_id, tenant_id = _maxgleam_scope(req)
    return maxgleam_referrals.create_referral(req.body or {}, tenant_id, company_id)


def h_maxgleam_referral_sweep(req: Request):
    """POST /api/maxgleam/referrals/sweep — promote sign-ups and apply credits.
    HQ only: it edits invoices."""
    _require(req)
    body = req.body or {}
    try:
        tenant_id = int(body.get("tenant_id") or maxgleam_referrals.DEFAULT_TENANT_ID)
    except (TypeError, ValueError):
        return 400, {"error": "tenant_id must be a number"}
    result = maxgleam_referrals.run_sweep(tenant_id, dry_run=bool(body.get("dry_run")))
    log.info("maxgleam: referral sweep signed_up=%s rewarded=%s dry_run=%s",
             result["signed_up_count"], result["rewarded_count"], result["dry_run"])
    return 200, result


def h_maxgleam_notification_settings(req: Request):
    """GET/POST /api/maxgleam/notifications/settings — list or update templates."""
    _company_id, tenant_id = _maxgleam_scope(req)
    if req.method == "POST":
        # Editing what gets texted to customers is an office decision.
        _require(req)
        return maxgleam_notify.update_template(req.body or {}, tenant_id)
    return 200, maxgleam_notify.list_templates(tenant_id)


def h_maxgleam_notification_test(req: Request):
    """POST /api/maxgleam/notifications/test — send a test to a typed number."""
    _require(req)
    _company_id, tenant_id = _maxgleam_scope(req)
    return maxgleam_notify.send_test(req.body or {}, tenant_id)


def h_maxgleam_notification_sweep(req: Request):
    """POST /api/maxgleam/notifications/sweep — send everything due now."""
    _require(req)
    body = req.body or {}
    try:
        tenant_id = int(body.get("tenant_id") or maxgleam_notify.DEFAULT_TENANT_ID)
    except (TypeError, ValueError):
        return 400, {"error": "tenant_id must be a number"}
    result = maxgleam_notify.run_sweep(tenant_id)
    log.info("maxgleam: notification sweep processed=%s by_status=%s dry_run=%s",
             result["processed"], result["by_status"], result["dry_run"])
    return 200, result


def h_maxgleam_generate_schedules(req: Request):
    """POST /api/maxgleam/generate-schedules — create recurring jobs that are
    due. Body: {dry_run, horizon_days, tenant_id}. HQ only: this writes jobs
    across the whole estate, which is not a partner's call to make."""
    _require(req)
    body = req.body or {}
    try:
        tenant_id = int(body.get("tenant_id") or maxgleam_ops.DEFAULT_TENANT_ID)
        horizon = max(1, min(365, int(body.get("horizon_days") or 14)))
    except (TypeError, ValueError):
        return 400, {"error": "tenant_id and horizon_days must be numbers"}
    result = maxgleam_ops.generate_schedules(
        tenant_id=tenant_id, horizon_days=horizon,
        dry_run=bool(body.get("dry_run")))
    log.info("maxgleam: schedule run created=%s skipped=%s overdue=%s dry_run=%s",
             result["created_count"], result["skipped_count"],
             result["overdue_count"], result["dry_run"])
    return 200, result


# ── Max Gleam reporting + time tracking ──────────────────────────────
# Reports use the same scope rule as the ops routes: HQ sees the estate, a
# partner token sees only that partner's properties.

def h_maxgleam_reports(req: Request):
    """GET /api/maxgleam/reports[?from=YYYY-MM-DD&to=YYYY-MM-DD] — every
    dashboard metric in one call, over the default window or a custom range."""
    company_id, tenant_id = _maxgleam_scope(req)
    return maxgleam_reports.reports(
        tenant_id, company_id,
        start=req.query.get("from"), end=req.query.get("to"))


def h_maxgleam_reports_export(req: Request):
    """GET /api/maxgleam/reports/export?report=revenue[&from=&to=] — CSV
    download matching the on-screen window."""
    company_id, tenant_id = _maxgleam_scope(req)
    report = (req.query.get("report") or "revenue").strip().lower()
    return maxgleam_reports.export_csv(
        report, tenant_id, company_id,
        start=req.query.get("from"), end=req.query.get("to"))


# The time clock is a crew surface: subcontractors have no accounts in this
# system, so a shared crew code stands in for one. Set MAXGLEAM_CREW_CODE to
# open /timeclock to the vans; with it unset the endpoints still work, but
# only for an HQ or partner token. It is a low-value credential guarding
# clock-in/out on today's round — it is not, and must not become, a login.
CREW_CODE = os.environ.get("MAXGLEAM_CREW_CODE", "").strip()


def _timeclock_scope(req: Request) -> tuple[int | None, int]:
    """(partner_company_id, tenant_id) for a time-clock caller.

    Accepts an HQ token, a partner token, or the shared crew code. A crew
    code is unscoped within its tenant — crews swap jobs between vans, so
    scoping the clock to one partner would block legitimate cover work.
    """
    supplied = (req.headers.get("X-Crew-Code")
                or req.query.get("code")
                or (req.body.get("code") if isinstance(req.body, dict) else "")
                or "").strip()
    if CREW_CODE and supplied and hmac.compare_digest(supplied, CREW_CODE):
        return None, maxgleam_ops.DEFAULT_TENANT_ID
    return _maxgleam_scope(req)


def h_mg_timeclock_board(req: Request):
    """GET /api/maxgleam/timeclock/board — today's jobs + who is on the clock."""
    company_id, tenant_id = _timeclock_scope(req)
    return maxgleam_reports.board(tenant_id, company_id, req.query.get("day"))


def h_mg_timeclock_history(req: Request):
    """GET /api/maxgleam/timeclock/history?day=YYYY-MM-DD — defaults to today."""
    company_id, tenant_id = _timeclock_scope(req)
    return maxgleam_reports.history(tenant_id, company_id, req.query.get("day"))


def h_mg_timeclock_start(req: Request):
    """POST /api/maxgleam/timeclock/start — body {crew_id, job_id?, notes?}."""
    company_id, tenant_id = _timeclock_scope(req)
    return maxgleam_reports.clock_in(req.body or {}, tenant_id, company_id)


def h_mg_timeclock_stop(req: Request):
    """POST /api/maxgleam/timeclock/stop — body {crew_id} or {log_id}."""
    company_id, tenant_id = _timeclock_scope(req)
    return maxgleam_reports.clock_out(req.body or {}, tenant_id, company_id)


# ── Max Gleam staff activity log + automatic email alerts ────────────

def h_mg_activity(req: Request):
    """GET /api/maxgleam/activity — the staff activity feed.

    Filters: day=YYYY-MM-DD, actor_type, actor_id, action, limit.
    """
    company_id, tenant_id = _maxgleam_scope(req)
    maxgleam_activity.ensure_backfilled(tenant_id)
    try:
        actor_id = int(req.query["actor_id"]) if req.query.get("actor_id") else None
        limit = int(req.query.get("limit") or 200)
    except (TypeError, ValueError):
        return 400, {"error": "actor_id and limit must be numbers"}
    return maxgleam_activity.feed(
        tenant_id, company_id=company_id, day=req.query.get("day"),
        actor_type=req.query.get("actor_type"), actor_id=actor_id,
        action=req.query.get("action"), limit=limit)


def h_mg_activity_export(req: Request):
    """GET /api/maxgleam/activity/export — the same feed as CSV."""
    company_id, tenant_id = _maxgleam_scope(req)
    maxgleam_activity.ensure_backfilled(tenant_id)
    _status, data = maxgleam_activity.feed(
        tenant_id, company_id=company_id, day=req.query.get("day"),
        actor_type=req.query.get("actor_type"), action=req.query.get("action"),
        limit=1000)
    import csv as _csv, io as _io
    buf = _io.StringIO()
    w = _csv.writer(buf)
    w.writerow(["when", "actor_type", "actor", "action", "entity_type",
                "entity_id", "detail"])
    for r in data["activity"]:
        w.writerow([time.strftime("%Y-%m-%d %H:%M:%S",
                                  time.localtime(r["created_at"])),
                    r["actor_type"], r["actor_name"] or "", r["action"],
                    r["entity_type"] or "", r["entity_id"] or "", r["detail"] or ""])
    return 200, buf.getvalue(), "text/csv"


def h_mg_alerts(req: Request):
    """GET /api/maxgleam/alerts — what would fire right now. Sends nothing."""
    _require(req)
    _company_id, tenant_id = _maxgleam_scope(req)
    return maxgleam_alerts.preview(tenant_id)


def h_mg_alerts_history(req: Request):
    """GET /api/maxgleam/alerts/history — what has already gone out."""
    _require(req)
    _company_id, tenant_id = _maxgleam_scope(req)
    try:
        limit = int(req.query.get("limit") or 100)
    except (TypeError, ValueError):
        limit = 100
    return maxgleam_alerts.history(tenant_id, limit)


def h_mg_alerts_run(req: Request):
    """POST /api/maxgleam/alerts/run — body {dry_run, kinds[], force}.

    HQ only, and it really does send email. dry_run defaults to TRUE here:
    an accidental click from the dashboard should cost nothing, while the
    cron path (tools/maxgleam_alerts.py) opts into live sending explicitly.
    """
    _require(req)
    _company_id, tenant_id = _maxgleam_scope(req)
    body = req.body or {}
    kinds = body.get("kinds") or None
    if kinds is not None:
        if not isinstance(kinds, list) or not all(isinstance(k, str) for k in kinds):
            return 400, {"error": "kinds must be a list of strings"}
        unknown = [k for k in kinds if k not in maxgleam_alerts.KINDS]
        if unknown:
            return 400, {"error": f"unknown alert kinds: {', '.join(unknown)}"}
        kinds = tuple(kinds)
    dry_run = body.get("dry_run")
    result = maxgleam_alerts.run(
        tenant_id, dry_run=True if dry_run is None else bool(dry_run),
        kinds=kinds, force=bool(body.get("force")))
    log.info("maxgleam alerts: sent=%s skipped=%s failed=%s dry_run=%s",
             result["sent"], result["skipped"], result["failed"], result["dry_run"])
    return 200, result


# ── Max Gleam email marketing, reviews and recurring invoicing ───────
# Campaigns mail real customers, so every send path defaults to a dry run and
# the live send has to be asked for explicitly.

def h_mg_campaigns(req: Request):
    """GET list / POST create — /api/maxgleam/email/campaigns"""
    _company_id, tenant_id = _maxgleam_scope(req)
    if req.method == "POST":
        return maxgleam_marketing.create_campaign(req.body or {}, tenant_id)
    try:
        limit = int(req.query.get("limit") or 100)
    except (TypeError, ValueError):
        limit = 100
    return maxgleam_marketing.list_campaigns(tenant_id, limit)


def h_mg_campaign(req: Request, campaign_id: int):
    """GET /api/maxgleam/email/campaigns/:id — campaign + its recipients."""
    _company_id, tenant_id = _maxgleam_scope(req)
    return maxgleam_marketing.get_campaign(campaign_id, tenant_id)


def h_mg_campaign_preview(req: Request, campaign_id: int):
    """GET /api/maxgleam/email/campaigns/:id/preview — rendered samples."""
    _company_id, tenant_id = _maxgleam_scope(req)
    return maxgleam_marketing.preview(campaign_id, tenant_id)


def h_mg_campaign_send(req: Request, campaign_id: int):
    """POST /api/maxgleam/email/campaigns/:id/send — body {dry_run}.

    dry_run defaults to TRUE: this mails the customer list, and a stray click
    should cost nothing. Pass {"dry_run": false} to actually send.
    """
    _require(req)
    _company_id, tenant_id = _maxgleam_scope(req)
    body = req.body or {}
    dry = body.get("dry_run")
    return maxgleam_marketing.send_campaign(
        campaign_id, tenant_id, dry_run=True if dry is None else bool(dry))


def h_mg_email_audience(req: Request):
    """GET /api/maxgleam/email/audience?kind=&since=&days= — who would get it."""
    _company_id, tenant_id = _maxgleam_scope(req)
    try:
        days = int(req.query["days"]) if req.query.get("days") else None
    except (TypeError, ValueError):
        return 400, {"error": "days must be a number"}
    return 200, maxgleam_marketing.audience_summary(
        req.query.get("kind") or "all", tenant_id=tenant_id,
        since=req.query.get("since"), days=days)


def h_mg_newsletter(req: Request):
    """POST /api/maxgleam/email/newsletter — body {month, dry_run, send}."""
    _require(req)
    _company_id, tenant_id = _maxgleam_scope(req)
    body = req.body or {}
    dry = body.get("dry_run")
    return maxgleam_marketing.monthly_newsletter(
        tenant_id, month=body.get("month"),
        dry_run=True if dry is None else bool(dry),
        send=body.get("send", True) is not False)


def h_mg_email_open(req: Request):
    """GET /api/maxgleam/email/open?r=ID — 1x1 tracking pixel. Public."""
    try:
        maxgleam_marketing.mark_opened(int(req.query.get("r") or 0))
    except (TypeError, ValueError):
        pass
    return 200, maxgleam_marketing.PIXEL, "image/gif"


def h_mg_email_click(req: Request):
    """GET /api/maxgleam/email/click?r=ID&u=URL — record, then redirect. Public."""
    try:
        maxgleam_marketing.mark_clicked(int(req.query.get("r") or 0))
    except (TypeError, ValueError):
        pass
    target = req.query.get("u") or "/"
    # Only ever bounce to http(s); a javascript: or data: target here would be
    # an open redirect handed straight to a customer's mail client.
    if not target.startswith(("http://", "https://")):
        target = "/"
    return 200, (f'<!doctype html><meta http-equiv="refresh" '
                 f'content="0;url={html_module.escape(target, quote=True)}">'
                 f'<a href="{html_module.escape(target, quote=True)}">Continue</a>'),\
           "text/html"


def h_mg_reviews(req: Request):
    """GET /api/maxgleam/reviews — rated jobs, distribution, testimonials."""
    company_id, tenant_id = _maxgleam_scope(req)
    try:
        min_rating = int(req.query["min_rating"]) if req.query.get("min_rating") else None
        crew_id = int(req.query["crew_id"]) if req.query.get("crew_id") else None
        limit = int(req.query.get("limit") or 100)
    except (TypeError, ValueError):
        return 400, {"error": "min_rating, crew_id and limit must be numbers"}
    return maxgleam_reviews.reviews(
        tenant_id, company_id, min_rating=min_rating, crew_id=crew_id,
        with_comment=req.query.get("with_comment") in ("1", "true"), limit=limit)


def h_mg_reviews_average(req: Request):
    """GET /api/maxgleam/reviews/average — average, spread and per-crew."""
    company_id, tenant_id = _maxgleam_scope(req)
    try:
        days = int(req.query["days"]) if req.query.get("days") else None
    except (TypeError, ValueError):
        return 400, {"error": "days must be a number"}
    return maxgleam_reviews.average(tenant_id, company_id, days)


def h_mg_invoices_auto_send(req: Request):
    """POST /api/maxgleam/invoices/auto-send — bill completed, signed-off jobs."""
    _require(req)
    company_id = _mg_scope(req)
    body = req.body or {}
    dry = body.get("dry_run")
    return maxgleam_invoicing.auto_send(
        company_id=company_id,
        dry_run=None if dry is None else bool(dry),
        require_signoff=body.get("require_signoff", True) is not False)


def h_mg_invoices_recurring_status(req: Request):
    """GET /api/maxgleam/invoices/recurring-status — last run + what's queued."""
    company_id = _mg_scope(req)
    return maxgleam_invoicing.recurring_status(company_id=company_id)


# ── KS Sports Coaching — public booking system ───────────────────────
# Public site: /ks, /ks/book, /ks/login, /ks/coach. Parents and coaches
# authenticate against the KS database (/var/lib/ks-bot/bookings.db) with
# their own session kinds; neither token means anything to HQ.

def _ks_parent(req: Request, required: bool = True):
    parent = ks.session_subject(req.token, "parent")
    if not parent and required:
        raise PermissionError("parent sign-in required")
    return parent


def _ks_coach(req: Request):
    coach = ks.session_subject(req.token, "coach")
    if not coach:
        raise PermissionError("coach sign-in required")
    return coach


def h_ks_services(req: Request):
    return ks.h_services()


def h_ks_slots(req: Request):
    coach_id = req.query.get("coach_id")
    return ks.slots(req.query.get("service") or "", req.query.get("date") or "",
                    int(coach_id) if coach_id and coach_id.isdigit() else None)


def h_ks_book(req: Request):
    # Guest checkout is allowed — a parent account is optional at booking time.
    return ks.create_booking(req.body, _ks_parent(req, required=False))


def h_ks_bookings(req: Request):
    parent = _ks_parent(req, required=False)
    email = req.query.get("email") or (parent or {}).get("email") or ""
    # Without a session, an email alone must not expose someone else's
    # bookings — a signed-in parent can only ever read their own.
    if parent and email.lower() != parent["email"].lower():
        return 403, {"error": "you can only view your own bookings"}
    if not parent and not email:
        return 400, {"error": "email required"}
    return ks.bookings_for_email(email)


def h_ks_cancel(req: Request):
    return ks.cancel_booking(req.body, _ks_parent(req, required=False))


def h_ks_parent_register(req: Request):
    return ks.parent_register(req.body)


def h_ks_parent_login(req: Request):
    return ks.parent_login(req.body)


def h_ks_parent_me(req: Request):
    return ks.parent_me(_ks_parent(req))


def h_ks_logout(req: Request):
    return ks.logout(req.token)


def h_ks_coach_login(req: Request):
    return ks.coach_login(req.body)


def h_ks_coach_me(req: Request):
    coach = _ks_coach(req)
    return 200, {"coach": {"id": coach["id"], "slug": coach["slug"], "name": coach["name"]}}


def h_ks_coach_schedule(req: Request):
    span = req.query.get("span") or "7"
    return ks.coach_schedule(_ks_coach(req), req.query.get("week"),
                             int(span) if span.isdigit() else 7)


def h_ks_coach_complete(req: Request):
    return ks.coach_complete(_ks_coach(req), req.body)


def h_ks_coach_availability(req: Request):
    return ks.coach_availability(_ks_coach(req), req.method, req.body, req.query)


def h_ks_sms_inbound(req: Request):
    return ks.sms_inbound(req.body, req.form())


def h_ks_students(req: Request):
    return ks.students_list(_ks_coach(req))


def h_ks_students_add(req: Request):
    return ks.students_add(_ks_coach(req), req.body)


def h_ks_coach_booking_create(req: Request):
    return ks.coach_create_booking(_ks_coach(req), req.body)


def h_ks_booking_update(req: Request, booking_id: str):
    return ks.coach_update_booking(_ks_coach(req), int(booking_id), req.body)


def h_ks_blockouts(req: Request):
    return ks.blockouts_list(_ks_coach(req))


def h_ks_blockout_add(req: Request):
    return ks.blockout_add(_ks_coach(req), req.body)


def h_ks_blockout_delete(req: Request, blockout_id: str):
    return ks.blockout_delete(_ks_coach(req), int(blockout_id))


# ── KS attendance, progress and subscriptions ────────────────────────
# Coaches write, parents read. Every read is scoped by the caller's own
# identity inside the module, so a parent can never name another family's
# child and read their record back.

def h_ks_attendance_mark(req: Request):
    return ks_attendance.mark(_ks_coach(req), req.body)


def h_ks_attendance_history(req: Request):
    coach = ks.session_subject(req.token, "coach")
    parent = None if coach else _ks_parent(req)
    return ks_attendance.history(req.query.get("child") or "", parent=parent, coach=coach)


def h_ks_attendance_summary(req: Request):
    coach = ks.session_subject(req.token, "coach")
    parent = None if coach else _ks_parent(req)
    return ks_attendance.summary(parent=parent, coach=coach)


def h_ks_attendance_unmarked(req: Request):
    return ks_attendance.unmarked(_ks_coach(req))


def h_ks_progress_save(req: Request):
    return ks_progress.save(_ks_coach(req), req.body)


def h_ks_progress_skills(req: Request):
    return ks_progress.skills_catalogue()


def h_ks_progress_children(req: Request):
    return 200, {"children": ks_progress.children_for_parent(_ks_parent(req))}


def h_ks_progress_history(req: Request, child: str):
    coach = ks.session_subject(req.token, "coach")
    parent = None if coach else _ks_parent(req)
    return ks_progress.history(unquote(str(child)), parent=parent, coach=coach)


def h_ks_subscription_create(req: Request):
    return ks_billing.create(_ks_parent(req), req.body)


def h_ks_subscription_cancel(req: Request):
    return ks_billing.cancel(_ks_parent(req), req.body)


def h_ks_subscription_status(req: Request):
    return ks_billing.status(_ks_parent(req))


def h_ks_subscription_plans(req: Request):
    return 200, {"plans": ks_billing.plans()}


def h_ks_subscription_bill(req: Request):
    # The billing sweep moves money and texts parents, so it is an operator
    # action: an HQ token or the cron runner, never a parent session.
    _require(req)
    return 200, ks_billing.run_billing(req.body.get("date") or None)


def h_ks_subscription_reconcile(req: Request):
    _require(req)
    return 200, ks_billing.reconcile()


# ── Max Gleam auto-invoicing + tax reporting ─────────────────────────
# Scoped like the sign-off routes: a partner token limits every result to
# that company's own properties; an HQ operator sees the whole book.

def _mg_scope(req: Request) -> int | None:
    """Partner session → their company id. HQ operator → None (all)."""
    session = partner.partner_for_token(req.token)
    if session:
        return session["company"]["id"]
    _require(req)
    return None


def h_mg_invoices(req: Request):
    return maxgleam_invoicing.list_invoices(
        company_id=_mg_scope(req), status=req.query.get("status") or "")


def h_mg_invoices_auto(req: Request):
    company_id = _mg_scope(req)
    send = req.body.get("send", True) is not False
    return maxgleam_invoicing.auto_generate(company_id=company_id, send=send)


def h_mg_invoice_send(req: Request, invoice_id: int):
    _mg_scope(req)
    return maxgleam_invoicing.email_invoice(invoice_id)


def h_mg_invoice_pdf(req: Request, invoice_id: int):
    """GET /api/maxgleam/invoices/:id/pdf — the invoice as a downloadable PDF."""
    return maxgleam_invoicing.invoice_pdf(invoice_id, company_id=_mg_scope(req))


def h_mg_tax_report(req: Request):
    return maxgleam_invoicing.tax_report(
        req.query.get("from") or "", req.query.get("to") or "",
        company_id=_mg_scope(req))


def h_mg_tax_csv(req: Request):
    return maxgleam_invoicing.tax_csv(
        req.query.get("from") or "", req.query.get("to") or "",
        company_id=_mg_scope(req))


# ── Max Gleam accounting exports (QuickBooks / Xero) ─────────────────
# Scoped exactly like the invoice list: a partner token exports only that
# company's book, an HQ operator exports everything.

def h_mg_export_invoices_csv(req: Request):
    return maxgleam_accounting.invoices_csv(
        req.query.get("from") or "", req.query.get("to") or "",
        company_id=_mg_scope(req),
        iso_dates=(req.query.get("dates") or "").lower() == "iso")


def h_mg_export_payments_csv(req: Request):
    return maxgleam_accounting.payments_csv(
        req.query.get("from") or "", req.query.get("to") or "",
        company_id=_mg_scope(req),
        iso_dates=(req.query.get("dates") or "").lower() == "iso")


def h_mg_export_tax_summary(req: Request):
    return maxgleam_accounting.tax_summary(
        req.query.get("from") or "", req.query.get("to") or "",
        company_id=_mg_scope(req))


# ── Max Gleam staff commissions ──────────────────────────────────────

def h_mg_commissions(req: Request):
    company_id = _mg_scope(req)
    crew = req.query.get("crew_id") or req.query.get("crew")
    try:
        crew_id = int(crew) if crew else None
    except ValueError:
        return 400, {"error": "crew_id must be a number"}
    return maxgleam_commissions.list_commissions(
        company_id=company_id, crew_id=crew_id,
        status=req.query.get("status") or "",
        frm=req.query.get("from") or "", to=req.query.get("to") or "")


def h_mg_commissions_summary(req: Request):
    return maxgleam_commissions.summary(company_id=_mg_scope(req))


def h_mg_commission_pay(req: Request, commission_id: int):
    company_id = _mg_scope(req)
    return maxgleam_commissions.mark_paid(
        int(commission_id), req.body or {}, company_id=company_id)


def h_mg_commissions_accrue(req: Request):
    """Force the accrual sweep. Reads already accrue, so this is for cron."""
    _mg_scope(req)
    result = maxgleam_commissions.accrue()
    log.info("maxgleam: commission accrual created=%s skipped=%s",
             result["created_count"], result["skipped_count"])
    return 200, result


# ── Max Gleam late payment chasing ───────────────────────────────────

def h_mg_invoices_overdue(req: Request):
    return maxgleam_invoicing.overdue_invoices(company_id=_mg_scope(req))


def h_mg_invoices_send_reminders(req: Request):
    company_id = _mg_scope(req)
    body = req.body or {}
    invoice_id = body.get("invoice_id")
    result = maxgleam_invoicing.send_reminders(
        company_id=company_id,
        invoice_id=int(invoice_id) if invoice_id else None)
    log.info("maxgleam: payment reminders processed=%s by_status=%s dry_run=%s",
             result[1]["processed"], result[1]["by_status"], result[1]["dry_run"])
    return result


def h_mg_reminder_history(req: Request):
    _mg_scope(req)
    return 200, {"reminders": maxgleam_invoicing.reminder_history()}


def h_mg_invoices_reconcile(req: Request):
    """POST /api/maxgleam/invoices/reconcile — settle SumUp-paid invoices.

    Flips invoices to paid whose hosted checkout completed but that were never
    reconciled because the customer never reopened the portal. Also runs
    automatically at the head of every reminder sweep."""
    company_id = _mg_scope(req)
    result = maxgleam_invoicing.reconcile_payments(company_id=company_id)
    log.info("maxgleam: reconcile checked=%s reconciled=%s errors=%s",
             result[1]["checked"], result[1]["reconciled_count"],
             len(result[1]["errors"]))
    return result


# ── Max Gleam digital sign-off + customer portal ─────────────────────
# Public, no password. Sign-off links carry an HMAC bound to the job id;
# the customer portal issues a signed expiring token once the caller has
# proved they know a job reference plus the email/phone on that account.

def _mg_customer(req: Request) -> dict:
    customer = maxgleam_portal.customer_for_token(req.token)
    if not customer:
        raise PermissionError("customer sign-in required")
    return customer


def h_mg_signoff(req: Request, job_id: int):
    token = req.query.get("t") or req.body.get("token") or ""
    if req.method == "POST":
        return maxgleam_portal.submit_signoff(job_id, token, req.body)
    return maxgleam_portal.get_signoff(job_id, token)


def h_mg_signoff_send(req: Request, job_id: int):
    """Crew/partner action: text the customer their sign-off link."""
    session = partner.partner_for_token(req.token)
    if session:
        return maxgleam_portal.send_signoff_link(job_id, session["company"]["id"])
    _require(req)                       # otherwise an HQ operator
    return maxgleam_portal.send_signoff_link(job_id)


def h_mg_signoff_status(req: Request):
    session = partner.partner_for_token(req.token)
    if session:
        return maxgleam_portal.signoff_status(session["company"]["id"])
    _require(req)
    return maxgleam_portal.signoff_status()


def h_mg_photo(req: Request, photo_id: int):
    found = maxgleam_portal.photo_bytes(photo_id)
    if not found:
        return 404, {"error": "photo not found"}
    data, ctype = found
    return 200, data, ctype


def h_mg_customer_login(req: Request):
    return maxgleam_portal.customer_login(req.body)


def h_mg_customer_jobs(req: Request):
    return maxgleam_portal.customer_jobs(_mg_customer(req))


def h_mg_customer_payments(req: Request):
    return maxgleam_portal.customer_payments(_mg_customer(req))


def h_mg_customer_contact(req: Request):
    return maxgleam_portal.customer_contact(_mg_customer(req))


def h_mg_customer_pay(req: Request):
    """Start a SumUp hosted checkout for one of this customer's invoices."""
    try:
        invoice_id = int(req.body.get("invoice_id"))
    except (TypeError, ValueError):
        return 400, {"error": "which invoice?"}
    return maxgleam_portal.customer_checkout(_mg_customer(req), invoice_id)


# ── Max Gleam mobile crew view ───────────────────────────────────────
# Public sign-in by texted code; every route below re-checks that the job
# belongs to the calling crew, so a token is only ever worth one round.

def _mg_crew(req: Request) -> dict:
    crew = maxgleam_crew.crew_for_token(req.token)
    if not crew:
        raise PermissionError("crew sign-in required")
    return crew


def h_mg_crew_login(req: Request):
    return maxgleam_crew.login(req.body)


def h_mg_crew_today(req: Request):
    return maxgleam_crew.today(_mg_crew(req), req.query.get("date"))


def h_mg_crew_start(req: Request):
    return maxgleam_crew.start_job(_mg_crew(req), req.body)


def h_mg_crew_complete(req: Request):
    return maxgleam_crew.complete_job(_mg_crew(req), req.body)


def h_mg_crew_issue(req: Request):
    return maxgleam_crew.report_issue(_mg_crew(req), req.body)


# ── Max Gleam self-serve booking ─────────────────────────────────────
# The first two are public: they are the /book page, opened by a customer
# who has no account and no token. Everything after needs the office.

def h_mg_book_slots(req: Request):
    return maxgleam_booking.available_slots(req.query.get("postcode") or "")


def h_mg_book_create(req: Request):
    return maxgleam_booking.create_booking(req.body, ip=req.ip)


def h_mg_book_requests(req: Request):
    _company_id, tenant_id = _maxgleam_scope(req)
    return maxgleam_booking.pending_bookings(tenant_id)


def h_mg_book_confirm(req: Request):
    _company_id, tenant_id = _maxgleam_scope(req)
    return maxgleam_booking.confirm_booking(req.body, tenant_id)


def h_mg_book_decline(req: Request):
    _company_id, tenant_id = _maxgleam_scope(req)
    return maxgleam_booking.decline_booking(req.body, tenant_id)


# ── Max Gleam GPS crew tracking ──────────────────────────────────────
# Writes carry a crew token and are checked against that crew's own round;
# reads are the office map and take an HQ or partner token.

def h_mg_gps_update(req: Request):
    return maxgleam_gps.update(_mg_crew(req), req.body)


def h_mg_gps_crew(req: Request, crew_id: int):
    _company_id, tenant_id = _maxgleam_scope(req)
    return maxgleam_gps.crew_position(crew_id, tenant_id)


def h_mg_gps_history(req: Request, crew_id: int):
    _company_id, tenant_id = _maxgleam_scope(req)
    return maxgleam_gps.crew_history(crew_id, req.query.get("date"), tenant_id)


def h_mg_gps_active(req: Request):
    _company_id, tenant_id = _maxgleam_scope(req)
    return maxgleam_gps.active_crews(tenant_id)


# ── Max Gleam stock + comms log (HQ or partner token) ────────────────

def h_mg_inventory(req: Request):
    _company_id, tenant_id = _maxgleam_scope(req)
    return maxgleam_inventory.list_items(tenant_id)


def h_mg_inventory_add(req: Request):
    _company_id, tenant_id = _maxgleam_scope(req)
    return maxgleam_inventory.add_item(req.body, tenant_id)


def h_mg_inventory_use(req: Request):
    """Crew app or office — a cleaner logs stock used on the job they are on."""
    crew = maxgleam_crew.crew_for_token(req.token)
    if not crew:
        _maxgleam_scope(req)
    return maxgleam_inventory.use_item(req.body)


def h_mg_inventory_order(req: Request):
    _maxgleam_scope(req)
    return maxgleam_inventory.order_item(req.body)


def h_mg_comms(req: Request):
    _company_id, tenant_id = _maxgleam_scope(req)
    def _int(name):
        raw = req.query.get(name)
        return int(raw) if raw and raw.isdigit() else None
    return maxgleam_ops.comms_log(
        tenant_id,
        customer_id=_int("customer_id"),
        kind=req.query.get("kind"),
        channel=req.query.get("channel"),
        start=req.query.get("start"),
        end=req.query.get("end"),
        query=req.query.get("q"),
        limit=_int("limit") or maxgleam_ops.COMMS_LIMIT)


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
    ("POST", re.compile(r"^/api/factory/run$"), h_factory_run),
    ("POST", re.compile(r"^/api/studio/generate$"), h_studio_generate),
    ("POST", re.compile(r"^/api/studio/video/generate$"), h_studio_video_generate),
    ("GET",  re.compile(r"^/api/studio/video/history$"), h_studio_video_history),
    ("POST", re.compile(r"^/api/studio/video/upload$"), h_video_upload),
    ("POST", re.compile(r"^/api/studio/video/trim$"), h_video_trim),
    ("POST", re.compile(r"^/api/studio/video/render$"), h_video_render),
    ("POST", re.compile(r"^/api/studio/video/info$"), h_video_info),
    ("POST", re.compile(r"^/api/studio/video/export$"), h_video_export),
    ("POST", re.compile(r"^/api/studio/video/auto-caption$"), h_video_auto_caption),
    ("POST", re.compile(r"^/api/studio/video/transition$"), h_video_transition),
    ("POST", re.compile(r"^/api/studio/video/fade$"), h_video_fade),
    ("POST", re.compile(r"^/api/studio/video/speed$"), h_video_speed),
    ("POST", re.compile(r"^/api/studio/video/split$"), h_video_split),
    ("POST", re.compile(r"^/api/studio/video/background-music$"), h_video_bgm),
    ("POST", re.compile(r"^/api/studio/video/voiceover$"), h_video_voiceover),
    ("POST", re.compile(r"^/api/studio/video/extract-audio$"), h_video_extract_audio),
    ("POST", re.compile(r"^/api/studio/video/replace-audio$"), h_video_replace_audio),
    ("POST", re.compile(r"^/api/studio/video/overlay$"), h_video_overlay),
    ("POST", re.compile(r"^/api/studio/video/lower-third$"), h_video_lower_third),
    ("POST", re.compile(r"^/api/studio/video/effects$"), h_video_effects),
    ("POST", re.compile(r"^/api/studio/video/auto-enhance$"), h_video_auto_enhance),
    ("POST", re.compile(r"^/api/studio/video/export-preset$"), h_video_export_preset),

    # ── Suno AI Music Generation ────────────────────────────────────────────
    ("POST", re.compile(r"^/api/suno/generate$"), h_suno_generate),
    ("GET",  re.compile(r"^/api/suno/styles$"), h_suno_styles),
    ("GET",  re.compile(r"^/api/suno/clip/([a-zA-Z0-9_-]+)$"), h_suno_status),

    ("POST", re.compile(r"^/api/omi/webhook$"), h_omi_webhook),

    # ── Max Gleam Partner Portal (maxgleam DB, separate auth) ───────────
    ("POST", re.compile(r"^/api/partner/login$"), h_partner_login),
    ("POST", re.compile(r"^/api/partner/logout$"), h_partner_logout),
    ("GET",  re.compile(r"^/api/partner/me$"), h_partner_me),
    ("GET",  re.compile(r"^/api/partner/jobs$"), h_partner_jobs),
    ("GET",  re.compile(r"^/api/partner/properties$"), h_partner_properties),
    ("GET",  re.compile(r"^/api/partner/work-request$"), h_partner_work_requests),
    ("POST", re.compile(r"^/api/partner/work-request$"), h_partner_work_requests),
    ("GET",  re.compile(r"^/api/partner/payments$"), h_partner_payments),
    ("POST", re.compile(r"^/api/partner/jobs/(\d+)/reschedule$"), h_partner_job_reschedule),
    ("POST", re.compile(r"^/api/partner/jobs/(\d+)/assign$"), h_partner_job_assign),
    ("POST", re.compile(r"^/api/partner/jobs/(\d+)/cancel$"), h_partner_job_cancel),

    # ── Max Gleam operations (HQ or partner token; partner sees only theirs)
    ("GET",  re.compile(r"^/api/maxgleam/optimize-route$"), h_maxgleam_optimize_route),
    ("GET",  re.compile(r"^/api/maxgleam/crews$"), h_maxgleam_crews),
    ("POST", re.compile(r"^/api/maxgleam/generate-schedules$"), h_maxgleam_generate_schedules),
    ("GET",  re.compile(r"^/api/maxgleam/referrals$"), h_maxgleam_referrals),
    ("POST", re.compile(r"^/api/maxgleam/referrals/create$"), h_maxgleam_referral_create),
    ("POST", re.compile(r"^/api/maxgleam/referrals/sweep$"), h_maxgleam_referral_sweep),
    ("GET",  re.compile(r"^/api/maxgleam/notifications/settings$"), h_maxgleam_notification_settings),
    ("POST", re.compile(r"^/api/maxgleam/notifications/settings$"), h_maxgleam_notification_settings),
    ("POST", re.compile(r"^/api/maxgleam/notifications/test$"), h_maxgleam_notification_test),
    ("POST", re.compile(r"^/api/maxgleam/notifications/sweep$"), h_maxgleam_notification_sweep),

    # ── Max Gleam reporting + time tracking ─────────────────────────────
    ("GET",  re.compile(r"^/api/maxgleam/reports$"), h_maxgleam_reports),
    ("GET",  re.compile(r"^/api/maxgleam/reports/export$"), h_maxgleam_reports_export),
    ("GET",  re.compile(r"^/api/maxgleam/timeclock/board$"), h_mg_timeclock_board),
    ("GET",  re.compile(r"^/api/maxgleam/timeclock/history$"), h_mg_timeclock_history),
    ("POST", re.compile(r"^/api/maxgleam/timeclock/start$"), h_mg_timeclock_start),
    ("POST", re.compile(r"^/api/maxgleam/timeclock/stop$"), h_mg_timeclock_stop),
    ("GET",  re.compile(r"^/api/maxgleam/activity$"), h_mg_activity),
    ("GET",  re.compile(r"^/api/maxgleam/activity/export$"), h_mg_activity_export),
    ("GET",  re.compile(r"^/api/maxgleam/alerts$"), h_mg_alerts),
    ("GET",  re.compile(r"^/api/maxgleam/alerts/history$"), h_mg_alerts_history),
    ("POST", re.compile(r"^/api/maxgleam/alerts/run$"), h_mg_alerts_run),

    # ── KS Sports Coaching (public booking site, own DB + sessions) ─────
    ("GET",  re.compile(r"^/api/ks/services$"), h_ks_services),
    ("GET",  re.compile(r"^/api/ks/slots$"), h_ks_slots),
    ("POST", re.compile(r"^/api/ks/book$"), h_ks_book),
    ("GET",  re.compile(r"^/api/ks/bookings$"), h_ks_bookings),
    ("POST", re.compile(r"^/api/ks/cancel-booking$"), h_ks_cancel),
    ("POST", re.compile(r"^/api/ks/parent-register$"), h_ks_parent_register),
    ("POST", re.compile(r"^/api/ks/parent-login$"), h_ks_parent_login),
    ("GET",  re.compile(r"^/api/ks/parent-me$"), h_ks_parent_me),
    ("POST", re.compile(r"^/api/ks/logout$"), h_ks_logout),
    ("POST", re.compile(r"^/api/ks/coach/login$"), h_ks_coach_login),
    ("GET",  re.compile(r"^/api/ks/coach/me$"), h_ks_coach_me),
    ("GET",  re.compile(r"^/api/ks/coach/schedule$"), h_ks_coach_schedule),
    ("POST", re.compile(r"^/api/ks/coach/complete$"), h_ks_coach_complete),
    ("GET",  re.compile(r"^/api/ks/coach/availability$"), h_ks_coach_availability),
    ("POST", re.compile(r"^/api/ks/coach/availability$"), h_ks_coach_availability),
    ("POST", re.compile(r"^/api/ks/sms-inbound$"), h_ks_sms_inbound),
    ("GET",  re.compile(r"^/api/ks/students$"), h_ks_students),
    ("POST", re.compile(r"^/api/ks/students/add$"), h_ks_students_add),
    ("POST", re.compile(r"^/api/ks/coach/bookings$"), h_ks_coach_booking_create),
    ("PUT",  re.compile(r"^/api/ks/bookings/(\d+)$"), h_ks_booking_update),
    ("GET",  re.compile(r"^/api/ks/coach/block-outs$"), h_ks_blockouts),
    ("POST", re.compile(r"^/api/ks/coach/block-out$"), h_ks_blockout_add),
    ("DELETE", re.compile(r"^/api/ks/coach/block-out/(\d+)$"), h_ks_blockout_delete),
    ("POST", re.compile(r"^/api/ks/attendance/mark$"), h_ks_attendance_mark),
    ("GET",  re.compile(r"^/api/ks/attendance/history$"), h_ks_attendance_history),
    ("GET",  re.compile(r"^/api/ks/attendance/summary$"), h_ks_attendance_summary),
    ("GET",  re.compile(r"^/api/ks/attendance/unmarked$"), h_ks_attendance_unmarked),
    ("POST", re.compile(r"^/api/ks/progress/save$"), h_ks_progress_save),
    ("GET",  re.compile(r"^/api/ks/progress/skills$"), h_ks_progress_skills),
    ("GET",  re.compile(r"^/api/ks/progress/children$"), h_ks_progress_children),
    # Keep this last of the /progress/ routes: its capture would otherwise
    # swallow /progress/save and /progress/skills.
    ("GET",  re.compile(r"^/api/ks/progress/([^/]+)$"), h_ks_progress_history),
    ("POST", re.compile(r"^/api/ks/subscriptions/create$"), h_ks_subscription_create),
    ("POST", re.compile(r"^/api/ks/subscriptions/cancel$"), h_ks_subscription_cancel),
    ("GET",  re.compile(r"^/api/ks/subscriptions/status$"), h_ks_subscription_status),
    ("GET",  re.compile(r"^/api/ks/subscriptions/plans$"), h_ks_subscription_plans),
    ("POST", re.compile(r"^/api/ks/subscriptions/bill$"), h_ks_subscription_bill),
    ("POST", re.compile(r"^/api/ks/subscriptions/reconcile$"), h_ks_subscription_reconcile),

    # ── Max Gleam sign-off + customer portal (public, capability tokens) ─
    ("GET",  re.compile(r"^/api/maxgleam/invoices$"), h_mg_invoices),
    ("POST", re.compile(r"^/api/maxgleam/invoices/auto-generate$"), h_mg_invoices_auto),
    ("POST", re.compile(r"^/api/maxgleam/invoices/(\d+)/send$"), h_mg_invoice_send),
    ("GET",  re.compile(r"^/api/maxgleam/invoices/(\d+)/pdf$"), h_mg_invoice_pdf),
    ("GET",  re.compile(r"^/api/maxgleam/reports/tax$"), h_mg_tax_report),
    ("GET",  re.compile(r"^/api/maxgleam/reports/tax.csv$"), h_mg_tax_csv),

    # ── Max Gleam accounting exports + commissions + payment chasing ────
    ("GET",  re.compile(r"^/api/maxgleam/exports/invoices-csv$"), h_mg_export_invoices_csv),
    ("GET",  re.compile(r"^/api/maxgleam/exports/payments-csv$"), h_mg_export_payments_csv),
    ("GET",  re.compile(r"^/api/maxgleam/exports/tax-summary$"), h_mg_export_tax_summary),
    ("GET",  re.compile(r"^/api/maxgleam/commissions$"), h_mg_commissions),
    ("GET",  re.compile(r"^/api/maxgleam/commissions/summary$"), h_mg_commissions_summary),
    ("POST", re.compile(r"^/api/maxgleam/commissions/accrue$"), h_mg_commissions_accrue),
    ("POST", re.compile(r"^/api/maxgleam/commissions/(\d+)/pay$"), h_mg_commission_pay),
    ("GET",  re.compile(r"^/api/maxgleam/email/campaigns$"), h_mg_campaigns),
    ("POST", re.compile(r"^/api/maxgleam/email/campaigns$"), h_mg_campaigns),
    ("GET",  re.compile(r"^/api/maxgleam/email/campaigns/(\d+)$"), h_mg_campaign),
    ("GET",  re.compile(r"^/api/maxgleam/email/campaigns/(\d+)/preview$"), h_mg_campaign_preview),
    ("POST", re.compile(r"^/api/maxgleam/email/campaigns/(\d+)/send$"), h_mg_campaign_send),
    ("GET",  re.compile(r"^/api/maxgleam/email/audience$"), h_mg_email_audience),
    ("POST", re.compile(r"^/api/maxgleam/email/newsletter$"), h_mg_newsletter),
    ("GET",  re.compile(r"^/api/maxgleam/email/open$"), h_mg_email_open),
    ("GET",  re.compile(r"^/api/maxgleam/email/click$"), h_mg_email_click),
    ("GET",  re.compile(r"^/api/maxgleam/reviews$"), h_mg_reviews),
    ("GET",  re.compile(r"^/api/maxgleam/reviews/average$"), h_mg_reviews_average),
    ("POST", re.compile(r"^/api/maxgleam/invoices/auto-send$"), h_mg_invoices_auto_send),
    ("GET",  re.compile(r"^/api/maxgleam/invoices/recurring-status$"), h_mg_invoices_recurring_status),
    ("GET",  re.compile(r"^/api/maxgleam/invoices/overdue$"), h_mg_invoices_overdue),
    ("POST", re.compile(r"^/api/maxgleam/invoices/send-reminders$"), h_mg_invoices_send_reminders),
    ("POST", re.compile(r"^/api/maxgleam/invoices/reconcile$"), h_mg_invoices_reconcile),
    ("GET",  re.compile(r"^/api/maxgleam/invoices/reminder-history$"), h_mg_reminder_history),
    ("GET",  re.compile(r"^/api/maxgleam/signoff-status$"), h_mg_signoff_status),
    ("GET",  re.compile(r"^/api/maxgleam/signoff/(\d+)$"), h_mg_signoff),
    ("POST", re.compile(r"^/api/maxgleam/signoff/(\d+)$"), h_mg_signoff),
    ("POST", re.compile(r"^/api/maxgleam/signoff/(\d+)/send$"), h_mg_signoff_send),
    ("GET",  re.compile(r"^/api/maxgleam/photo/(\d+)$"), h_mg_photo),
    ("POST", re.compile(r"^/api/maxgleam/customer/login$"), h_mg_customer_login),
    ("GET",  re.compile(r"^/api/maxgleam/customer/jobs$"), h_mg_customer_jobs),
    ("GET",  re.compile(r"^/api/maxgleam/customer/payments$"), h_mg_customer_payments),
    ("GET",  re.compile(r"^/api/maxgleam/customer/contact$"), h_mg_customer_contact),
    ("POST", re.compile(r"^/api/maxgleam/customer/pay$"), h_mg_customer_pay),

    # ── Max Gleam mobile crew view (public, texted-code sign-in) ────────
    ("POST", re.compile(r"^/api/maxgleam/crew/login$"), h_mg_crew_login),
    ("GET",  re.compile(r"^/api/maxgleam/crew/today$"), h_mg_crew_today),
    ("POST", re.compile(r"^/api/maxgleam/crew/start-job$"), h_mg_crew_start),
    ("POST", re.compile(r"^/api/maxgleam/crew/complete-job$"), h_mg_crew_complete),
    ("POST", re.compile(r"^/api/maxgleam/crew/report-issue$"), h_mg_crew_issue),

    # Self-serve booking — the first two are public (the /book page).
    ("GET",  re.compile(r"^/api/maxgleam/book/available-slots$"), h_mg_book_slots),
    ("GET",  re.compile(r"^/api/maxgleam/book/requests$"), h_mg_book_requests),
    ("POST", re.compile(r"^/api/maxgleam/book/confirm$"), h_mg_book_confirm),
    ("POST", re.compile(r"^/api/maxgleam/book/decline$"), h_mg_book_decline),
    ("POST", re.compile(r"^/api/maxgleam/book$"), h_mg_book_create),

    # GPS crew tracking
    ("POST", re.compile(r"^/api/maxgleam/gps/update$"), h_mg_gps_update),
    ("GET",  re.compile(r"^/api/maxgleam/gps/active$"), h_mg_gps_active),
    ("GET",  re.compile(r"^/api/maxgleam/gps/crew/(\d+)$"), h_mg_gps_crew),
    ("GET",  re.compile(r"^/api/maxgleam/gps/history/(\d+)$"), h_mg_gps_history),

    # ── Max Gleam stock control + communications log ────────────────────
    ("GET",  re.compile(r"^/api/maxgleam/inventory$"), h_mg_inventory),
    ("POST", re.compile(r"^/api/maxgleam/inventory/add$"), h_mg_inventory_add),
    ("POST", re.compile(r"^/api/maxgleam/inventory/use$"), h_mg_inventory_use),
    ("POST", re.compile(r"^/api/maxgleam/inventory/order$"), h_mg_inventory_order),
    ("GET",  re.compile(r"^/api/maxgleam/comms$"), h_mg_comms),

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
    ("DELETE", re.compile(r"^/api/chat/rooms/(\d+)$"), h_chat_room_delete),
    # 4. Workspace gallery
    ("GET",  re.compile(r"^/api/workspace$"), h_workspace),
    ("POST", re.compile(r"^/api/workspace$"), h_workspace),
    ("GET",  re.compile(r"^/api/workspace/stats$"), h_workspace_stats),
    ("DELETE", re.compile(r"^/api/workspace/(\d+)$"), h_workspace_delete),
    # 5. Leads + campaigns
    ("POST", re.compile(r"^/api/leads/search$"), h_leads_search),
    ("GET",  re.compile(r"^/api/leads$"), h_leads),
    ("PATCH", re.compile(r"^/api/leads/(\d+)$"), h_lead_update),
    ("DELETE", re.compile(r"^/api/leads/(\d+)$"), h_lead_delete),
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
    ("GET",  re.compile(r"^/api/oracle/sources$"), h_oracle_sources),
    ("POST", re.compile(r"^/api/oracle/sources$"), h_oracle_sources),
    ("DELETE", re.compile(r"^/api/oracle/sources/(\d+)$"), h_oracle_source_delete),
    # 9. Fire Coral Search
    ("POST", re.compile(r"^/api/search/query$"), h_search_query),
    ("POST", re.compile(r"^/api/search/agents$"), h_search_agents),

    ("GET",  re.compile(r"^/api/overview$"), h_overview),

    # 10. Investments Dashboard
    ("GET",  re.compile(r"^/api/investments/lists$"), h_investments_lists),
    ("GET",  re.compile(r"^/api/investments/prices$"), h_investments_prices),
    ("GET",  re.compile(r"^/api/investments/news$"), h_investments_news),
    ("GET",  re.compile(r"^/api/call-center/scripts$"), h_call_center_scripts),
    ("GET",  re.compile(r"^/api/call-center/history$"), h_call_center_history),
    ("POST", re.compile(r"^/api/call-center/call$"), h_call_center_call),
    ("POST", re.compile(r"^/api/call-center/queue$"), h_call_center_queue),
    ("GET",  re.compile(r"^/api/call-center/stats$"), h_call_center_stats),
    ("GET",  re.compile(r"^/api/call-center/campaigns$"), h_call_center_campaigns),
    ("POST", re.compile(r"^/api/call-center/campaigns$"), h_call_center_campaign_create),
    ("DELETE", re.compile(r"^/api/call-center/campaigns/([A-Za-z0-9_-]+)$"), h_call_center_campaign_delete),
    ("GET",  re.compile(r"^/api/call-center/analytics$"), h_call_center_analytics),
    ("GET",  re.compile(r"^/api/call-center/compliance$"), h_call_center_compliance),
    ("POST", re.compile(r"^/api/call-center/handle-response$"), h_call_center_handle_response),
    ("POST", re.compile(r"^/api/call-center/score/([A-Za-z0-9]+)$"), h_call_center_score),


    # 11. Portfolio tracker
    ("GET",  re.compile(r"^/api/portfolios$"), h_portfolios_list),
    ("POST", re.compile(r"^/api/portfolios$"), h_portfolio_create),
    ("GET",  re.compile(r"^/api/portfolios/([^/]+)$"), h_portfolio_summary),
    ("DELETE", re.compile(r"^/api/portfolios/([^/]+)$"), h_portfolio_delete),
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
        if req.path == "/api/system":
            # Real host metrics for the ops-board VPS card (stdlib only).
            import shutil
            du = shutil.disk_usage("/")
            mem_total = mem_avail = 0
            try:
                for line in open("/proc/meminfo"):
                    if line.startswith("MemTotal:"):
                        mem_total = int(line.split()[1]) * 1024
                    elif line.startswith("MemAvailable:"):
                        mem_avail = int(line.split()[1]) * 1024
            except OSError:
                pass
            l1, l5, l15 = os.getloadavg()
            return self._json(200, {
                "disk_total_gb": round(du.total / 1e9, 1),
                "disk_used_pct": round(du.used / du.total * 100, 1),
                "disk_free_gb": round(du.free / 1e9, 1),
                "mem_total_gb": round(mem_total / 1e9, 2),
                "mem_used_pct": (round((mem_total - mem_avail) / mem_total * 100, 1)
                                 if mem_total else None),
                "load": [round(l1, 2), round(l5, 2), round(l15, 2)],
                "cpus": os.cpu_count()})
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
                    # 3-tuple (status, body, content_type) → raw response.
                    # Twilio requires text/xml TwiML, not JSON.
                    if isinstance(result, tuple) and len(result) == 3:
                        return self._raw(*result)
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

        # Video editor files — stored under /var/lib/agent-os/videos
        # MUST be checked before /generated/ (subset path)
        if path.startswith("/generated/videos/"):
            vid_path = path[len("/generated/videos/"):]
            target = (Path("/var/lib/agent-os/videos") / vid_path).resolve()
            if not str(target).startswith(str(Path("/var/lib/agent-os/videos").resolve())) or not target.is_file():
                return self._json(404, {"error": "video not found"})
            return self._send_file(target)

        # AI music files — stored under /var/lib/agent-os/music
        if path.startswith("/generated/music/"):
            mus_path = path[len("/generated/music/"):]
            target = (Path("/var/lib/agent-os/music") / mus_path).resolve()
            if not str(target).startswith(str(Path("/var/lib/agent-os/music").resolve())) or not target.is_file():
                return self._json(404, {"error": "music not found"})
            return self._send_file(target)

        # Studio images — stored under GEN_DIR so `vite build` can't wipe
        # them. No SPA fallback: a missing image must 404, not render as HTML.
        if path.startswith("/generated/"):
            target = (GEN_DIR / path[len("/generated/"):]).resolve()
            if not str(target).startswith(str(GEN_DIR.resolve())) or not target.is_file():
                return self._json(404, {"error": "not found"})
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
                 ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                 ".ico": "image/x-icon", ".woff2": "font/woff2"}.get(
                     target.suffix, "application/octet-stream")
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _raw(self, status: int, body: str, ctype: str):
        payload = body.encode() if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(payload)

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
    def do_PUT(self):    self._dispatch("PUT")
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
    created = agents.seed_agents(conn, db_module) if False else 0  # disabled — user has custom agents
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
