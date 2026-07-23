"""KS Sports Coaching — public booking system.

Self-contained: its own SQLite database at /var/lib/ks-bot/bookings.db, its
own parent/coach sessions, and its own view of the business built from
/opt/ks-bot/knowledge.json (the same file the KS chatbot answers from, so
services, prices and FAQ never drift between the bot and the website).

Nothing here touches the AGENT OS database or session table — the KS site is
public, and a KS parent must never hold a token that means anything to HQ.

SMS goes out through ClickSend using the shared Max Gleam credentials
(/etc/maxgleam/*). Set KS_SMS_DRY_RUN=1 to log messages instead of sending.
"""
from __future__ import annotations
import base64
import json
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from server import auth

log = logging.getLogger("agentos.ks")

DB_PATH = os.environ.get("KS_DB", "/var/lib/ks-bot/bookings.db")
KNOWLEDGE_PATH = os.environ.get("KS_KNOWLEDGE", "/opt/ks-bot/knowledge.json")
CREDS_PATH = os.environ.get("KS_COACH_CREDS", "/var/lib/ks-bot/coach-credentials.txt")

# Sessions are booked and displayed in UK local time regardless of server TZ.
UK = ZoneInfo("Europe/London")

# ClickSend — shared with maxgleam (same account, same sender number).
CLICKSEND_USER_PATH = os.environ.get("KS_CLICKSEND_USER_PATH", "/etc/maxgleam/clicksend-username")
CLICKSEND_KEY_PATH = os.environ.get("KS_CLICKSEND_KEY_PATH", "/etc/maxgleam/clicksend-api-key")
CLICKSEND_FROM = os.environ.get("KS_CLICKSEND_FROM", "+447454128780")
SMS_DRY_RUN = os.environ.get("KS_SMS_DRY_RUN", "") == "1"

SESSION_TTL = 30 * 24 * 3600
CANCEL_CUTOFF_HOURS = 24        # free cancellation up to 24h before kick-off
BOOKING_HORIZON_DAYS = 60       # how far ahead the date picker runs

SCHEMA = """
CREATE TABLE IF NOT EXISTS parents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT,
  password_hash TEXT,
  sms_opt_out   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS children (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id  INTEGER NOT NULL REFERENCES parents(id),
  name       TEXT NOT NULL,
  age        INTEGER,
  school     TEXT,
  experience TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS coaches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  email         TEXT,
  bio           TEXT,
  password_hash TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS bookings (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ref              TEXT NOT NULL UNIQUE,
  parent_id        INTEGER REFERENCES parents(id),
  coach_id         INTEGER NOT NULL REFERENCES coaches(id),
  service_key      TEXT NOT NULL,
  service_name     TEXT NOT NULL,
  date             TEXT NOT NULL,          -- YYYY-MM-DD (UK local)
  start_time       TEXT NOT NULL,          -- HH:MM   (UK local)
  end_time         TEXT NOT NULL,
  starts_at        INTEGER NOT NULL,       -- epoch, for reminders
  child_name       TEXT NOT NULL,
  child_age        INTEGER,
  child_school     TEXT,
  child_experience TEXT,
  parent_name      TEXT NOT NULL,
  parent_email     TEXT NOT NULL,
  parent_phone     TEXT,
  notes            TEXT,
  price_pence      INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'confirmed',  -- confirmed|completed|cancelled
  created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  completed_at     INTEGER,
  cancelled_at     INTEGER,
  coach_notes      TEXT
);
CREATE INDEX IF NOT EXISTS idx_bookings_slot ON bookings(coach_id, date, start_time);
CREATE INDEX IF NOT EXISTS idx_bookings_parent ON bookings(parent_email, starts_at);
CREATE INDEX IF NOT EXISTS idx_bookings_starts ON bookings(starts_at, status);

CREATE TABLE IF NOT EXISTS availability (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  coach_id   INTEGER NOT NULL REFERENCES coaches(id),
  date       TEXT NOT NULL,
  start_time TEXT NOT NULL DEFAULT '00:00',
  end_time   TEXT NOT NULL DEFAULT '23:59',
  reason     TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_availability_coach ON availability(coach_id, date);

CREATE TABLE IF NOT EXISTS ks_sessions (
  token      TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,               -- parent|coach
  subject_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS sms_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER REFERENCES bookings(id),
  kind       TEXT NOT NULL,               -- confirm|reminder_24h|reminder_1h
  to_number  TEXT NOT NULL,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL,               -- sent|failed|dry_run|skipped_opt_out
  error      TEXT,
  sent_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_once ON sms_log(booking_id, kind);

CREATE TABLE IF NOT EXISTS attendance (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  child_name TEXT NOT NULL,
  status     TEXT NOT NULL,               -- attended|absent|cancelled
  notes      TEXT,
  marked_by  TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
-- One mark per child per session: re-marking corrects the record in place
-- rather than stacking a second, contradictory row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_once
  ON attendance(booking_id, child_name);
CREATE INDEX IF NOT EXISTS idx_attendance_child ON attendance(child_name);

CREATE TABLE IF NOT EXISTS progress_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  child_name TEXT NOT NULL,
  coach_name TEXT,
  skills     TEXT,                        -- JSON array of skill keys
  notes      TEXT,
  rating     INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_progress_once
  ON progress_notes(booking_id, child_name);
CREATE INDEX IF NOT EXISTS idx_progress_child ON progress_notes(child_name, created_at);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_email      TEXT NOT NULL,
  plan              TEXT NOT NULL,        -- 4-sessions|8-sessions|unlimited
  amount_pence      INTEGER NOT NULL,
  active            INTEGER NOT NULL DEFAULT 1,
  next_billing_date TEXT,                 -- YYYY-MM-DD (UK local), 1st of month
  created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  cancelled_at      INTEGER
);
-- A parent may only hold one live subscription; cancelled rows are kept for
-- history, so the uniqueness has to be partial rather than a plain UNIQUE.
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_live
  ON subscriptions(parent_email) WHERE active = 1;

CREATE TABLE IF NOT EXISTS subscription_invoices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
  period_start    TEXT NOT NULL,          -- YYYY-MM-DD inclusive
  period_end      TEXT NOT NULL,          -- YYYY-MM-DD inclusive
  amount_pence    INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending|paid|failed
  checkout_id     TEXT,
  checkout_url    TEXT,
  paid_at         INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
-- The billing run is idempotent on this index: one invoice per period.
CREATE UNIQUE INDEX IF NOT EXISTS idx_subinvoice_period
  ON subscription_invoices(subscription_id, period_start);
"""

# Weekly slot template (UK local). After-school hours midweek, mornings at
# the weekend — matches how KS actually runs clubs.
SLOT_TEMPLATE = {
    0: ["16:00", "17:00", "18:00", "19:00"],   # Monday
    1: ["16:00", "17:00", "18:00", "19:00"],
    2: ["16:00", "17:00", "18:00", "19:00"],
    3: ["16:00", "17:00", "18:00", "19:00"],
    4: ["16:00", "17:00", "18:00"],            # Friday
    5: ["09:00", "10:00", "11:00", "12:00", "13:00"],  # Saturday
    6: ["10:00", "11:00", "12:00"],            # Sunday
}

# Which knowledge.json services can be booked against a slot online, how long
# they run, and the shape of the booking. Anything not listed here is shown on
# the site as an enquiry-only service (schools ring for a bespoke quote).
BOOKABLE = {
    "1-to-1-coaching":     {"minutes": 60,  "label": "1-to-1 Coaching"},
    "small-group-coaching": {"minutes": 90, "label": "Small Group Coaching"},
    "team-coaching":       {"minutes": 90,  "label": "Team Coaching"},
    "holiday-camps":       {"minutes": 360, "label": "Holiday Camps", "full_day": True,
                            "start": "09:00", "end": "15:00"},
}

EXPERIENCE_LEVELS = ["Just starting out", "Plays for fun", "Plays for a club team", "Advanced / academy"]

_pool = threading.local()
_init_lock = threading.Lock()
_initialised = False


# ------------------------------------------------------------------- infra --

def _conn() -> sqlite3.Connection:
    conn = getattr(_pool, "ks_conn", None)
    if conn is None:
        Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA busy_timeout = 5000")
        conn.execute("PRAGMA foreign_keys = ON")
        _pool.ks_conn = conn
    _ensure_schema(conn)
    return conn


def _ensure_schema(conn) -> None:
    global _initialised
    if _initialised:
        return
    with _init_lock:
        if _initialised:
            return
        conn.executescript(SCHEMA)
        conn.commit()
        _seed_coaches(conn)
        _initialised = True


def _rows(sql: str, args=()) -> list[dict]:
    return [dict(r) for r in _conn().execute(sql, args).fetchall()]


def _one(sql: str, args=()) -> dict | None:
    r = _conn().execute(sql, args).fetchone()
    return dict(r) if r else None


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")


# --------------------------------------------------------------- knowledge --

_knowledge_cache: dict = {}
_knowledge_mtime: float = 0


def knowledge() -> dict:
    """Load knowledge.json, re-reading whenever the file changes on disk."""
    global _knowledge_cache, _knowledge_mtime
    try:
        mtime = os.path.getmtime(KNOWLEDGE_PATH)
    except OSError:
        return _knowledge_cache or {}
    if mtime != _knowledge_mtime or not _knowledge_cache:
        try:
            with open(KNOWLEDGE_PATH, encoding="utf-8") as fh:
                _knowledge_cache = json.load(fh)
            _knowledge_mtime = mtime
        except (OSError, json.JSONDecodeError):
            log.exception("ks: could not read knowledge.json")
            return _knowledge_cache or {}
    return _knowledge_cache


def _price_pence(price_text: str) -> int:
    """'From £35 per session (60 minutes)' → 3500. 0 when quoted on request."""
    m = re.search(r"£\s*([0-9]+(?:\.[0-9]{1,2})?)", price_text or "")
    return int(round(float(m.group(1)) * 100)) if m else 0


def services() -> list[dict]:
    out = []
    for s in knowledge().get("services", []):
        key = _slug(s.get("name", ""))
        spec = BOOKABLE.get(key)
        out.append({
            "key": key,
            "name": s.get("name", ""),
            "description": s.get("description", ""),
            "duration": s.get("duration", ""),
            "price": s.get("price", ""),
            "audience": s.get("audience", ""),
            "price_from_pence": _price_pence(s.get("price", "")),
            "bookable": bool(spec),
            "minutes": spec["minutes"] if spec else None,
            "full_day": bool(spec and spec.get("full_day")),
        })
    return out


def _service(key: str) -> dict | None:
    return next((s for s in services() if s["key"] == key), None)


def h_services() -> tuple[int, dict]:
    k = knowledge()
    biz = k.get("business", {})
    return 200, {
        "business": {
            "name": biz.get("name", "KS Sports Coaching"),
            "tagline": biz.get("tagline", ""),
            "area": biz.get("area", ""),
            "phone": biz.get("phone", ""),
            "email": biz.get("email", ""),
            "website": biz.get("website", ""),
        },
        "coaches": [{"name": c.get("name", ""), "bio": c.get("bio", ""),
                     "slug": _slug(c.get("name", ""))}
                    for c in biz.get("coaches", [])],
        "services": services(),
        # knowledge.json carries duplicate + chatbot-persona FAQ entries; the
        # website only wants the real parent-facing ones, de-duplicated.
        "faq": _public_faq(k.get("faq", [])),
        "credentials": k.get("credentials", []),
        "experience_levels": EXPERIENCE_LEVELS,
    }


_FAQ_SKIP = re.compile(r"socks|tell me about pricing", re.I)


def _public_faq(faq: list) -> list[dict]:
    seen, out = set(), []
    for item in faq:
        q = (item.get("question") or "").strip()
        if not q or _FAQ_SKIP.search(q) or q.lower() in seen:
            continue
        seen.add(q.lower())
        # The bot's answer has [XX] price placeholders; fill them from services.
        answer = (item.get("answer") or "").strip()
        if "[XX]" in answer:
            answer = _fill_price_placeholders(answer)
        out.append({"question": q, "answer": answer})
    return out


# Words that identify which service a "£[XX]" placeholder is talking about.
# Order matters: the first keyword found in the run-up to the placeholder wins.
_PRICE_HINTS = [
    ("camp", "holiday-camps"),
    ("group", "small-group-coaching"),
    ("team", "team-coaching"),
    ("1-to-1", "1-to-1-coaching"),
    ("one to one", "1-to-1-coaching"),
]


def _fill_price_placeholders(answer: str) -> str:
    """Swap the bot's £[XX] placeholders for real prices.

    Each placeholder is resolved from the words just before it, not by
    position — "camps from £[XX] per day" must not pick up team pricing
    just because team happens to come earlier in the services list.
    """
    by_key = {s["key"]: s["price_from_pence"] for s in services()}

    def repl(match: re.Match) -> str:
        lead = answer[max(0, match.start() - 60):match.start()].lower()
        for word, key in _PRICE_HINTS:
            if word in lead and by_key.get(key):
                return f"£{by_key[key] // 100}"
        return "£POA"

    return re.sub(r"£\[XX\]", repl, answer)


# ------------------------------------------------------------------ coaches --

def _seed_coaches(conn) -> None:
    """Create a coach account per coach in knowledge.json.

    First run generates a random password for each and writes them to
    CREDS_PATH (0600) — there is nowhere else to hand them over safely, and
    a blank password must never be a valid login.
    """
    biz = knowledge().get("business", {})
    fresh: list[tuple[str, str]] = []
    for c in biz.get("coaches", []):
        name = c.get("name", "").strip()
        if not name:
            continue
        slug = _slug(name.split()[0])       # saul / kellie
        existing = conn.execute("SELECT id FROM coaches WHERE slug = ?", (slug,)).fetchone()
        if existing:
            conn.execute("UPDATE coaches SET name = ?, bio = ? WHERE slug = ?",
                         (name, c.get("bio", ""), slug))
            continue
        pw = secrets.token_urlsafe(9)
        conn.execute(
            "INSERT INTO coaches (slug, name, email, bio, password_hash) VALUES (?,?,?,?,?)",
            (slug, name, biz.get("email", ""), c.get("bio", ""), auth.hash_password(pw)))
        fresh.append((slug, pw))
    conn.commit()
    if fresh:
        try:
            path = Path(CREDS_PATH)
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "a", encoding="utf-8") as fh:
                for slug, pw in fresh:
                    fh.write(f"{slug}: {pw}\n")
            path.chmod(0o600)
            log.warning("ks: seeded coach logins → %s", CREDS_PATH)
        except OSError:
            log.exception("ks: could not write coach credentials file")


def coaches() -> list[dict]:
    return _rows("SELECT id, slug, name, bio FROM coaches WHERE active = 1 ORDER BY id")


# ------------------------------------------------------------------ slots ---

def _uk_epoch(date_str: str, hhmm: str) -> int:
    dt = datetime.strptime(f"{date_str} {hhmm}", "%Y-%m-%d %H:%M").replace(tzinfo=UK)
    return int(dt.timestamp())


def _add_minutes(hhmm: str, minutes: int) -> str:
    dt = datetime.strptime(hhmm, "%H:%M") + timedelta(minutes=minutes)
    return dt.strftime("%H:%M")


def _overlaps(a_start: str, a_end: str, b_start: str, b_end: str) -> bool:
    return a_start < b_end and b_start < a_end


def slots(service_key: str, date_str: str, coach_id: int | None = None) -> tuple[int, dict]:
    """Free slots for a service on a date, per coach."""
    svc = _service(service_key)
    if not svc or not svc["bookable"]:
        return 400, {"error": "that service is not bookable online"}
    try:
        day = datetime.strptime(date_str, "%Y-%m-%d").date()
    except ValueError:
        return 400, {"error": "invalid date"}

    today = datetime.now(UK).date()
    if day < today:
        return 200, {"date": date_str, "slots": [], "reason": "date in the past"}
    if day > today + timedelta(days=BOOKING_HORIZON_DAYS):
        return 200, {"date": date_str, "slots": [],
                     "reason": f"we only take bookings {BOOKING_HORIZON_DAYS} days ahead"}

    spec = BOOKABLE[service_key]
    starts = [spec["start"]] if spec.get("full_day") else SLOT_TEMPLATE.get(day.weekday(), [])
    minutes = spec["minutes"]
    now = int(time.time())

    coach_list = [c for c in coaches() if coach_id is None or c["id"] == coach_id]
    booked = _rows(
        "SELECT coach_id, start_time, end_time FROM bookings "
        " WHERE date = ? AND status != 'cancelled'", (date_str,))
    blocks = _rows(
        "SELECT coach_id, start_time, end_time FROM availability WHERE date = ?", (date_str,))

    out = []
    for start in starts:
        end = spec["end"] if spec.get("full_day") else _add_minutes(start, minutes)
        starts_at = _uk_epoch(date_str, start)
        if starts_at <= now:
            continue                            # no booking a slot that has begun
        free = [c for c in coach_list
                if not any(b["coach_id"] == c["id"] and _overlaps(start, end, b["start_time"], b["end_time"])
                           for b in booked)
                and not any(bl["coach_id"] == c["id"] and _overlaps(start, end, bl["start_time"], bl["end_time"])
                            for bl in blocks)]
        if free:
            out.append({
                "start_time": start, "end_time": end, "starts_at": starts_at,
                "coaches": [{"id": c["id"], "name": c["name"]} for c in free],
            })
    return 200, {"date": date_str, "service": svc, "slots": out}


# --------------------------------------------------------------- bookings ---

def _booking_dto(b: dict) -> dict:
    now = int(time.time())
    return {
        "id": b["id"], "ref": b["ref"],
        "service_key": b["service_key"], "service_name": b["service_name"],
        "date": b["date"], "start_time": b["start_time"], "end_time": b["end_time"],
        "starts_at": b["starts_at"],
        "coach_name": b.get("coach_name"), "coach_id": b["coach_id"],
        "child_name": b["child_name"], "child_age": b["child_age"],
        "child_school": b["child_school"], "child_experience": b["child_experience"],
        "parent_name": b["parent_name"], "parent_email": b["parent_email"],
        "parent_phone": b["parent_phone"],
        "notes": b["notes"], "coach_notes": b.get("coach_notes"),
        "price_pence": b["price_pence"], "status": b["status"],
        "created_at": b["created_at"],
        "is_upcoming": b["status"] == "confirmed" and b["starts_at"] > now,
        "can_cancel": (b["status"] == "confirmed"
                       and b["starts_at"] - now > CANCEL_CUTOFF_HOURS * 3600),
    }


def _new_ref() -> str:
    return "KS-" + secrets.token_hex(3).upper()


def create_booking(body: dict, parent: dict | None = None) -> tuple[int, dict]:
    svc = _service((body.get("service_key") or "").strip())
    if not svc or not svc["bookable"]:
        return 400, {"error": "choose a service that can be booked online"}

    date_str = (body.get("date") or "").strip()
    start = (body.get("start_time") or "").strip()
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date_str) or not re.match(r"^\d{2}:\d{2}$", start):
        return 400, {"error": "choose a date and time"}

    child_name = (body.get("child_name") or "").strip()
    if not child_name:
        return 400, {"error": "we need the player's name"}
    parent_name = (body.get("parent_name") or (parent or {}).get("name") or "").strip()
    parent_email = (body.get("parent_email") or (parent or {}).get("email") or "").strip().lower()
    parent_phone = (body.get("parent_phone") or (parent or {}).get("phone") or "").strip()
    if not parent_name or not auth.valid_email(parent_email):
        return 400, {"error": "we need your name and a valid email address"}

    age = body.get("child_age")
    try:
        age = int(age) if age not in (None, "") else None
    except (TypeError, ValueError):
        return 400, {"error": "invalid age"}
    if age is not None and not (3 <= age <= 18):
        return 400, {"error": "we coach players aged 5-16 (3-18 accepted for enquiries)"}

    # Re-check the slot is genuinely free rather than trusting the client.
    code, avail = slots(svc["key"], date_str)
    if code != 200:
        return code, avail
    slot = next((s for s in avail["slots"] if s["start_time"] == start), None)
    if not slot:
        return 409, {"error": "that slot has just been taken — please pick another"}

    wanted_coach = body.get("coach_id")
    coach = None
    if wanted_coach not in (None, ""):
        coach = next((c for c in slot["coaches"] if c["id"] == int(wanted_coach)), None)
        if not coach:
            return 409, {"error": "that coach is no longer free at this time"}
    else:
        coach = slot["coaches"][0]

    conn = _conn()
    ref = _new_ref()
    cur = conn.execute(
        "INSERT INTO bookings (ref, parent_id, coach_id, service_key, service_name, date, "
        " start_time, end_time, starts_at, child_name, child_age, child_school, "
        " child_experience, parent_name, parent_email, parent_phone, notes, price_pence, status) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'confirmed')",
        (ref, (parent or {}).get("id"), coach["id"], svc["key"], svc["name"], date_str,
         start, slot["end_time"], slot["starts_at"], child_name, age,
         (body.get("child_school") or "").strip(), (body.get("child_experience") or "").strip(),
         parent_name, parent_email, parent_phone, (body.get("notes") or "").strip(),
         svc["price_from_pence"]))
    conn.commit()
    booking = _one("SELECT b.*, c.name AS coach_name FROM bookings b "
                   "JOIN coaches c ON c.id = b.coach_id WHERE b.id = ?", (cur.lastrowid,))

    send_confirmation(booking)
    return 200, {"booking": _booking_dto(booking)}


def bookings_for_email(email: str) -> tuple[int, dict]:
    email = (email or "").strip().lower()
    if not email:
        return 400, {"error": "email required"}
    rs = _rows("SELECT b.*, c.name AS coach_name FROM bookings b "
               "JOIN coaches c ON c.id = b.coach_id "
               "WHERE b.parent_email = ? ORDER BY b.starts_at DESC LIMIT 200", (email,))
    dtos = [_booking_dto(b) for b in rs]
    return 200, {
        "upcoming": [d for d in dtos if d["is_upcoming"]],
        "history": [d for d in dtos if not d["is_upcoming"]],
        "cancel_cutoff_hours": CANCEL_CUTOFF_HOURS,
    }


def cancel_booking(body: dict, parent: dict | None) -> tuple[int, dict]:
    ref = (body.get("ref") or "").strip().upper()
    email = (body.get("email") or (parent or {}).get("email") or "").strip().lower()
    b = _one("SELECT * FROM bookings WHERE ref = ?", (ref,))
    if not b:
        return 404, {"error": "booking not found"}
    # A booking is owned by the email that made it; a logged-in parent may
    # only touch their own, and an anonymous caller must quote the email.
    if b["parent_email"] != email:
        return 403, {"error": "that booking belongs to a different account"}
    if b["status"] == "cancelled":
        return 200, {"booking": _booking_dto(b), "already": True}
    if b["status"] == "completed":
        return 400, {"error": "that session has already taken place"}
    if b["starts_at"] - int(time.time()) <= CANCEL_CUTOFF_HOURS * 3600:
        return 400, {"error": f"sessions can only be cancelled online more than "
                              f"{CANCEL_CUTOFF_HOURS} hours ahead — please call us"}
    conn = _conn()
    conn.execute("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?",
                 (int(time.time()), b["id"]))
    conn.commit()
    return 200, {"booking": _booking_dto(_one("SELECT * FROM bookings WHERE id = ?", (b["id"],)))}


# ----------------------------------------------------------------- parents --

def _session_create(kind: str, subject_id: int) -> str:
    token = secrets.token_urlsafe(32)
    conn = _conn()
    conn.execute("INSERT INTO ks_sessions (token, kind, subject_id, expires_at) VALUES (?,?,?,?)",
                 (token, kind, subject_id, int(time.time()) + SESSION_TTL))
    conn.commit()
    return token


def session_subject(token: str, kind: str) -> dict | None:
    if not token:
        return None
    s = _one("SELECT * FROM ks_sessions WHERE token = ? AND kind = ? "
             "AND expires_at > strftime('%s','now')", (token, kind))
    if not s:
        return None
    table = "parents" if kind == "parent" else "coaches"
    return _one(f"SELECT * FROM {table} WHERE id = ?", (s["subject_id"],))


def logout(token: str) -> tuple[int, dict]:
    conn = _conn()
    conn.execute("DELETE FROM ks_sessions WHERE token = ?", (token,))
    conn.commit()
    return 200, {"ok": True}


def _parent_dto(p: dict) -> dict:
    kids = _rows("SELECT id, name, age, school, experience FROM children "
                 "WHERE parent_id = ? ORDER BY id", (p["id"],))
    return {"id": p["id"], "name": p["name"], "email": p["email"],
            "phone": p["phone"], "sms_opt_out": bool(p["sms_opt_out"]),
            "children": kids}


def parent_register(body: dict) -> tuple[int, dict]:
    name = (body.get("name") or "").strip()
    email = (body.get("email") or "").strip().lower()
    phone = (body.get("phone") or "").strip()
    password = body.get("password") or ""
    if not name:
        return 400, {"error": "your name is required"}
    if not auth.valid_email(email):
        return 400, {"error": "a valid email address is required"}
    if len(password) < auth.MIN_PASSWORD_LEN:
        return 400, {"error": f"password must be at least {auth.MIN_PASSWORD_LEN} characters"}
    if _one("SELECT id FROM parents WHERE email = ?", (email,)):
        return 409, {"error": "an account already exists for that email — try signing in"}

    conn = _conn()
    cur = conn.execute(
        "INSERT INTO parents (name, email, phone, password_hash) VALUES (?,?,?,?)",
        (name, email, phone, auth.hash_password(password)))
    pid = cur.lastrowid
    child_name = (body.get("child_name") or "").strip()
    if child_name:
        age = body.get("child_age")
        try:
            age = int(age) if age not in (None, "") else None
        except (TypeError, ValueError):
            age = None
        conn.execute(
            "INSERT INTO children (parent_id, name, age, school, experience) VALUES (?,?,?,?,?)",
            (pid, child_name, age, (body.get("child_school") or "").strip(),
             (body.get("child_experience") or "").strip()))
    conn.commit()

    # Bookings made before registering (guest checkout) belong to this account.
    conn.execute("UPDATE bookings SET parent_id = ? WHERE parent_email = ? AND parent_id IS NULL",
                 (pid, email))
    conn.commit()

    parent = _one("SELECT * FROM parents WHERE id = ?", (pid,))
    return 200, {"token": _session_create("parent", pid), "parent": _parent_dto(parent)}


def parent_login(body: dict) -> tuple[int, dict]:
    email = (body.get("email") or "").strip().lower()
    parent = _one("SELECT * FROM parents WHERE email = ?", (email,))
    if not parent or not auth.verify_password(body.get("password") or "", parent["password_hash"]):
        return 401, {"error": "invalid email or password"}
    return 200, {"token": _session_create("parent", parent["id"]),
                 "parent": _parent_dto(parent)}


def parent_me(parent: dict) -> tuple[int, dict]:
    return 200, {"parent": _parent_dto(parent)}


# ------------------------------------------------------------------ coach ---

def coach_login(body: dict) -> tuple[int, dict]:
    slug = _slug((body.get("username") or body.get("slug") or "").strip())
    coach = _one("SELECT * FROM coaches WHERE slug = ? AND active = 1", (slug,))
    if not coach or not auth.verify_password(body.get("password") or "", coach["password_hash"]):
        return 401, {"error": "invalid username or password"}
    return 200, {"token": _session_create("coach", coach["id"]),
                 "coach": {"id": coach["id"], "slug": coach["slug"], "name": coach["name"]}}


def coach_schedule(coach: dict, week_start: str | None = None) -> tuple[int, dict]:
    """A coach's week: sessions grouped by day, plus their blocked windows."""
    today = datetime.now(UK).date()
    if week_start:
        try:
            start = datetime.strptime(week_start, "%Y-%m-%d").date()
        except ValueError:
            return 400, {"error": "invalid week"}
    else:
        start = today - timedelta(days=today.weekday())      # Monday
    end = start + timedelta(days=6)
    s_str, e_str = start.isoformat(), end.isoformat()

    rs = _rows("SELECT b.*, c.name AS coach_name FROM bookings b "
               "JOIN coaches c ON c.id = b.coach_id "
               "WHERE b.coach_id = ? AND b.date BETWEEN ? AND ? "
               "ORDER BY b.date, b.start_time", (coach["id"], s_str, e_str))
    blocks = _rows("SELECT * FROM availability WHERE coach_id = ? AND date BETWEEN ? AND ? "
                   "ORDER BY date, start_time", (coach["id"], s_str, e_str))

    days = []
    for i in range(7):
        d = (start + timedelta(days=i)).isoformat()
        days.append({
            "date": d,
            "is_today": d == today.isoformat(),
            "sessions": [_booking_dto(b) for b in rs if b["date"] == d],
            "blocks": [b for b in blocks if b["date"] == d],
        })

    today_sessions = [_booking_dto(b) for b in rs if b["date"] == today.isoformat()]
    return 200, {
        "coach": {"id": coach["id"], "slug": coach["slug"], "name": coach["name"]},
        "week_start": s_str, "week_end": e_str,
        "days": days,
        "today": today.isoformat(),
        "today_sessions": today_sessions,
        "totals": {
            "sessions": len(rs),
            "completed": sum(1 for b in rs if b["status"] == "completed"),
            "cancelled": sum(1 for b in rs if b["status"] == "cancelled"),
        },
    }


def coach_complete(coach: dict, body: dict) -> tuple[int, dict]:
    ref = (body.get("ref") or "").strip().upper()
    b = _one("SELECT * FROM bookings WHERE ref = ?", (ref,))
    if not b:
        return 404, {"error": "session not found"}
    if b["coach_id"] != coach["id"]:
        return 403, {"error": "that session belongs to another coach"}
    if b["status"] == "cancelled":
        return 400, {"error": "that session was cancelled"}
    done = body.get("completed", True)
    conn = _conn()
    if done:
        conn.execute("UPDATE bookings SET status = 'completed', completed_at = ?, "
                     "coach_notes = COALESCE(?, coach_notes) WHERE id = ?",
                     (int(time.time()), (body.get("coach_notes") or "").strip() or None, b["id"]))
    else:
        conn.execute("UPDATE bookings SET status = 'confirmed', completed_at = NULL WHERE id = ?",
                     (b["id"],))
    conn.commit()
    return 200, {"booking": _booking_dto(
        _one("SELECT b.*, c.name AS coach_name FROM bookings b "
             "JOIN coaches c ON c.id = b.coach_id WHERE b.id = ?", (b["id"],)))}


def coach_availability(coach: dict, method: str, body: dict, query: dict) -> tuple[int, dict]:
    conn = _conn()
    if method == "GET":
        frm = query.get("from") or datetime.now(UK).date().isoformat()
        return 200, {"availability": _rows(
            "SELECT * FROM availability WHERE coach_id = ? AND date >= ? "
            "ORDER BY date, start_time LIMIT 200", (coach["id"], frm))}

    if body.get("delete_id"):
        conn.execute("DELETE FROM availability WHERE id = ? AND coach_id = ?",
                     (int(body["delete_id"]), coach["id"]))
        conn.commit()
        return 200, {"ok": True}

    date_str = (body.get("date") or "").strip()
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date_str):
        return 400, {"error": "choose a date to block"}
    start = (body.get("start_time") or "00:00").strip()
    end = (body.get("end_time") or "23:59").strip()
    if not re.match(r"^\d{2}:\d{2}$", start) or not re.match(r"^\d{2}:\d{2}$", end):
        return 400, {"error": "invalid time"}
    if start >= end:
        return 400, {"error": "the end time must be after the start time"}

    clash = _rows("SELECT ref, start_time, end_time FROM bookings "
                  "WHERE coach_id = ? AND date = ? AND status = 'confirmed'",
                  (coach["id"], date_str))
    clashing = [c for c in clash if _overlaps(start, end, c["start_time"], c["end_time"])]
    if clashing:
        return 409, {"error": "you already have a booked session in that window",
                     "clashes": clashing}

    cur = conn.execute(
        "INSERT INTO availability (coach_id, date, start_time, end_time, reason) VALUES (?,?,?,?,?)",
        (coach["id"], date_str, start, end, (body.get("reason") or "").strip()))
    conn.commit()
    return 200, {"availability": _one("SELECT * FROM availability WHERE id = ?", (cur.lastrowid,))}


# -------------------------------------------------------------------- SMS ---

def _read_secret(path: str) -> str:
    try:
        return Path(path).read_text().strip()
    except OSError:
        return ""


def _send_sms(to_number: str, body: str) -> tuple[str, str | None]:
    """Returns (status, error). Never raises — SMS must not fail a booking."""
    if not to_number:
        return "failed", "no phone number"
    if SMS_DRY_RUN:
        log.info("KS DRY-RUN sms to=%s body=%r", to_number, body[:120])
        return "dry_run", None
    username = _read_secret(CLICKSEND_USER_PATH)
    api_key = _read_secret(CLICKSEND_KEY_PATH)
    if not username or not api_key or not CLICKSEND_FROM:
        return "failed", "clicksend not configured"
    creds = base64.b64encode(f"{username}:{api_key}".encode()).decode()
    payload = json.dumps({"messages": [{
        "source": "sdk", "from": CLICKSEND_FROM, "body": body, "to": to_number,
    }]}).encode()
    req = urllib.request.Request(
        "https://rest.clicksend.com/v3/sms/send", data=payload, method="POST",
        headers={"Authorization": f"Basic {creds}", "Content-Type": "application/json",
                 "User-Agent": "ks-sports-booking/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            if r.status >= 300:
                return "failed", f"HTTP {r.status}"
        return "sent", None
    except Exception as exc:                                # noqa: BLE001
        log.warning("ks sms failed: %s", exc)
        return "failed", str(exc)[:200]


def _pretty_date(date_str: str) -> str:
    try:
        return datetime.strptime(date_str, "%Y-%m-%d").strftime("%a %-d %b")
    except ValueError:
        return date_str


def notify(booking: dict, kind: str) -> str:
    """Send one SMS for a booking, at most once per kind (UNIQUE index)."""
    conn = _conn()
    if _one("SELECT id FROM sms_log WHERE booking_id = ? AND kind = ?", (booking["id"], kind)):
        return "duplicate"

    parent = _one("SELECT sms_opt_out FROM parents WHERE lower(email) = ?",
                  ((booking["parent_email"] or "").lower(),))
    opted_out = bool(parent and parent["sms_opt_out"])

    coach_name = booking.get("coach_name") or "your coach"
    if kind == "confirm":
        body = (f"KS Sports: Your session with {coach_name} is confirmed for "
                f"{_pretty_date(booking['date'])} at {booking['start_time']}. "
                f"Reply STOP to opt out.")
    elif kind == "reminder_24h":
        body = (f"KS Sports reminder: {booking['child_name']} has "
                f"{booking['service_name']} tomorrow at {booking['start_time']}. See you there!")
    elif kind == "reminder_1h":
        body = (f"KS Sports: {booking['child_name']}'s session in 1 hour at "
                f"{booking['start_time']}.")
    elif kind == "absent_charge":
        # A no-show is charged in full, so the parent has to be told what
        # they have been charged and why — not just that they were missed.
        fee = booking.get("price_pence") or 0
        amount = f"£{fee / 100:.2f}".replace(".00", "") if fee else "the session fee"
        body = (f"KS Sports: {booking['child_name']} was marked absent from "
                f"{_pretty_date(booking['date'])} at {booking['start_time']}. "
                f"As we weren't told in advance, {amount} is still payable. "
                f"Please give us 24 hours' notice next time.")
    else:
        return "unknown kind"

    to = booking.get("parent_phone") or ""
    if opted_out:
        status, error = "skipped_opt_out", None
    elif not to:
        status, error = "failed", "no phone number"
    else:
        status, error = _send_sms(to, body)

    try:
        conn.execute(
            "INSERT INTO sms_log (booking_id, kind, to_number, body, status, error) "
            "VALUES (?,?,?,?,?,?)", (booking["id"], kind, to, body, status, error))
        conn.commit()
    except sqlite3.IntegrityError:
        return "duplicate"                      # raced with another sender
    return status


def send_notice(to_number: str, body: str, kind: str,
                booking_id: int | None = None) -> str:
    """Send and log a one-off SMS that is not tied to a booking's lifecycle.

    Billing texts have no booking to hang off, so they log with a NULL
    booking_id. SQLite treats NULLs as distinct in a UNIQUE index, which is
    exactly what we want here: idx_sms_once must not collapse every
    subscription receipt into one row. Callers that need send-once semantics
    (the monthly billing run) enforce it on their own table instead.
    """
    to = (to_number or "").strip()
    if not to:
        return "failed"
    status, error = _send_sms(to, body)
    try:
        conn = _conn()
        conn.execute(
            "INSERT INTO sms_log (booking_id, kind, to_number, body, status, error) "
            "VALUES (?,?,?,?,?,?)", (booking_id, kind, to, body, status, error))
        conn.commit()
    except sqlite3.Error:
        log.exception("ks: could not log %s sms", kind)
    return status


def parent_by_email(email: str) -> dict | None:
    return _one("SELECT * FROM parents WHERE lower(email) = ?",
                ((email or "").strip().lower(),))


def send_confirmation(booking: dict) -> str:
    try:
        return notify(booking, "confirm")
    except Exception:                           # noqa: BLE001
        log.exception("ks: confirmation SMS failed for %s", booking.get("ref"))
        return "failed"


def due_reminders(now: int | None = None) -> list[tuple[dict, str]]:
    """Bookings whose 24h / 1h reminder is due. Used by tools/ks_reminders.py."""
    now = now or int(time.time())
    out = []
    windows = [("reminder_24h", 24 * 3600, 3600), ("reminder_1h", 3600, 1800)]
    for kind, lead, tolerance in windows:
        target = now + lead
        rs = _rows(
            "SELECT b.*, c.name AS coach_name FROM bookings b "
            "JOIN coaches c ON c.id = b.coach_id "
            "WHERE b.status = 'confirmed' AND b.starts_at BETWEEN ? AND ? "
            "  AND b.id NOT IN (SELECT booking_id FROM sms_log WHERE kind = ? AND booking_id IS NOT NULL)",
            (target - tolerance, target + tolerance, kind))
        out.extend((b, kind) for b in rs)
    return out


def run_reminders() -> dict:
    """Send every due reminder. Idempotent — safe to run every 15 minutes."""
    sent = {"reminder_24h": 0, "reminder_1h": 0, "skipped": 0}
    for booking, kind in due_reminders():
        status = notify(booking, kind)
        if status in ("sent", "dry_run"):
            sent[kind] += 1
        else:
            sent["skipped"] += 1
    return sent


def sms_inbound(body: dict, form: dict) -> tuple[int, dict]:
    """ClickSend inbound webhook — honours STOP opt-outs.

    Point ClickSend's inbound SMS rule at POST /api/ks/sms-inbound to make
    this live; until then STOP replies are only honoured if a parent ticks
    the opt-out box in their account.
    """
    payload = {**(form or {}), **(body or {})}
    text = (payload.get("message") or payload.get("body") or "").strip().upper()
    frm = (payload.get("from") or payload.get("originalsenderid") or "").strip()
    if not frm:
        return 400, {"error": "missing sender"}
    if text.split()[:1] == ["STOP"]:
        conn = _conn()
        digits = re.sub(r"\D", "", frm)[-10:]
        conn.execute("UPDATE parents SET sms_opt_out = 1 "
                     "WHERE replace(replace(phone,' ',''),'+','') LIKE ?", (f"%{digits}",))
        conn.commit()
        log.info("ks: STOP honoured for %s", frm)
        return 200, {"ok": True, "opted_out": True}
    return 200, {"ok": True, "opted_out": False}
