"""Max Gleam — GPS crew tracking.

A cleaner's phone reports its position while they are on a job, and the office
sees every active van on one map at /tracking.

Scope is deliberately narrow. Tracking starts when a crew taps START on a job
in the crew app and stops when they mark it complete, so this records *work*,
not people: no point is stored outside an open job, and the log is pruned to
RETENTION_DAYS. That is the difference between a dispatch tool and surveillance,
and it is enforced here rather than left to the front end to honour.

    POST /api/maxgleam/gps/update       crew token — log a position
    GET  /api/maxgleam/gps/crew/:id     office     — where are they now
    GET  /api/maxgleam/gps/history/:id  office     — today's route
    GET  /api/maxgleam/gps/active       office     — every crew on the map

Positions are only accepted for a job that belongs to the calling crew, so a
valid token can never write another crew's trail.
"""
from __future__ import annotations

import logging
import math
import re
import threading
import time

from server import maxgleam_crew, maxgleam_notify, partner

log = logging.getLogger("agentos.maxgleam")

DEFAULT_TENANT_ID = maxgleam_notify.DEFAULT_TENANT_ID

# A phone with a good fix will offer a point every second or two. One every
# MIN_INTERVAL is plenty to draw a route and keeps the table small.
MIN_INTERVAL = 20
RETENTION_DAYS = 14

# A crew is "active" on the map if they have reported within this window.
ACTIVE_WINDOW = 30 * 60

# Rejected outright: a fix this bad is noise, and a fix outside these bounds
# is a bug or a spoof.
MAX_ACCURACY_M = 500
UK_BOUNDS = {"lat": (49.0, 61.5), "lng": (-9.0, 2.5)}

# A fix within this radius of the assigned stop counts as "on site". Generous
# enough to survive an urban GPS fix and a big car park, tight enough that a
# crew reporting from the wrong street reads as off-site — which is the signal
# the office actually wants.
GEOFENCE_M = 150

_local = threading.local()
_last_write: dict[int, float] = {}
_last_write_lock = threading.Lock()


def _conn():
    conn = partner._conn()
    if not getattr(_local, "schema_ready", False):
        _ensure_schema(conn)
        _local.schema_ready = True
    return conn


def _ensure_schema(conn) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS gps_log (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id           INTEGER REFERENCES jobs(id),
          subcontractor_id INTEGER REFERENCES subcontractors(id),
          lat              REAL NOT NULL,
          lng              REAL NOT NULL,
          timestamp        INTEGER NOT NULL
        )""")
    conn.execute("""CREATE INDEX IF NOT EXISTS idx_gps_crew_time
                    ON gps_log(subcontractor_id, timestamp)""")
    conn.execute("""CREATE INDEX IF NOT EXISTS idx_gps_job
                    ON gps_log(job_id, timestamp)""")
    conn.commit()


def _rows(sql: str, args=()) -> list[dict]:
    return [dict(r) for r in _conn().execute(sql, args).fetchall()]


def _one(sql: str, args=()) -> dict | None:
    r = _conn().execute(sql, args).fetchone()
    return dict(r) if r else None


def _today() -> str:
    return time.strftime("%Y-%m-%d")


def _day_bounds(date: str) -> tuple[int, int]:
    start = int(time.mktime(time.strptime(f"{date} 00:00:00", "%Y-%m-%d %H:%M:%S")))
    return start, start + 86400


def haversine_m(a_lat: float, a_lng: float, b_lat: float, b_lng: float) -> float:
    """Great-circle distance in metres — enough to total a day's driving."""
    r = 6371000.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp = math.radians(b_lat - a_lat)
    dl = math.radians(b_lng - a_lng)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


# ── Writing ─────────────────────────────────────────────────────────

def _clean_coords(body: dict) -> tuple[float, float] | None:
    try:
        lat = float(body.get("lat"))
        lng = float(body.get("lng"))
    except (TypeError, ValueError):
        return None
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return None
    if math.isnan(lat) or math.isnan(lng):
        return None
    return lat, lng


def update(crew: dict, body: dict) -> tuple[int, dict]:
    """POST /api/maxgleam/gps/update — log where this crew is right now."""
    coords = _clean_coords(body)
    if not coords:
        return 400, {"error": "lat and lng are required"}
    lat, lng = coords

    if not (UK_BOUNDS["lat"][0] <= lat <= UK_BOUNDS["lat"][1]
            and UK_BOUNDS["lng"][0] <= lng <= UK_BOUNDS["lng"][1]):
        return 400, {"error": "that position is outside the service area"}

    # A position is only meaningful against a job this crew is actually on, so
    # settle that first: a fix for a job that is not open must be rejected
    # whatever its quality, not quietly accepted-and-dropped as poor accuracy.
    job = maxgleam_crew._crew_job(crew, body.get("job_id"))
    if not job:
        return 404, {"error": "that job is not on your round"}
    if job["status"] == "done" or job["completed_at"]:
        return 409, {"error": "that clean is already complete — tracking has stopped"}
    if not job["started_at"]:
        return 409, {"error": "start the job before tracking begins"}

    accuracy = body.get("accuracy")
    if accuracy is not None:
        try:
            if float(accuracy) > MAX_ACCURACY_M:
                # Not an error the crew can act on — the phone is indoors or
                # on a poor fix. Accept the call, drop the point.
                return 200, {"ok": True, "stored": False, "reason": "poor_accuracy"}
        except (TypeError, ValueError):
            pass

    now = int(time.time())
    with _last_write_lock:
        last = _last_write.get(crew["id"], 0)
        if now - last < MIN_INTERVAL:
            return 200, {"ok": True, "stored": False, "reason": "too_soon",
                         "retry_after": MIN_INTERVAL - int(now - last)}
        _last_write[crew["id"]] = now

    conn = _conn()
    conn.execute(
        "INSERT INTO gps_log (job_id, subcontractor_id, lat, lng, timestamp) VALUES (?,?,?,?,?)",
        (job["id"], crew["id"], lat, lng, now))
    conn.commit()
    return 200, {"ok": True, "stored": True, "timestamp": now,
                 "job_id": job["id"], "crew_id": crew["id"]}


def prune(now: int | None = None) -> dict:
    """Drop points past the retention window. Safe to call from a cron."""
    now = now or int(time.time())
    cutoff = now - RETENTION_DAYS * 86400
    conn = _conn()
    cur = conn.execute("DELETE FROM gps_log WHERE timestamp < ?", (cutoff,))
    conn.commit()
    log.info("maxgleam gps: pruned %s points older than %s days", cur.rowcount, RETENTION_DAYS)
    return {"deleted": cur.rowcount, "cutoff": cutoff, "retention_days": RETENTION_DAYS}


# ── Reading ─────────────────────────────────────────────────────────

def _crew_row(crew_id: int, tenant_id: int) -> dict | None:
    return _one("SELECT id, name, phone, company_name, active FROM subcontractors "
                " WHERE id = ? AND tenant_id = ?", (crew_id, tenant_id))


def _current_job(crew_id: int) -> dict | None:
    """The job this crew is stood on: started today, not yet finished."""
    return _one(
        "SELECT j.id AS job_id, j.scheduled_date, j.started_at, j.status, "
        "       p.address, p.postcode, p.latitude, p.longitude "
        "  FROM jobs j JOIN properties p ON p.id = j.property_id "
        " WHERE j.subcontractor_id = ? AND j.scheduled_date = ? "
        "   AND j.started_at IS NOT NULL AND j.completed_at IS NULL "
        " ORDER BY j.started_at DESC LIMIT 1", (crew_id, _today()))


def _point_dto(p: dict) -> dict:
    return {"lat": p["lat"], "lng": p["lng"], "timestamp": p["timestamp"],
            "job_id": p["job_id"]}


def _geofence(position: dict | None, job: dict | None) -> dict | None:
    """How far the last fix sits from the stop it belongs to.

    None when it can't be told — no fix yet, or the property was never
    geocoded. When it can, ``on_site`` lets the office spot a crew reporting
    from somewhere other than the job they are meant to be on.
    """
    if not position or not job:
        return None
    lat, lng = job.get("latitude"), job.get("longitude")
    if lat is None or lng is None:
        return None
    metres = haversine_m(position["lat"], position["lng"], lat, lng)
    return {"distance_m": round(metres), "on_site": metres <= GEOFENCE_M}


def _on_site_seconds(job: dict | None, now: int) -> int | None:
    """Seconds since the crew started the job they are stood on."""
    if not job or not job.get("started_at"):
        return None
    return max(0, now - int(job["started_at"]))


def crew_position(crew_id: int, tenant_id: int = DEFAULT_TENANT_ID) -> tuple[int, dict]:
    """GET /api/maxgleam/gps/crew/:id — where this crew was last seen."""
    crew = _crew_row(crew_id, tenant_id)
    if not crew:
        return 404, {"error": "no such crew"}

    last = _one("SELECT * FROM gps_log WHERE subcontractor_id = ? "
                "ORDER BY timestamp DESC LIMIT 1", (crew_id,))
    now = int(time.time())
    position = _point_dto(last) if last else None
    job = _current_job(crew_id)
    return 200, {
        "crew": {"id": crew["id"], "name": crew["name"], "phone": crew["phone"],
                 "company_name": crew["company_name"]},
        "position": position,
        "age_seconds": (now - last["timestamp"]) if last else None,
        "live": bool(last and now - last["timestamp"] <= ACTIVE_WINDOW),
        "job": job,
        "geofence": _geofence(position, job),
        "on_site_seconds": _on_site_seconds(job, now),
    }


def crew_history(crew_id: int, date: str | None = None,
                 tenant_id: int = DEFAULT_TENANT_ID) -> tuple[int, dict]:
    """GET /api/maxgleam/gps/history/:id — one day's route as an array."""
    crew = _crew_row(crew_id, tenant_id)
    if not crew:
        return 404, {"error": "no such crew"}

    date = (date or "").strip() or _today()
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
        return 400, {"error": "date must be YYYY-MM-DD"}
    try:
        start, end = _day_bounds(date)
    except ValueError:
        return 400, {"error": "date must be YYYY-MM-DD"}

    pts = _rows("SELECT * FROM gps_log WHERE subcontractor_id = ? "
                " AND timestamp >= ? AND timestamp < ? ORDER BY timestamp",
                (crew_id, start, end))
    points = [_point_dto(p) for p in pts]

    metres = 0.0
    for a, b in zip(points, points[1:]):
        metres += haversine_m(a["lat"], a["lng"], b["lat"], b["lng"])

    return 200, {
        "crew": {"id": crew["id"], "name": crew["name"]},
        "date": date,
        "points": points,
        "summary": {
            "count": len(points),
            "distance_m": round(metres),
            "distance_miles": round(metres / 1609.344, 1),
            "first_seen": points[0]["timestamp"] if points else None,
            "last_seen": points[-1]["timestamp"] if points else None,
            "jobs": sorted({p["job_id"] for p in points if p["job_id"]}),
        },
    }


def active_crews(tenant_id: int = DEFAULT_TENANT_ID) -> tuple[int, dict]:
    """GET /api/maxgleam/gps/active — every crew to draw on the map.

    One row per crew that has reported today, newest fix first, with the job
    they are on so a pin can say more than a name.
    """
    now = int(time.time())
    start, end = _day_bounds(_today())

    rs = _rows(
        "SELECT g.subcontractor_id, g.lat, g.lng, g.timestamp, g.job_id, "
        "       s.name, s.phone, s.company_name "
        "  FROM gps_log g "
        "  JOIN subcontractors s ON s.id = g.subcontractor_id "
        " WHERE s.tenant_id = ? AND g.timestamp >= ? AND g.timestamp < ? "
        "   AND g.id = (SELECT MAX(id) FROM gps_log WHERE subcontractor_id = g.subcontractor_id "
        "               AND timestamp >= ? AND timestamp < ?) "
        " ORDER BY g.timestamp DESC",
        (tenant_id, start, end, start, end))

    crews = []
    for r in rs:
        job = _current_job(r["subcontractor_id"])
        position = {"lat": r["lat"], "lng": r["lng"], "timestamp": r["timestamp"],
                    "job_id": r["job_id"]}
        crews.append({
            "crew_id": r["subcontractor_id"],
            "name": r["name"],
            "phone": r["phone"],
            "company_name": r["company_name"],
            "position": position,
            "age_seconds": now - r["timestamp"],
            "live": now - r["timestamp"] <= ACTIVE_WINDOW,
            "job": job,
            "geofence": _geofence(position, job),
            "on_site_seconds": _on_site_seconds(job, now),
        })

    # Today's stops give the map something to show before anyone clocks on.
    jobs = _rows(
        "SELECT j.id AS job_id, j.status, j.started_at, j.completed_at, j.subcontractor_id, "
        "       p.address, p.postcode, p.latitude, p.longitude, s.name AS crew_name "
        "  FROM jobs j JOIN properties p ON p.id = j.property_id "
        "  LEFT JOIN subcontractors s ON s.id = j.subcontractor_id "
        " WHERE j.tenant_id = ? AND j.scheduled_date = ? "
        "   AND p.latitude IS NOT NULL AND p.longitude IS NOT NULL "
        " ORDER BY p.position, j.id", (tenant_id, _today()))

    return 200, {
        "date": _today(),
        "crews": crews,
        "jobs": jobs,
        "summary": {
            "tracking": sum(1 for c in crews if c["live"]),
            "on_site": sum(1 for c in crews
                           if c["live"] and c["geofence"] and c["geofence"]["on_site"]),
            "seen_today": len(crews),
            "jobs_today": len(jobs),
            "active_window_minutes": ACTIVE_WINDOW // 60,
            "geofence_m": GEOFENCE_M,
        },
        "now": now,
    }
