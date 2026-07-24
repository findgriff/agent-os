"""KS Sports Coaching — attendance register.

A coach marks each booked child attended, absent or cancelled after the
session. The mark is the billing signal as much as the record:

  attended   — session ran, normal price applies
  absent     — no-show without notice, charged in full and the parent is
               texted so the charge is never a surprise on the invoice
  cancelled  — called off with notice, excused, not charged

The 24-hour cancellation cutoff in ks.py is the parent-facing route to an
excused absence; this is the coach-facing one, for the calls and texts that
come in outside the booking system.

Marks live in a UNIQUE (booking_id, child_name) index, so a coach who taps
the wrong button corrects the record rather than duplicating it — but the
absent-charge SMS is still only ever sent once, because sms_log carries its
own UNIQUE (booking_id, kind).
"""
from __future__ import annotations
import logging
import time

from server import ks

log = logging.getLogger("agentos.ks_attendance")

STATUSES = ("attended", "absent", "cancelled")

# Which marks a parent is charged for. Kept as data rather than an `if` so
# the billing summary and the register can never disagree.
CHARGEABLE = {"attended": True, "absent": True, "cancelled": False}


def _booking(ref_or_id) -> dict | None:
    """Look a session up by booking ref (KS-XXXXXX) or numeric id."""
    if isinstance(ref_or_id, int) or (isinstance(ref_or_id, str) and ref_or_id.isdigit()):
        return ks._one("SELECT b.*, c.name AS coach_name FROM bookings b "
                       "JOIN coaches c ON c.id = b.coach_id WHERE b.id = ?", (int(ref_or_id),))
    return ks._one("SELECT b.*, c.name AS coach_name FROM bookings b "
                   "JOIN coaches c ON c.id = b.coach_id WHERE b.ref = ?",
                   ((ref_or_id or "").strip().upper(),))


def _dto(row: dict) -> dict:
    return {
        "id": row["id"],
        "booking_id": row["booking_id"],
        "child_name": row["child_name"],
        "status": row["status"],
        "notes": row["notes"],
        "marked_by": row["marked_by"],
        "created_at": row["created_at"],
        "chargeable": CHARGEABLE.get(row["status"], False),
        # Joined columns are only present on the history/summary queries.
        "date": row.get("date"),
        "start_time": row.get("start_time"),
        "service_name": row.get("service_name"),
        "coach_name": row.get("coach_name"),
        "ref": row.get("ref"),
        "price_pence": row.get("price_pence"),
    }


# ------------------------------------------------------------------ mark ---

def mark(coach: dict, body: dict) -> tuple[int, dict]:
    """Record one child's attendance for one session."""
    booking = _booking(body.get("ref") or body.get("booking_id") or "")
    if not booking:
        return 404, {"error": "session not found"}
    if booking["coach_id"] != coach["id"]:
        return 403, {"error": "that session belongs to another coach"}

    status = (body.get("status") or "").strip().lower()
    if status not in STATUSES:
        return 400, {"error": f"status must be one of {', '.join(STATUSES)}"}

    # The register is for sessions that have started. Marking a child absent
    # from a session that has not run yet would charge them for it.
    if booking["starts_at"] > int(time.time()):
        return 400, {"error": "that session hasn't started yet"}

    child_name = (body.get("child_name") or booking["child_name"] or "").strip()
    if not child_name:
        return 400, {"error": "which player?"}

    notes = (body.get("notes") or "").strip() or None
    conn = ks._conn()
    conn.execute(
        "INSERT INTO attendance (booking_id, child_name, status, notes, marked_by) "
        "VALUES (?,?,?,?,?) "
        "ON CONFLICT(booking_id, child_name) DO UPDATE SET "
        "  status = excluded.status, notes = excluded.notes, "
        "  marked_by = excluded.marked_by, created_at = strftime('%s','now')",
        (booking["id"], child_name, status, notes, coach["name"]))

    # An attended session is a completed session — keep the booking status in
    # step so the coach never has to mark the same thing twice.
    if status == "attended" and booking["status"] == "confirmed":
        conn.execute("UPDATE bookings SET status = 'completed', completed_at = ? WHERE id = ?",
                     (int(time.time()), booking["id"]))
    conn.commit()

    sms = None
    if status == "absent":
        # A no-show charge the parent is never told about is the one thing
        # this must not do, so fall back to the number on their account when
        # the booking itself carries none (guest checkouts often don't).
        if not (booking.get("parent_phone") or "").strip():
            account = ks.parent_by_email(booking["parent_email"])
            if account:
                booking = {**booking, "parent_phone": account.get("phone")}
        sms = ks.notify(booking, "absent_charge")

    row = ks._one(_HISTORY_SQL + "WHERE a.booking_id = ? AND a.child_name = ?",
                  (booking["id"], child_name))
    return 200, {"attendance": _dto(row), "sms": sms,
                 "charged_pence": booking["price_pence"] if CHARGEABLE.get(status) else 0}


# --------------------------------------------------------------- history ---

_HISTORY_SQL = (
    "SELECT a.*, b.ref, b.date, b.start_time, b.service_name, b.price_pence, "
    "       b.parent_email, c.name AS coach_name "
    "  FROM attendance a "
    "  JOIN bookings b ON b.id = a.booking_id "
    "  JOIN coaches c ON c.id = b.coach_id ")


def history(child: str, parent: dict | None = None,
            coach: dict | None = None) -> tuple[int, dict]:
    """Every mark for one child, newest first.

    A signed-in parent only ever sees their own child. A coach sees any
    child they have coached — the register is theirs to correct.
    """
    child = (child or "").strip()
    if not child:
        return 400, {"error": "child required"}
    if not parent and not coach:
        return 401, {"error": "sign in required"}

    where, args = "WHERE a.child_name = ? ", [child]
    if parent:
        where += "AND lower(b.parent_email) = ? "
        args.append(parent["email"].lower())
    elif coach:
        where += "AND b.coach_id = ? "
        args.append(coach["id"])

    rows = ks._rows(_HISTORY_SQL + where + "ORDER BY b.starts_at DESC LIMIT 200", args)
    marks = [_dto(r) for r in rows]
    return 200, {"child_name": child, "attendance": marks, "totals": _totals(marks)}


def _totals(marks: list[dict]) -> dict:
    attended = sum(1 for m in marks if m["status"] == "attended")
    absent = sum(1 for m in marks if m["status"] == "absent")
    cancelled = sum(1 for m in marks if m["status"] == "cancelled")
    # Rate is attended out of sessions the child was expected at. Sessions
    # cancelled with notice were never expected, so counting them would
    # punish a parent for doing the right thing.
    expected = attended + absent
    return {
        "attended": attended, "absent": absent, "cancelled": cancelled,
        "sessions": len(marks),
        "rate": round(attended / expected * 100) if expected else None,
        "charged_pence": sum(m["price_pence"] or 0 for m in marks
                             if CHARGEABLE.get(m["status"])),
    }


def summary(parent: dict | None = None, coach: dict | None = None) -> tuple[int, dict]:
    """Attendance rate per child — a parent's children, or a coach's roster."""
    if not parent and not coach:
        return 401, {"error": "sign in required"}
    where, args = "WHERE 1=1 ", []
    if parent:
        where += "AND lower(b.parent_email) = ? "
        args.append(parent["email"].lower())
    elif coach:
        where += "AND b.coach_id = ? "
        args.append(coach["id"])

    rows = ks._rows(_HISTORY_SQL + where + "ORDER BY b.starts_at DESC LIMIT 1000", args)
    by_child: dict[str, list[dict]] = {}
    for r in rows:
        by_child.setdefault(r["child_name"], []).append(_dto(r))

    children = [{"child_name": name, "last_seen": marks[0]["date"], **_totals(marks)}
                for name, marks in by_child.items()]
    # Worst attendance first — this list exists to surface the problem cases.
    children.sort(key=lambda c: (c["rate"] if c["rate"] is not None else 101, -c["sessions"]))
    return 200, {"children": children}


def unmarked(coach: dict) -> tuple[int, dict]:
    """The coach's sessions that have run but carry no mark yet."""
    rows = ks._rows(
        "SELECT b.*, c.name AS coach_name FROM bookings b "
        "  JOIN coaches c ON c.id = b.coach_id "
        " WHERE b.coach_id = ? AND b.status != 'cancelled' AND b.starts_at <= ? "
        "   AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.booking_id = b.id) "
        " ORDER BY b.starts_at DESC LIMIT 50", (coach["id"], int(time.time())))
    return 200, {"sessions": [ks._booking_dto(b) for b in rows]}
