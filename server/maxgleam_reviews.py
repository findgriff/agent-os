"""Max Gleam client reviews and ratings.

Reads and writes the maxgleam database (/var/lib/maxgleam/app.db).

Where a rating lives
--------------------
Historically the star rating was encoded in jobs.signoff_note as a leading
`[n/5]` tag, because the jobs table belongs to another running application and
adding a column underneath it was not worth the risk (see maxgleam_portal).

This module adds jobs.rating INTEGER — additive, nullable, invisible to any
`INSERT INTO jobs (...)` the other app runs — and backfills it from the existing
tags. The sign-off flow now writes BOTH: the column for everything here, and the
`[n/5]` tag so the other application's own parsing keeps working. Reads fall
back to the tag, so a rating written by the other app is never lost.
"""
from __future__ import annotations

import re
import sqlite3
import threading
import time

from server import partner
from server.maxgleam_ops import DEFAULT_TENANT_ID

_local = threading.local()

# A review is only shown as a testimonial at or above this rating.
TESTIMONIAL_MIN = 4


def _conn() -> sqlite3.Connection:
    conn = partner._conn()
    if not getattr(_local, "reviews_schema_ready", False):
        _ensure_schema(conn)
        _local.reviews_schema_ready = True
    return conn


def _ensure_schema(conn: sqlite3.Connection) -> None:
    """Add jobs.rating if absent, then backfill it from the [n/5] tags."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(jobs)")}
    if "rating" not in cols:
        try:
            conn.execute("ALTER TABLE jobs ADD COLUMN rating INTEGER")
        except sqlite3.OperationalError:
            return          # lost a race with another worker; it exists now
        conn.commit()
        backfill_ratings(conn)
    conn.execute("""CREATE INDEX IF NOT EXISTS idx_jobs_rating
                    ON jobs(tenant_id, rating)""")
    conn.commit()


def backfill_ratings(conn: sqlite3.Connection | None = None) -> int:
    """Copy every `[n/5]` tag in signoff_note into jobs.rating. Idempotent."""
    conn = conn or _conn()
    n = 0
    for row in conn.execute(
            "SELECT id, signoff_note FROM jobs"
            " WHERE rating IS NULL AND signoff_note IS NOT NULL").fetchall():
        m = re.match(r"^\[(\d)/5\]", (row[1] or "").strip())
        if not m:
            continue
        stars = int(m.group(1))
        if 1 <= stars <= 5:
            conn.execute("UPDATE jobs SET rating = ? WHERE id = ?", (stars, row[0]))
            n += 1
    conn.commit()
    return n


def _rows(sql: str, args=()) -> list[dict]:
    cur = _conn().execute(sql, args)
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def _one(sql: str, args=()) -> dict | None:
    got = _rows(sql, args)
    return got[0] if got else None


def _rating_of(note: str | None) -> int | None:
    m = re.match(r"^\[(\d)/5\]", (note or "").strip())
    return int(m.group(1)) if m else None


def _note_body(note: str | None) -> str:
    return re.sub(r"^\[\d/5\]\s*", "", (note or "").strip())


def set_rating(job_id: int, stars: int | None) -> None:
    """Mirror a sign-off rating into the column. Never raises — a failure here
    must not fail the customer's sign-off, and the [n/5] tag remains the
    fallback source of truth."""
    if stars is not None and not 1 <= stars <= 5:
        return
    try:
        conn = _conn()
        conn.execute("UPDATE jobs SET rating = ? WHERE id = ?", (stars, job_id))
        conn.commit()
    except sqlite3.Error:
        pass


# ── reads ───────────────────────────────────────────────────────────────

_REVIEW_SELECT = """
    SELECT j.id AS job_id, j.rating, j.signoff_note, j.signoff_status,
           j.signoff_at, j.completed_at, j.scheduled_date, j.price_pence,
           p.address, p.postcode, c.name AS customer_name,
           s.name AS crew_name, s.id AS crew_id
      FROM jobs j
      JOIN properties p ON p.id = j.property_id
      LEFT JOIN customers c ON c.id = p.customer_id
      LEFT JOIN subcontractors s ON s.id = j.subcontractor_id
"""


def _dto(r: dict) -> dict:
    stars = r["rating"] if r["rating"] is not None else _rating_of(r["signoff_note"])
    return {
        "job_id": r["job_id"],
        "rating": stars,
        "comment": _note_body(r["signoff_note"]),
        "customer_name": r["customer_name"],
        "address": r["address"],
        "postcode": r["postcode"],
        "crew_name": r["crew_name"],
        "crew_id": r["crew_id"],
        "signoff_status": r["signoff_status"],
        "signed_at": r["signoff_at"] or r["completed_at"],
        "scheduled_date": r["scheduled_date"],
        "price_pence": r["price_pence"] or 0,
        "is_testimonial": bool(stars and stars >= TESTIMONIAL_MIN
                               and _note_body(r["signoff_note"])),
    }


def _scoped(tenant_id: int, company_id: int | None) -> tuple[str, list]:
    where = " WHERE j.tenant_id = ?"
    args: list = [tenant_id]
    if company_id is not None:
        where += " AND (j.partner_company_id = ? OR p.partner_company_id = ?)"
        args += [company_id, company_id]
    return where, args


def reviews(tenant_id: int = DEFAULT_TENANT_ID, company_id: int | None = None, *,
            min_rating: int | None = None, crew_id: int | None = None,
            with_comment: bool = False, limit: int = 100) -> tuple[int, dict]:
    """Rated jobs, newest first, plus the distribution and testimonials."""
    where, args = _scoped(tenant_id, company_id)
    # A rating exists in the column OR still only as a [n/5] tag.
    where += (" AND (j.rating IS NOT NULL"
              " OR j.signoff_note LIKE '[_/5]%')")
    if crew_id:
        where += " AND j.subcontractor_id = ?"
        args.append(crew_id)

    rows = [_dto(r) for r in _rows(
        _REVIEW_SELECT + where
        + " ORDER BY COALESCE(j.signoff_at, j.completed_at, 0) DESC, j.id DESC"
        + " LIMIT ?", tuple(args + [max(1, min(500, limit))]))]

    if min_rating:
        rows = [r for r in rows if (r["rating"] or 0) >= min_rating]
    if with_comment:
        rows = [r for r in rows if r["comment"]]

    stars = [r["rating"] for r in rows if r["rating"]]
    distribution = {n: sum(1 for s in stars if s == n) for n in range(1, 6)}

    return 200, {
        "reviews": rows,
        "count": len(rows),
        "average": round(sum(stars) / len(stars), 2) if stars else None,
        "rated": len(stars),
        "distribution": distribution,
        "testimonials": [r for r in rows if r["is_testimonial"]][:20],
        "testimonial_min": TESTIMONIAL_MIN,
    }


def average(tenant_id: int = DEFAULT_TENANT_ID, company_id: int | None = None,
            days: int | None = None) -> tuple[int, dict]:
    """Average rating, the star distribution, and a per-crew breakdown."""
    where, args = _scoped(tenant_id, company_id)
    where += (" AND (j.rating IS NOT NULL OR j.signoff_note LIKE '[_/5]%')")
    if days:
        cutoff = int(time.time()) - max(1, days) * 86400
        where += " AND COALESCE(j.signoff_at, j.completed_at, 0) >= ?"
        args.append(cutoff)

    rows = [_dto(r) for r in _rows(_REVIEW_SELECT + where + " LIMIT 5000", tuple(args))]
    stars = [r["rating"] for r in rows if r["rating"]]

    by_crew: dict[int, dict] = {}
    for r in rows:
        if not r["crew_id"] or not r["rating"]:
            continue
        entry = by_crew.setdefault(r["crew_id"], {
            "crew_id": r["crew_id"], "name": r["crew_name"] or f'Crew #{r["crew_id"]}',
            "_stars": [],
        })
        entry["_stars"].append(r["rating"])
    crew = []
    for e in by_crew.values():
        s = e.pop("_stars")
        crew.append({**e, "rated": len(s), "average": round(sum(s) / len(s), 2)})
    crew.sort(key=lambda c: (c["average"], c["rated"]), reverse=True)

    # How many completed jobs never got a rating at all — the honest
    # denominator behind an average built on a handful of responses.
    total_done = _one("SELECT COUNT(*) AS n FROM jobs j"
                      " JOIN properties p ON p.id = j.property_id"
                      + _scoped(tenant_id, company_id)[0] + " AND j.status = 'done'",
                      tuple(_scoped(tenant_id, company_id)[1])) or {}

    done = total_done.get("n") or 0
    return 200, {
        "average": round(sum(stars) / len(stars), 2) if stars else None,
        "rated": len(stars),
        "completed_jobs": done,
        "response_rate_pct": round(100.0 * len(stars) / done, 1) if done else 0.0,
        "distribution": {n: sum(1 for s in stars if s == n) for n in range(1, 6)},
        "by_crew": crew,
        "window_days": days,
    }
