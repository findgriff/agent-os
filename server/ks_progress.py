"""KS Sports Coaching — per-child progress notes.

After a session the coach records what was worked on, how it went, and a
1-5 rating. Parents read the same notes back as a timeline in their portal,
which is what knowledge.json already promises them for 1-to-1 coaching:
"Progress notes shared after each block."

Because the notes are parent-facing the moment they are saved, there is no
private-draft state here — a coach writing a note is publishing it.

Skills are stored as a JSON array of keys from SKILLS. Keeping them keyed
rather than free text is what makes the "skills worked on" rollup possible;
the free-text half of the note lives in `notes`.
"""
from __future__ import annotations
import json
import logging

from server import ks

log = logging.getLogger("agentos.ks_progress")

# The coaching vocabulary offered in the UI. Free-text skills are rejected
# rather than silently stored, so the rollup can't fragment into
# "shooting" / "Shooting" / "shooting drills".
SKILLS = [
    {"key": "dribbling",   "label": "Dribbling"},
    {"key": "passing",     "label": "Passing"},
    {"key": "shooting",    "label": "Shooting"},
    {"key": "first-touch", "label": "First touch"},
    {"key": "defending",   "label": "Defending"},
    {"key": "positioning", "label": "Positioning"},
    {"key": "teamwork",    "label": "Teamwork"},
    {"key": "communication", "label": "Communication"},
    {"key": "fitness",     "label": "Fitness"},
    {"key": "confidence",  "label": "Confidence"},
]
SKILL_KEYS = {s["key"] for s in SKILLS}
SKILL_LABELS = {s["key"]: s["label"] for s in SKILLS}

RATING_LABELS = {
    1: "Tough session",
    2: "Working at it",
    3: "Solid session",
    4: "Really strong",
    5: "Outstanding",
}


def _dto(row: dict) -> dict:
    try:
        keys = json.loads(row["skills"] or "[]")
    except (json.JSONDecodeError, TypeError):
        keys = []
    return {
        "id": row["id"],
        "booking_id": row["booking_id"],
        "child_name": row["child_name"],
        "coach_name": row["coach_name"],
        "skills": keys,
        "skill_labels": [SKILL_LABELS.get(k, k) for k in keys],
        "notes": row["notes"],
        "rating": row["rating"],
        "rating_label": RATING_LABELS.get(row["rating"] or 0),
        "created_at": row["created_at"],
        "date": row.get("date"),
        "start_time": row.get("start_time"),
        "service_name": row.get("service_name"),
        "ref": row.get("ref"),
    }


# ------------------------------------------------------------------ save ---

def save(coach: dict, body: dict) -> tuple[int, dict]:
    """Write (or correct) the progress note for one child on one session."""
    ref = (body.get("ref") or "").strip().upper()
    booking_id = body.get("booking_id")
    if ref:
        booking = ks._one("SELECT * FROM bookings WHERE ref = ?", (ref,))
    elif booking_id:
        booking = ks._one("SELECT * FROM bookings WHERE id = ?", (int(booking_id),))
    else:
        return 400, {"error": "which session?"}
    if not booking:
        return 404, {"error": "session not found"}
    if booking["coach_id"] != coach["id"]:
        return 403, {"error": "that session belongs to another coach"}

    raw_skills = body.get("skills") or []
    if isinstance(raw_skills, str):
        raw_skills = [s.strip() for s in raw_skills.split(",") if s.strip()]
    skills = [s for s in dict.fromkeys(raw_skills) if s in SKILL_KEYS]
    unknown = [s for s in raw_skills if s not in SKILL_KEYS]
    if unknown:
        return 400, {"error": f"unknown skill: {', '.join(map(str, unknown[:3]))}"}

    rating = body.get("rating")
    try:
        rating = int(rating) if rating not in (None, "") else None
    except (TypeError, ValueError):
        return 400, {"error": "rating must be a number"}
    if rating is not None and not 1 <= rating <= 5:
        return 400, {"error": "rating must be between 1 and 5"}

    notes = (body.get("notes") or "").strip()
    if not notes and not skills and rating is None:
        return 400, {"error": "add a note, a skill or a rating"}

    child_name = (body.get("child_name") or booking["child_name"] or "").strip()
    if not child_name:
        return 400, {"error": "which player?"}

    conn = ks._conn()
    conn.execute(
        "INSERT INTO progress_notes (booking_id, child_name, coach_name, skills, notes, rating) "
        "VALUES (?,?,?,?,?,?) "
        "ON CONFLICT(booking_id, child_name) DO UPDATE SET "
        "  coach_name = excluded.coach_name, skills = excluded.skills, "
        "  notes = excluded.notes, rating = excluded.rating, "
        "  created_at = strftime('%s','now')",
        (booking["id"], child_name, coach["name"], json.dumps(skills), notes or None, rating))
    conn.commit()

    row = ks._one("SELECT * FROM progress_notes WHERE booking_id = ? AND child_name = ?",
                  (booking["id"], child_name))
    return 200, {"note": _dto(row)}


# --------------------------------------------------------------- timeline ---

_SQL = ("SELECT p.*, b.ref, b.date, b.start_time, b.service_name, b.parent_email "
        "  FROM progress_notes p "
        "  JOIN bookings b ON b.id = p.booking_id ")


def history(child: str, parent: dict | None = None,
            coach: dict | None = None) -> tuple[int, dict]:
    """A child's progress timeline, newest first, plus a skills rollup."""
    child = (child or "").strip()
    if not child:
        return 400, {"error": "child required"}
    if not parent and not coach:
        return 401, {"error": "sign in required"}

    where, args = "WHERE p.child_name = ? ", [child]
    if parent:
        where += "AND lower(b.parent_email) = ? "
        args.append(parent["email"].lower())
    elif coach:
        where += "AND b.coach_id = ? "
        args.append(coach["id"])

    rows = ks._rows(_SQL + where + "ORDER BY b.starts_at DESC LIMIT 200", args)
    notes = [_dto(r) for r in rows]

    counts: dict[str, int] = {}
    for n in notes:
        for k in n["skills"]:
            counts[k] = counts.get(k, 0) + 1
    worked_on = sorted(
        ({"key": k, "label": SKILL_LABELS.get(k, k), "sessions": c} for k, c in counts.items()),
        key=lambda s: -s["sessions"])

    rated = [n["rating"] for n in notes if n["rating"]]
    return 200, {
        "child_name": child,
        "notes": notes,
        "skills_worked_on": worked_on,
        "summary": {
            "sessions": len(notes),
            "average_rating": round(sum(rated) / len(rated), 1) if rated else None,
            # Oldest-first slice of the last six ratings, so the portal can
            # draw the trend line in the direction time actually runs.
            "recent_ratings": [n["rating"] for n in reversed(notes[:6]) if n["rating"]],
            "latest": notes[0]["date"] if notes else None,
        },
    }


def children_for_parent(parent: dict) -> list[str]:
    """Names a parent may ask about: registered children plus anyone booked.

    Guest bookings and siblings added at the booking form never make it into
    the `children` table, so registered children alone would hide half the
    family's history.
    """
    names = {c["name"] for c in ks._rows(
        "SELECT name FROM children WHERE parent_id = ?", (parent["id"],))}
    names |= {b["child_name"] for b in ks._rows(
        "SELECT DISTINCT child_name FROM bookings WHERE lower(parent_email) = ?",
        (parent["email"].lower(),))}
    return sorted(n for n in names if n)


def skills_catalogue() -> tuple[int, dict]:
    return 200, {"skills": SKILLS, "ratings": RATING_LABELS}
