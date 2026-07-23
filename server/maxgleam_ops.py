"""Max Gleam operations — route optimisation and recurring schedule generation.

Both features read and write the maxgleam database (/var/lib/maxgleam/app.db),
NOT the AGENT OS one. Like server.partner, this keeps its own connection: the
shared server.db helper would run the HQ schema against maxgleam.

Route optimisation
------------------
Nearest-neighbour ordering of a crew's jobs for one date, using
properties.latitude/longitude. Distances are haversine (straight line) scaled
by ROAD_FACTOR to approximate road distance, and drive time uses a tiered
speed model — this estate runs from Aberdeen to Torbay, so a single average
speed would be wrong at both ends. Every number returned is an ESTIMATE and is
labelled as such; nothing here calls a routing API.

Properties with no coordinates cannot be ordered geometrically. They are kept
in the response, flagged `routable: false`, and appended after the routed
stops rather than being silently dropped.

Schedule generation
-------------------
For each active property with frequency_weeks > 0, works out the next due date
(last job + frequency, or today for a property with no history) and creates a
'scheduled' job when one does not already exist. Idempotent: a second run the
same day creates nothing, which matters because this runs from cron.
"""
from __future__ import annotations

import json
import math
import os
import sqlite3
import threading
import time

from server import partner

MAXGLEAM_DB = os.environ.get("MAXGLEAM_DB", "/var/lib/maxgleam/app.db")

# Chester Window Cleaner — the live trading tenant. Override if that changes.
DEFAULT_TENANT_ID = int(os.environ.get("MAXGLEAM_TENANT_ID", "2"))

# ── Estimation model ────────────────────────────────────────────────
# Straight-line km × this ≈ road km. 1.3 is the usual UK rule of thumb.
ROAD_FACTOR = 1.3
# Average speed by leg length: town crawl, A-road, motorway.
SPEED_TIERS = ((5.0, 25.0), (30.0, 45.0), (float("inf"), 70.0))  # (max_km, km/h)
SERVICE_MINUTES = 20        # time on site per clean
DAY_START = "08:00"         # first stop's arrival time
EARTH_RADIUS_KM = 6371.0

_local = threading.local()


def _conn() -> sqlite3.Connection:
    """Thread-local maxgleam connection, shared with server.partner and
    server.maxgleam_portal so a request thread holds one, not three."""
    conn = partner._conn()
    if not getattr(_local, "schema_ready", False):
        _ensure_schema(conn)
        _local.schema_ready = True
    return conn


def _ensure_schema(conn: sqlite3.Connection) -> None:
    """Additive only — never alters a column maxgleam already owns."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS optimized_routes (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          date                TEXT NOT NULL,
          subcontractor_id    INTEGER REFERENCES subcontractors(id),
          route_json          TEXT NOT NULL,
          total_distance_km   REAL,
          total_drive_time_min INTEGER,
          created_at          INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )""")
    conn.execute("""CREATE INDEX IF NOT EXISTS idx_optimized_routes_date
                    ON optimized_routes(date, subcontractor_id)""")
    conn.commit()


def _rows(sql: str, args=()) -> list[dict]:
    return [dict(r) for r in _conn().execute(sql, args).fetchall()]


def _one(sql: str, args=()) -> dict | None:
    r = _conn().execute(sql, args).fetchone()
    return dict(r) if r else None


# ── Geometry ────────────────────────────────────────────────────────

def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in km."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def road_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    return haversine_km(lat1, lng1, lat2, lng2) * ROAD_FACTOR


def drive_minutes(km: float) -> int:
    """Minutes for a leg, using the speed tier its length falls into."""
    if km <= 0:
        return 0
    for max_km, kmh in SPEED_TIERS:
        if km <= max_km:
            return max(1, round(km / kmh * 60))
    return max(1, round(km / SPEED_TIERS[-1][1] * 60))


def _clock(minutes_from_start: int, day_start: str = DAY_START) -> str:
    try:
        h, m = (int(x) for x in day_start.split(":"))
    except (ValueError, AttributeError):
        h, m = 8, 0
    total = h * 60 + m + minutes_from_start
    return f"{(total // 60) % 24:02d}:{total % 60:02d}"


# ── Route optimisation ──────────────────────────────────────────────

_ROUTE_JOB_SELECT = """
  SELECT j.id AS job_id, j.scheduled_date, j.status, j.price_pence,
         j.subcontractor_id, j.notes,
         p.id AS property_id, p.address, p.postcode, p.latitude, p.longitude,
         p.access_notes, p.position, p.round_id, p.partner_company_id,
         c.name AS customer_name,
         s.name AS crew_name,
         r.name AS round_name
    FROM jobs j
    JOIN properties p ON p.id = j.property_id
    LEFT JOIN customers c ON c.id = p.customer_id
    LEFT JOIN subcontractors s ON s.id = j.subcontractor_id
    LEFT JOIN rounds r ON r.id = p.round_id
"""


def _jobs_for_route(date: str, crew_id: int | None,
                    partner_company_id: int | None,
                    statuses: tuple[str, ...] = ("scheduled", "done")) -> list[dict]:
    where = ["j.scheduled_date = ?"]
    args: list = [date]
    if crew_id is not None:
        # A job's crew is set on the job, or inherited from its round.
        where.append("(j.subcontractor_id = ? OR (j.subcontractor_id IS NULL "
                     "AND r.subcontractor_id = ?))")
        args += [crew_id, crew_id]
    if partner_company_id is not None:
        where.append("(j.partner_company_id = ? OR p.partner_company_id = ?)")
        args += [partner_company_id, partner_company_id]
    if statuses:
        where.append(f"j.status IN ({','.join('?' for _ in statuses)})")
        args += list(statuses)
    return _rows(f"{_ROUTE_JOB_SELECT} WHERE {' AND '.join(where)} "
                 "ORDER BY p.position ASC, p.address ASC", args)


MULTI_START_LIMIT = 60      # above this, one pass only — O(n³) stops being free


def _nearest_neighbour(stops: list[dict], start_lat: float | None,
                       start_lng: float | None) -> list[dict]:
    """Order stops by repeatedly hopping to the closest unvisited one.

    Greedy and not optimal, but O(n²), needs no external service, and beats
    the stored order comfortably on a real round.
    """
    remaining = list(stops)
    ordered: list[dict] = []
    cur_lat, cur_lng = start_lat, start_lng

    while remaining:
        if cur_lat is None or cur_lng is None:
            # No anchor yet: start from the property the round already puts
            # first, which is the office's own idea of where the day begins.
            nxt = remaining[0]
        else:
            nxt = min(remaining, key=lambda s: haversine_km(
                cur_lat, cur_lng, s["latitude"], s["longitude"]))
        remaining.remove(nxt)
        ordered.append(nxt)
        cur_lat, cur_lng = nxt["latitude"], nxt["longitude"]
    return ordered


def _path_km(stops: list[dict]) -> float:
    return sum(road_km(stops[i]["latitude"], stops[i]["longitude"],
                       stops[i + 1]["latitude"], stops[i + 1]["longitude"])
               for i in range(len(stops) - 1))


def _best_route(stops: list[dict], start_lat: float | None,
                start_lng: float | None) -> list[dict]:
    """Nearest-neighbour from a fixed start, or — when the crew has no depot —
    from every candidate first stop, keeping the shortest.

    Greedy NN is very sensitive to where it begins, and with no start point the
    fallback is whichever property happens to sort first, which is arbitrary.
    Trying each start costs O(n³) and these are single-day rounds, so it is
    cheap and removes the arbitrariness.
    """
    if not stops:
        return []
    if start_lat is not None and start_lng is not None:
        return _nearest_neighbour(stops, start_lat, start_lng)
    if len(stops) > MULTI_START_LIMIT:
        return _nearest_neighbour(stops, None, None)

    best, best_km = None, None
    for candidate in stops:
        route = _nearest_neighbour(stops, candidate["latitude"], candidate["longitude"])
        km = _path_km(route)
        if best_km is None or km < best_km:
            best, best_km = route, km
    return best or []


def optimize_route(date: str, crew_id: int | None = None,
                   partner_company_id: int | None = None,
                   start_lat: float | None = None, start_lng: float | None = None,
                   day_start: str = DAY_START, service_minutes: int = SERVICE_MINUTES,
                   persist: bool = True) -> dict:
    """Order one crew's jobs for one date into a nearest-neighbour route."""
    jobs = _jobs_for_route(date, crew_id, partner_company_id)

    routable = [j for j in jobs
                if j["latitude"] is not None and j["longitude"] is not None]
    unroutable = [j for j in jobs
                  if j["latitude"] is None or j["longitude"] is None]

    ordered = _best_route(routable, start_lat, start_lng)

    stops: list[dict] = []
    total_km = 0.0
    total_drive = 0
    elapsed = 0
    prev_lat, prev_lng = start_lat, start_lng

    for i, j in enumerate(ordered):
        if prev_lat is None or prev_lng is None:
            leg_km, leg_min = 0.0, 0
        else:
            leg_km = road_km(prev_lat, prev_lng, j["latitude"], j["longitude"])
            leg_min = drive_minutes(leg_km)
        total_km += leg_km
        total_drive += leg_min
        elapsed += leg_min
        arrival = _clock(elapsed, day_start)
        depart_min = elapsed + service_minutes

        stops.append({
            "position": i + 1,
            "job_id": j["job_id"],
            "property_id": j["property_id"],
            "address": j["address"],
            "postcode": j["postcode"],
            "lat": j["latitude"],
            "lng": j["longitude"],
            # Clock time the crew should arrive, assuming a `day_start` start.
            "estimated_time": arrival,
            "estimated_depart": _clock(depart_min, day_start),
            "drive_km_from_previous": round(leg_km, 2),
            "drive_minutes_from_previous": leg_min,
            "service_minutes": service_minutes,
            "customer_name": j["customer_name"],
            "crew_name": j["crew_name"],
            "round_name": j["round_name"],
            "access_notes": j["access_notes"],
            "status": j["status"],
            "price_pence": j["price_pence"] or 0,
            "routable": True,
        })
        elapsed = depart_min
        prev_lat, prev_lng = j["latitude"], j["longitude"]

    # Kept, not hidden — the office needs to know these need coordinates.
    for k, j in enumerate(unroutable):
        stops.append({
            "position": len(ordered) + k + 1,
            "job_id": j["job_id"],
            "property_id": j["property_id"],
            "address": j["address"],
            "postcode": j["postcode"],
            "lat": None, "lng": None,
            "estimated_time": None, "estimated_depart": None,
            "drive_km_from_previous": None,
            "drive_minutes_from_previous": None,
            "service_minutes": service_minutes,
            "customer_name": j["customer_name"],
            "crew_name": j["crew_name"],
            "round_name": j["round_name"],
            "access_notes": j["access_notes"],
            "status": j["status"],
            "price_pence": j["price_pence"] or 0,
            "routable": False,
        })

    total_service = len(stops) * service_minutes
    crew = _one("SELECT id, name FROM subcontractors WHERE id = ?",
                (crew_id,)) if crew_id else None

    result = {
        "date": date,
        "crew_id": crew_id,
        "crew_name": crew["name"] if crew else None,
        "stops": stops,
        "stop_count": len(stops),
        "routed_count": len(ordered),
        "unroutable_count": len(unroutable),
        "total_distance_km": round(total_km, 2),
        "total_drive_time_min": total_drive,
        "total_service_time_min": total_service,
        "total_day_minutes": total_drive + total_service,
        "finish_estimate": _clock(total_drive + total_service, day_start) if stops else None,
        "day_start": day_start,
        "value_pence": sum(s["price_pence"] for s in stops),
        "assumptions": {
            "algorithm": ("nearest-neighbour from the supplied start point"
                          if start_lat is not None else
                          "nearest-neighbour, best of every candidate start "
                          "(greedy, not guaranteed optimal)"),
            "distance": f"haversine × {ROAD_FACTOR} road factor — estimate, not a routed distance",
            "speed": "25 km/h under 5 km, 45 km/h under 30 km, 70 km/h beyond",
            "service_minutes": service_minutes,
            "start": ("supplied start point" if start_lat is not None
                      else "first job in the round's own order"),
        },
    }

    if persist and stops:
        save_route(result)
    return result


def save_route(route: dict) -> int:
    """Persist a computed route. One row per (date, crew) — recomputing
    replaces the previous plan rather than piling up near-duplicates."""
    conn = _conn()
    conn.execute("DELETE FROM optimized_routes WHERE date = ? AND "
                 "subcontractor_id IS ?", (route["date"], route["crew_id"]))
    cur = conn.execute(
        "INSERT INTO optimized_routes (date, subcontractor_id, route_json, "
        " total_distance_km, total_drive_time_min) VALUES (?, ?, ?, ?, ?)",
        (route["date"], route["crew_id"], json.dumps(route["stops"]),
         route["total_distance_km"], route["total_drive_time_min"]))
    conn.commit()
    return cur.lastrowid


def saved_routes(date: str | None = None, limit: int = 50) -> list[dict]:
    sql = ("SELECT o.*, s.name AS crew_name FROM optimized_routes o "
           "LEFT JOIN subcontractors s ON s.id = o.subcontractor_id")
    args: list = []
    if date:
        sql += " WHERE o.date = ?"
        args.append(date)
    sql += " ORDER BY o.created_at DESC LIMIT ?"
    args.append(limit)
    return _rows(sql, args)


def crews(tenant_id: int = DEFAULT_TENANT_ID) -> list[dict]:
    """Crews that can actually be dispatched — active subcontractors only."""
    return _rows("SELECT id, name, phone FROM subcontractors "
                 " WHERE tenant_id = ? AND active = 1 AND status = 'active' "
                 " ORDER BY name", (tenant_id,))


# ── Recurring schedule generation ───────────────────────────────────

def _today() -> str:
    return time.strftime("%Y-%m-%d")


def _add_days(date: str, days: int) -> str:
    t = time.mktime(time.strptime(date, "%Y-%m-%d"))
    # Add via localtime at noon so a DST boundary can't shift the date back.
    return time.strftime("%Y-%m-%d", time.localtime(t + days * 86400 + 43200))


def _days_between(a: str, b: str) -> int:
    ta = time.mktime(time.strptime(a, "%Y-%m-%d"))
    tb = time.mktime(time.strptime(b, "%Y-%m-%d"))
    return round((tb - ta) / 86400)


# Mon–Sat. Sunday is not a cleaning day for this business, so a computed
# Sunday rolls to the Monday rather than being booked and then missed.
WORKING_WEEKDAYS = (0, 1, 2, 3, 4, 5)


def _is_working_day(date: str) -> bool:
    return time.strptime(date, "%Y-%m-%d").tm_wday in WORKING_WEEKDAYS


def _next_working_day(date: str) -> str:
    for _ in range(7):
        if _is_working_day(date):
            return date
        date = _add_days(date, 1)
    return date


def _stagger_by_round(properties: list[dict], today: str,
                      busy_dates: set[str] | None = None) -> dict[int, str]:
    """First date for properties that have never been cleaned.

    Scheduling every never-cleaned property for today would put the whole
    estate — Aberdeen to Torbay — on one crew's single day. The rounds already
    encode how the work is split (they are literally named "DAY 1".."DAY 18"),
    so each round gets its own working day. Rounds that land past the horizon
    are simply not created yet; a later daily run picks them up.

    Days that already carry work are skipped. Without that, the second run of
    the day would re-pack the leftover rounds onto days the first run had
    already filled, double-booking the crew — and the run would stop being the
    no-op that a daily cron needs it to be.

    Returns {round_id: date}; round_id 0 means "no round".
    """
    busy = set(busy_dates or ())
    round_ids: list[int] = []
    for p in properties:
        rid = p["round_id"] or 0
        if rid not in round_ids:
            round_ids.append(rid)

    plan: dict[int, str] = {}
    day = _next_working_day(today)
    for rid in round_ids:
        while day in busy:
            day = _next_working_day(_add_days(day, 1))
        plan[rid] = day
        busy.add(day)
        day = _next_working_day(_add_days(day, 1))
    return plan


def generate_schedules(tenant_id: int = DEFAULT_TENANT_ID, horizon_days: int = 14,
                       dry_run: bool = False, today: str | None = None,
                       stagger: bool = True) -> dict:
    """Create 'scheduled' jobs for every property that is due.

    A property is due when its last job's date + frequency_weeks has arrived
    (or it has never been cleaned). Jobs are only created inside the horizon,
    so a cron run does not lay down months of speculative work.

    Properties with a job history keep their exact frequency date. Properties
    with none are spread a round per working day (see _stagger_by_round);
    pass stagger=False to schedule every one of them for today instead.

    Idempotent by design — it skips any property that already has an open
    scheduled job, and never writes a second job for the same property/date.
    """
    today = today or _today()
    horizon_end = _add_days(today, horizon_days)

    properties = _rows(
        "SELECT p.id, p.address, p.postcode, p.price_pence, p.frequency_weeks, "
        "       p.round_id, p.partner_company_id, p.tenant_id, "
        "       r.subcontractor_id AS round_crew "
        "  FROM properties p "
        "  LEFT JOIN rounds r ON r.id = p.round_id "
        " WHERE p.tenant_id = ? AND p.active = 1 AND p.frequency_weeks > 0 "
        " ORDER BY p.round_id, p.position, p.id", (tenant_id,))

    created, skipped, overdue = [], [], []
    conn = _conn()

    # Which properties have never been cleaned — they drive the stagger plan.
    never_cleaned = [p for p in properties
                     if not _one("SELECT 1 FROM jobs WHERE property_id = ? LIMIT 1",
                                 (p["id"],))]
    # Days that already carry work — a new round must not land on top of one.
    busy_dates = {r["scheduled_date"] for r in _rows(
        "SELECT DISTINCT scheduled_date FROM jobs "
        " WHERE tenant_id = ? AND scheduled_date >= ?", (tenant_id, today))}
    first_visit = (_stagger_by_round(never_cleaned, today, busy_dates)
                   if stagger else {})

    for p in properties:
        freq_days = p["frequency_weeks"] * 7

        # An open future job means this property is already covered.
        open_job = _one(
            "SELECT id, scheduled_date FROM jobs "
            " WHERE property_id = ? AND status = 'scheduled' AND scheduled_date >= ? "
            " ORDER BY scheduled_date LIMIT 1", (p["id"], today))
        if open_job:
            skipped.append({"property_id": p["id"], "address": p["address"],
                            "reason": "already scheduled",
                            "scheduled_date": open_job["scheduled_date"]})
            continue

        last = _one(
            "SELECT scheduled_date, status, completed_at FROM jobs "
            " WHERE property_id = ? ORDER BY scheduled_date DESC LIMIT 1", (p["id"],))

        if last:
            due = _add_days(last["scheduled_date"], freq_days)
            days_since = _days_between(last["scheduled_date"], today)
            if days_since > freq_days:
                overdue.append({
                    "property_id": p["id"], "address": p["address"],
                    "postcode": p["postcode"],
                    "last_job_date": last["scheduled_date"],
                    "days_since": days_since,
                    "frequency_weeks": p["frequency_weeks"],
                    "days_overdue": days_since - freq_days,
                })
        else:
            # Never cleaned in the system — due now. Staggered by round so the
            # whole estate doesn't land on a single crew-day.
            due = first_visit.get(p["round_id"] or 0, today)

        # Overdue work is scheduled for today, not for a date already gone.
        if due < today:
            due = today
        due = _next_working_day(due)

        if due > horizon_end:
            skipped.append({"property_id": p["id"], "address": p["address"],
                            "reason": "not due yet", "next_due": due})
            continue

        # Belt and braces: never two jobs for the same property on one day.
        clash = _one("SELECT id FROM jobs WHERE property_id = ? AND scheduled_date = ?",
                     (p["id"], due))
        if clash:
            skipped.append({"property_id": p["id"], "address": p["address"],
                            "reason": "job already exists for that date",
                            "scheduled_date": due})
            continue

        entry = {
            "property_id": p["id"], "address": p["address"],
            "postcode": p["postcode"], "scheduled_date": due,
            "price_pence": p["price_pence"], "crew_id": p["round_crew"],
            "last_job_date": last["scheduled_date"] if last else None,
        }
        if not dry_run:
            cur = conn.execute(
                "INSERT INTO jobs (tenant_id, property_id, scheduled_date, status, "
                " price_pence, subcontractor_id, partner_company_id, notes) "
                "VALUES (?, ?, ?, 'scheduled', ?, ?, ?, ?)",
                (p["tenant_id"], p["id"], due, p["price_pence"], p["round_crew"],
                 p["partner_company_id"],
                 f"Auto-scheduled ({p['frequency_weeks']}-weekly)"))
            entry["job_id"] = cur.lastrowid
        created.append(entry)

    if not dry_run:
        conn.commit()

    return {
        "today": today,
        "tenant_id": tenant_id,
        "horizon_days": horizon_days,
        "horizon_end": horizon_end,
        "dry_run": dry_run,
        "properties_considered": len(properties),
        "created": created,
        "created_count": len(created),
        "skipped_count": len(skipped),
        "skipped": skipped[:100],
        "overdue": overdue,
        "overdue_count": len(overdue),
    }


def overdue_properties(tenant_id: int = DEFAULT_TENANT_ID,
                       today: str | None = None) -> list[dict]:
    """Properties whose last completed clean is older than their frequency."""
    today = today or _today()
    out = []
    for p in _rows(
        "SELECT p.id, p.address, p.postcode, p.frequency_weeks "
        "  FROM properties p "
        " WHERE p.tenant_id = ? AND p.active = 1 AND p.frequency_weeks > 0",
            (tenant_id,)):
        last = _one(
            "SELECT scheduled_date FROM jobs WHERE property_id = ? AND status = 'done' "
            " ORDER BY scheduled_date DESC LIMIT 1", (p["id"],))
        if not last:
            continue
        days_since = _days_between(last["scheduled_date"], today)
        freq_days = p["frequency_weeks"] * 7
        if days_since > freq_days:
            out.append({**p, "last_completed": last["scheduled_date"],
                        "days_since": days_since,
                        "days_overdue": days_since - freq_days})
    out.sort(key=lambda r: r["days_overdue"], reverse=True)
    return out


# ── Communications log ──────────────────────────────────────────────
# Everything the business has said to a customer — night-before texts,
# invoices, reminders, sign-off confirmations and the crew app's own
# entries — in one filterable timeline.

COMMS_LIMIT = 500

# comms_log.kind is free text written by several senders. Group the values
# actually in use into the three channels an operator thinks in.
COMMS_CHANNELS = {
    "sms": ("night_before", "reminder", "signoff_link", "sms"),
    "email": ("invoice_sent", "email", "receipt"),
    "call": ("call", "voicemail"),
}


def comms_channel(kind: str) -> str:
    for channel, kinds in COMMS_CHANNELS.items():
        if kind in kinds:
            return channel
    return "note"


def comms_log(tenant_id: int = DEFAULT_TENANT_ID, customer_id: int | None = None,
              kind: str | None = None, channel: str | None = None,
              start: str | None = None, end: str | None = None,
              query: str | None = None, limit: int = COMMS_LIMIT) -> tuple[int, dict]:
    """GET /api/maxgleam/comms — the timeline, plus the values to filter on."""
    where = ["cl.tenant_id = ?"]
    args: list = [tenant_id]
    if customer_id:
        where.append("cl.customer_id = ?")
        args.append(customer_id)
    if kind:
        where.append("cl.kind = ?")
        args.append(kind)
    if start:
        # Dates arrive as YYYY-MM-DD; compare against the stored unix seconds.
        where.append("cl.created_at >= strftime('%s', ? || ' 00:00:00')")
        args.append(start)
    if end:
        where.append("cl.created_at <= strftime('%s', ? || ' 23:59:59')")
        args.append(end)
    if query:
        where.append("(cl.content LIKE ? OR c.name LIKE ?)")
        args += [f"%{query}%", f"%{query}%"]

    limit = max(1, min(int(limit or COMMS_LIMIT), COMMS_LIMIT))
    rows = _rows(
        "SELECT cl.id, cl.customer_id, cl.kind, cl.content, cl.created_at, "
        "       c.name AS customer_name, c.email AS customer_email, "
        "       c.phone AS customer_phone "
        "  FROM comms_log cl "
        "  LEFT JOIN customers c ON c.id = cl.customer_id "
        " WHERE " + " AND ".join(where) +
        " ORDER BY cl.created_at DESC, cl.id DESC LIMIT ?", tuple(args) + (limit,))

    entries = [{**r, "channel": comms_channel(r["kind"])} for r in rows]
    if channel:
        entries = [e for e in entries if e["channel"] == channel]

    return 200, {
        "entries": entries,
        "kinds": [r["kind"] for r in _rows(
            "SELECT DISTINCT kind FROM comms_log WHERE tenant_id = ? ORDER BY kind",
            (tenant_id,))],
        "customers": _rows(
            "SELECT DISTINCT c.id, c.name FROM comms_log cl "
            "  JOIN customers c ON c.id = cl.customer_id "
            " WHERE cl.tenant_id = ? ORDER BY c.name", (tenant_id,)),
        "channels": ["sms", "email", "call", "note"],
        "summary": {"count": len(entries), "limit": limit},
    }
