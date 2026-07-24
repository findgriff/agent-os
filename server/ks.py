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

-- Coach-entered student records (richer than the parent-entered children
-- table: onboarding captures address, emergency contact and medical notes).
CREATE TABLE IF NOT EXISTS students (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id       INTEGER NOT NULL REFERENCES parents(id),
  name            TEXT NOT NULL,
  dob             TEXT,
  age             INTEGER,
  address         TEXT,
  postcode        TEXT,
  emergency_name  TEXT,
  emergency_phone TEXT,
  medical_notes   TEXT,
  source          TEXT,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_students_parent ON students(parent_id);

-- Prospective parents who've enquired but not booked. The coach's sales
-- pipeline, distinct from students (who are on the books). No SMS is ever
-- sent from here — leads are worked by hand.
CREATE TABLE IF NOT EXISTS ks_leads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_name  TEXT NOT NULL,
  phone        TEXT,
  email        TEXT,
  child_age    INTEGER,
  interest     TEXT,
  source       TEXT,
  status       TEXT NOT NULL DEFAULT 'new',   -- new|contacted|warm|cold
  notes        TEXT,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ks_leads_status ON ks_leads(status);

-- Whole-day leave (holiday / sick / personal). Distinct from availability,
-- which blocks time windows: a blockout removes the coach from every slot
-- on the date and flags any bookings already sitting on it.
CREATE TABLE IF NOT EXISTS coach_blockouts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  coach_id   INTEGER NOT NULL REFERENCES coaches(id),
  date       TEXT NOT NULL,
  reason     TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_blockouts_once ON coach_blockouts(coach_id, date);

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
        # CREATE TABLE IF NOT EXISTS never adds columns to a live table, so
        # new booking columns arrive as guarded ALTERs.
        cols = {r[1] for r in conn.execute("PRAGMA table_info(bookings)")}
        if "series_ref" not in cols:
            conn.execute("ALTER TABLE bookings ADD COLUMN series_ref TEXT")
        if "paid_at" not in cols:
            conn.execute("ALTER TABLE bookings ADD COLUMN paid_at INTEGER")
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

    # A whole-day blockout removes the coach from every slot on that date.
    blocked_out = {r["coach_id"] for r in _rows(
        "SELECT coach_id FROM coach_blockouts WHERE date = ?", (date_str,))}
    coach_list = [c for c in coaches()
                  if (coach_id is None or c["id"] == coach_id) and c["id"] not in blocked_out]
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
        "series_ref": b.get("series_ref"),
        "paid": bool(b.get("paid_at")), "paid_at": b.get("paid_at"),
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
    existing = _one("SELECT * FROM parents WHERE email = ?", (email,))
    if existing and existing["password_hash"]:
        return 409, {"error": "an account already exists for that email — try signing in"}

    conn = _conn()
    if existing:
        # A coach onboarded this family (students tab) before the parent
        # registered — let them claim the passwordless record.
        pid = existing["id"]
        conn.execute("UPDATE parents SET name = ?, phone = COALESCE(NULLIF(?,''), phone), "
                     "password_hash = ? WHERE id = ?",
                     (name, phone, auth.hash_password(password), pid))
    else:
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


def coach_schedule(coach: dict, week_start: str | None = None,
                   span: int = 7) -> tuple[int, dict]:
    """A coach's sessions grouped by day, plus blocked windows and day-offs.

    span defaults to a week; the dashboard's month view asks for up to 42
    days in one call rather than stitching six weekly fetches together.
    """
    span = max(1, min(42, span))
    today = datetime.now(UK).date()
    if week_start:
        try:
            start = datetime.strptime(week_start, "%Y-%m-%d").date()
        except ValueError:
            return 400, {"error": "invalid week"}
    else:
        start = today - timedelta(days=today.weekday())      # Monday
    end = start + timedelta(days=span - 1)
    s_str, e_str = start.isoformat(), end.isoformat()

    rs = _rows("SELECT b.*, c.name AS coach_name FROM bookings b "
               "JOIN coaches c ON c.id = b.coach_id "
               "WHERE b.coach_id = ? AND b.date BETWEEN ? AND ? "
               "ORDER BY b.date, b.start_time", (coach["id"], s_str, e_str))
    blocks = _rows("SELECT * FROM availability WHERE coach_id = ? AND date BETWEEN ? AND ? "
                   "ORDER BY date, start_time", (coach["id"], s_str, e_str))
    blockouts = _rows("SELECT * FROM coach_blockouts WHERE coach_id = ? AND date BETWEEN ? AND ? "
                      "ORDER BY date", (coach["id"], s_str, e_str))

    days = []
    for i in range(span):
        d = (start + timedelta(days=i)).isoformat()
        days.append({
            "date": d,
            "is_today": d == today.isoformat(),
            "sessions": [_booking_dto(b) for b in rs if b["date"] == d],
            "blocks": [b for b in blocks if b["date"] == d],
            "blockout": next((b for b in blockouts if b["date"] == d), None),
        })

    today_sessions = [_booking_dto(b) for b in rs if b["date"] == today.isoformat()]
    return 200, {
        "coach": {"id": coach["id"], "slug": coach["slug"], "name": coach["name"]},
        # Every active coach, so the dashboard can offer a coach picker when
        # rescheduling a session.
        "coaches": [{"id": c["id"], "name": c["name"]} for c in coaches()],
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


# ---------------------------------------------------------------- students --

STUDENT_SOURCES = ["word of mouth", "social media", "website", "other"]


def _student_dto(s: dict) -> dict:
    """Student + parent + their real booking/attendance footprint."""
    history = _rows(
        "SELECT ref, date, start_time, end_time, service_name, status FROM bookings "
        "WHERE lower(child_name) = lower(?) AND lower(parent_email) = lower(?) "
        "ORDER BY date DESC, start_time DESC LIMIT 25",
        (s["name"], s["parent_email"]))
    marks = _rows(
        "SELECT a.status, COUNT(*) AS n FROM attendance a "
        "JOIN bookings b ON b.id = a.booking_id "
        "WHERE lower(a.child_name) = lower(?) AND lower(b.parent_email) = lower(?) "
        "GROUP BY a.status", (s["name"], s["parent_email"]))
    counts = {m["status"]: m["n"] for m in marks}
    return {
        "id": s["id"], "name": s["name"], "dob": s["dob"], "age": s["age"],
        "address": s["address"], "postcode": s["postcode"],
        "emergency_name": s["emergency_name"], "emergency_phone": s["emergency_phone"],
        "medical_notes": s["medical_notes"], "source": s["source"],
        "created_at": s["created_at"],
        "parent": {"id": s["parent_id"], "name": s["parent_name"],
                   "email": s["parent_email"], "phone": s["parent_phone"]},
        "bookings": history,
        "attendance": {"attended": counts.get("attended", 0),
                       "absent": counts.get("absent", 0),
                       "cancelled": counts.get("cancelled", 0)},
    }


def students_list(coach: dict) -> tuple[int, dict]:
    rows = _rows(
        "SELECT s.*, p.name AS parent_name, p.email AS parent_email, p.phone AS parent_phone "
        "FROM students s JOIN parents p ON p.id = s.parent_id ORDER BY s.name")
    return 200, {"students": [_student_dto(s) for s in rows]}


def students_add(coach: dict, body: dict) -> tuple[int, dict]:
    child = (body.get("child_name") or "").strip()
    parent_name = (body.get("parent_name") or "").strip()
    parent_email = (body.get("parent_email") or "").strip().lower()
    parent_phone = (body.get("parent_phone") or "").strip()
    address = (body.get("address") or "").strip()
    postcode = (body.get("postcode") or "").strip().upper()
    dob = (body.get("dob") or "").strip()

    age = body.get("age")
    try:
        age = int(age) if age not in (None, "") else None
    except (TypeError, ValueError):
        return 400, {"error": "invalid age"}
    if dob:
        try:
            born = datetime.strptime(dob, "%Y-%m-%d").date()
            today = datetime.now(UK).date()
            age = today.year - born.year - ((today.month, today.day) < (born.month, born.day))
        except ValueError:
            return 400, {"error": "date of birth must be YYYY-MM-DD"}

    if not child:
        return 400, {"error": "the child's full name is required"}
    if age is None:
        return 400, {"error": "the child's age or date of birth is required"}
    if not (3 <= age <= 18):
        return 400, {"error": "we coach players aged 5-16 (3-18 accepted)"}
    if not parent_name:
        return 400, {"error": "the parent's name is required"}
    if not auth.valid_email(parent_email):
        return 400, {"error": "a valid parent email is required"}
    if not parent_phone:
        return 400, {"error": "the parent's phone number is required"}
    if not address or not postcode:
        return 400, {"error": "the parent's address and postcode are required"}

    source = (body.get("source") or "").strip().lower()
    if source not in STUDENT_SOURCES:
        source = "other"

    conn = _conn()
    parent = _one("SELECT * FROM parents WHERE email = ?", (parent_email,))
    if parent:
        pid = parent["id"]
        # Coach data fills blanks on an existing account, never overwrites
        # what the parent typed themselves.
        conn.execute("UPDATE parents SET phone = COALESCE(NULLIF(phone,''), ?) WHERE id = ?",
                     (parent_phone, pid))
    else:
        pid = conn.execute(
            "INSERT INTO parents (name, email, phone) VALUES (?,?,?)",
            (parent_name, parent_email, parent_phone)).lastrowid

    if _one("SELECT s.id FROM students s WHERE s.parent_id = ? AND lower(s.name) = lower(?)",
            (pid, child)):
        return 409, {"error": f"{child} is already on the books for this parent"}

    sid = conn.execute(
        "INSERT INTO students (parent_id, name, dob, age, address, postcode, "
        " emergency_name, emergency_phone, medical_notes, source) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (pid, child, dob or None, age, address, postcode,
         (body.get("emergency_name") or "").strip(),
         (body.get("emergency_phone") or "").strip(),
         (body.get("medical_notes") or "").strip(), source)).lastrowid
    # Mirror into the legacy children table so parent accounts and the public
    # booking flow see the child too.
    if not _one("SELECT id FROM children WHERE parent_id = ? AND lower(name) = lower(?)",
                (pid, child)):
        conn.execute("INSERT INTO children (parent_id, name, age) VALUES (?,?,?)",
                     (pid, child, age))
    conn.commit()

    s = _one("SELECT s.*, p.name AS parent_name, p.email AS parent_email, "
             "p.phone AS parent_phone FROM students s "
             "JOIN parents p ON p.id = s.parent_id WHERE s.id = ?", (sid,))
    return 200, {"student": _student_dto(s)}


# --------------------------------------------------------------- leads --
# The coach's enquiry pipeline. Statuses match the dashboard's four columns;
# a lead that books becomes a student and drops off the list by hand.
LEAD_STATUSES = ("new", "contacted", "warm", "cold")

# Newest and hottest first: brand-new and warm leads want chasing today,
# cold ones sink to the bottom.
_LEAD_ORDER = ("new", "warm", "contacted", "cold")


def _lead_dto(l: dict) -> dict:
    return {
        "id": l["id"],
        "parent": l["parent_name"],
        "phone": l["phone"] or "",
        "email": l["email"] or "",
        "childAge": l["child_age"] or 0,
        "interest": l["interest"] or "",
        "source": l["source"] or "",
        "status": l["status"],
        "added": datetime.fromtimestamp(l["created_at"], UK).date().isoformat(),
    }


def leads_list(coach: dict) -> tuple[int, dict]:
    rows = _rows("SELECT * FROM ks_leads ORDER BY created_at DESC")
    rank = {s: i for i, s in enumerate(_LEAD_ORDER)}
    rows.sort(key=lambda l: rank.get(l["status"], len(rank)))
    return 200, {"leads": [_lead_dto(l) for l in rows]}


def lead_add(coach: dict, body: dict) -> tuple[int, dict]:
    parent = (body.get("parent") or "").strip()
    if not parent:
        return 400, {"error": "the parent's name is required"}
    email = (body.get("email") or "").strip().lower()
    if email and not auth.valid_email(email):
        return 400, {"error": "that email doesn't look right"}
    try:
        age = int(body.get("childAge") or 0) or None
    except (TypeError, ValueError):
        age = None
    conn = _conn()
    lid = conn.execute(
        "INSERT INTO ks_leads (parent_name, phone, email, child_age, interest, source) "
        "VALUES (?,?,?,?,?,?)",
        (parent, (body.get("phone") or "").strip(), email, age,
         (body.get("interest") or "").strip(), (body.get("source") or "").strip())).lastrowid
    conn.commit()
    return 200, {"lead": _lead_dto(_one("SELECT * FROM ks_leads WHERE id = ?", (lid,)))}


def lead_update(coach: dict, lead_id: int, body: dict) -> tuple[int, dict]:
    lead = _one("SELECT * FROM ks_leads WHERE id = ?", (lead_id,))
    if not lead:
        return 404, {"error": "that lead is no longer on the list"}
    status = (body.get("status") or "").strip().lower()
    if status not in LEAD_STATUSES:
        return 400, {"error": "unknown lead status"}
    conn = _conn()
    conn.execute("UPDATE ks_leads SET status = ?, updated_at = strftime('%s','now') WHERE id = ?",
                 (status, lead_id))
    conn.commit()
    return 200, {"lead": _lead_dto(_one("SELECT * FROM ks_leads WHERE id = ?", (lead_id,)))}


# ---------------------------------------------------------------- route --
# The coach's driving day: real bookings for a date, placed on the map from
# the student's postcode. Bookings hold no address, so we join through the
# student record; coordinates come from postcodes.io (free, keyless).

# Where the coach starts and ends the day. A constant for now — a settings
# field later — matching the seeded home base the UI already shows.
ROUTE_HOME = {"venue": "Home base", "postcode": "CH2 1BX", "lat": 53.2040, "lng": -2.8850}

# Process-lifetime postcode → (lat, lng) cache. A postcode the API says is
# invalid caches as None so it isn't looked up again; a network failure caches
# nothing, so the next route load retries.
_geo_cache: dict[str, tuple[float, float] | None] = {}


def _geocode(postcodes: list[str]) -> dict[str, tuple[float, float]]:
    norm = [p.strip().upper() for p in postcodes if p and p.strip()]
    want = sorted({p for p in norm if p not in _geo_cache})
    if want:
        try:
            body = json.dumps({"postcodes": want}).encode()
            req = urllib.request.Request(
                "https://api.postcodes.io/postcodes", data=body,
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=6) as r:
                data = json.load(r)
            for entry in data.get("result", []):
                q = (entry.get("query") or "").strip().upper()
                res = entry.get("result")
                _geo_cache[q] = (res["latitude"], res["longitude"]) if res else None
        except Exception:
            log.warning("ks: postcode geocode failed", exc_info=True)
    return {p: _geo_cache[p] for p in set(norm) if _geo_cache.get(p)}


def coach_route(coach: dict, date_str: str | None) -> tuple[int, dict]:
    date_str = date_str or datetime.now(UK).date().isoformat()
    try:
        datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        return 400, {"error": "invalid date"}
    rows = _rows(
        "SELECT b.id, b.child_name, b.service_name, b.start_time, b.end_time, b.status, "
        "       s.address AS address, s.postcode AS postcode "
        "FROM bookings b "
        "LEFT JOIN parents p ON lower(p.email) = lower(b.parent_email) "
        "LEFT JOIN students s ON s.parent_id = p.id AND lower(s.name) = lower(b.child_name) "
        "WHERE b.coach_id = ? AND b.date = ? AND b.status != 'cancelled' "
        "ORDER BY b.start_time",
        (coach["id"], date_str))
    coords = _geocode([r["postcode"] for r in rows])
    stops = []
    for r in rows:
        pc = (r["postcode"] or "").strip().upper()
        c = coords.get(pc)
        stops.append({
            "id": r["id"], "child_name": r["child_name"], "service_name": r["service_name"],
            "start_time": r["start_time"], "end_time": r["end_time"], "status": r["status"],
            "address": r["address"] or "", "postcode": pc,
            "lat": c[0] if c else None, "lng": c[1] if c else None,
        })
    return 200, {"date": date_str, "home": ROUTE_HOME, "stops": stops}


# ------------------------------------------------------ coach booking CRUD --

def _coach_day_conflicts(coach_id: int, date_str: str, start: str, end: str,
                         ignore_booking_id: int | None = None) -> str | None:
    """Why this window can't take a booking, or None when it's free."""
    if _one("SELECT id FROM coach_blockouts WHERE coach_id = ? AND date = ?",
            (coach_id, date_str)):
        return "that day is blocked out"
    booked = _rows("SELECT id, start_time, end_time FROM bookings "
                   "WHERE coach_id = ? AND date = ? AND status != 'cancelled'",
                   (coach_id, date_str))
    for b in booked:
        if b["id"] != ignore_booking_id and _overlaps(start, end, b["start_time"], b["end_time"]):
            return f"clashes with a session at {b['start_time']}"
    for bl in _rows("SELECT start_time, end_time FROM availability "
                    "WHERE coach_id = ? AND date = ?", (coach_id, date_str)):
        if _overlaps(start, end, bl["start_time"], bl["end_time"]):
            return "that window is blocked in availability"
    return None


def coach_create_booking(coach: dict, body: dict) -> tuple[int, dict]:
    """Coach adds a booking straight onto the calendar, optionally weekly.

    SMS is live, so nothing is texted unless notify=true is set explicitly —
    and then only for the first session of a series.
    """
    svc = _service((body.get("service_key") or "").strip())
    if not svc or not svc["bookable"]:
        return 400, {"error": "choose a bookable session type"}

    date_str = (body.get("date") or "").strip()
    start = (body.get("start_time") or "").strip()
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date_str) or not re.match(r"^\d{2}:\d{2}$", start):
        return 400, {"error": "choose a date and time"}

    try:
        duration = int(body.get("duration_minutes") or svc["minutes"] or 60)
    except (TypeError, ValueError):
        return 400, {"error": "invalid duration"}
    duration = max(30, min(360, duration))

    coach_id = body.get("coach_id") or coach["id"]
    try:
        coach_id = int(coach_id)
    except (TypeError, ValueError):
        return 400, {"error": "invalid coach"}
    if not _one("SELECT id FROM coaches WHERE id = ? AND active = 1", (coach_id,)):
        return 404, {"error": "coach not found"}

    # The player either comes from the students book or is typed in.
    child_name, parent_name, parent_email, parent_phone, child_age = "", "", "", "", None
    if body.get("student_id"):
        s = _one("SELECT s.*, p.name AS parent_name, p.email AS parent_email, "
                 "p.phone AS parent_phone FROM students s "
                 "JOIN parents p ON p.id = s.parent_id WHERE s.id = ?",
                 (int(body["student_id"]),))
        if not s:
            return 404, {"error": "student not found"}
        child_name, child_age = s["name"], s["age"]
        parent_name, parent_email, parent_phone = s["parent_name"], s["parent_email"], s["parent_phone"]
    else:
        child_name = (body.get("child_name") or "").strip()
        parent_name = (body.get("parent_name") or "").strip()
        parent_email = (body.get("parent_email") or "").strip().lower()
        parent_phone = (body.get("parent_phone") or "").strip()
        if not child_name:
            return 400, {"error": "pick a student or type the player's name"}
        if not parent_name or not auth.valid_email(parent_email):
            return 400, {"error": "a parent name and valid email are needed for a new player"}

    try:
        repeat = int(body.get("repeat_weeks") or 1)
    except (TypeError, ValueError):
        repeat = 1
    repeat = max(1, min(12, repeat))
    series_ref = ("SER-" + secrets.token_hex(3).upper()) if repeat > 1 else None
    notify = bool(body.get("notify"))

    end = _add_minutes(start, duration)
    conn = _conn()
    created, skipped = [], []
    for w in range(repeat):
        d = (datetime.strptime(date_str, "%Y-%m-%d").date() + timedelta(weeks=w)).isoformat()
        conflict = _coach_day_conflicts(coach_id, d, start, end)
        if conflict:
            skipped.append({"date": d, "reason": conflict})
            continue
        ref = _new_ref()
        cur = conn.execute(
            "INSERT INTO bookings (ref, coach_id, service_key, service_name, date, "
            " start_time, end_time, starts_at, child_name, child_age, parent_name, "
            " parent_email, parent_phone, notes, price_pence, status, series_ref) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'confirmed', ?)",
            (ref, coach_id, svc["key"], svc["name"], d, start, end,
             _uk_epoch(d, start), child_name, child_age, parent_name, parent_email,
             parent_phone, (body.get("notes") or "").strip(),
             svc["price_from_pence"], series_ref))
        conn.commit()
        booking = _one("SELECT b.*, c.name AS coach_name FROM bookings b "
                       "JOIN coaches c ON c.id = b.coach_id WHERE b.id = ?", (cur.lastrowid,))
        created.append(_booking_dto(booking))
        # One confirmation text at most, and never for a session in the past.
        if notify and w == 0 and booking["starts_at"] > int(time.time()):
            send_confirmation(booking)

    if not created:
        return 409, {"error": skipped[0]["reason"] if skipped else "nothing could be booked",
                     "skipped": skipped}
    return 200, {"bookings": created, "skipped": skipped, "series_ref": series_ref}


def coach_update_booking(coach: dict, booking_id: int, body: dict) -> tuple[int, dict]:
    """Reschedule / reassign / cancel a booking (or its whole series)."""
    b = _one("SELECT * FROM bookings WHERE id = ?", (int(booking_id),))
    if not b:
        return 404, {"error": "booking not found"}
    conn = _conn()

    if (body.get("status") or "") == "cancelled":
        if body.get("scope") == "series" and b["series_ref"]:
            n = conn.execute(
                "UPDATE bookings SET status = 'cancelled', cancelled_at = ? "
                "WHERE series_ref = ? AND status = 'confirmed'",
                (int(time.time()), b["series_ref"])).rowcount
            conn.commit()
            return 200, {"cancelled": n, "series_ref": b["series_ref"]}
        if b["status"] == "cancelled":
            return 200, {"booking": _booking_dto(b), "already": True}
        conn.execute("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?",
                     (int(time.time()), b["id"]))
        conn.commit()
        return 200, {"booking": _booking_dto(
            _one("SELECT b.*, c.name AS coach_name FROM bookings b "
                 "JOIN coaches c ON c.id = b.coach_id WHERE b.id = ?", (b["id"],)))}

    if b["status"] == "cancelled":
        return 400, {"error": "that session was cancelled — book a fresh one instead"}

    new_date = (body.get("date") or b["date"]).strip()
    new_start = (body.get("start_time") or b["start_time"]).strip()
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", new_date) or not re.match(r"^\d{2}:\d{2}$", new_start):
        return 400, {"error": "invalid date or time"}
    duration = (datetime.strptime(b["end_time"], "%H:%M")
                - datetime.strptime(b["start_time"], "%H:%M")).seconds // 60
    if body.get("duration_minutes"):
        try:
            duration = max(30, min(360, int(body["duration_minutes"])))
        except (TypeError, ValueError):
            return 400, {"error": "invalid duration"}
    new_end = _add_minutes(new_start, duration)

    new_coach_id = b["coach_id"]
    if body.get("coach_id"):
        try:
            new_coach_id = int(body["coach_id"])
        except (TypeError, ValueError):
            return 400, {"error": "invalid coach"}
        if not _one("SELECT id FROM coaches WHERE id = ? AND active = 1", (new_coach_id,)):
            return 404, {"error": "coach not found"}

    conflict = _coach_day_conflicts(new_coach_id, new_date, new_start, new_end,
                                    ignore_booking_id=b["id"])
    if conflict:
        return 409, {"error": conflict}

    child_name = (body.get("child_name") or b["child_name"]).strip()
    conn.execute(
        "UPDATE bookings SET date = ?, start_time = ?, end_time = ?, starts_at = ?, "
        " coach_id = ?, child_name = ? WHERE id = ?",
        (new_date, new_start, new_end, _uk_epoch(new_date, new_start),
         new_coach_id, child_name, b["id"]))
    conn.commit()
    return 200, {"booking": _booking_dto(
        _one("SELECT b.*, c.name AS coach_name FROM bookings b "
             "JOIN coaches c ON c.id = b.coach_id WHERE b.id = ?", (b["id"],)))}


# --------------------------------------------------------------- blockouts --

def blockouts_list(coach: dict) -> tuple[int, dict]:
    frm = (datetime.now(UK).date() - timedelta(days=30)).isoformat()
    return 200, {"blockouts": _rows(
        "SELECT * FROM coach_blockouts WHERE coach_id = ? AND date >= ? ORDER BY date",
        (coach["id"], frm))}


def blockout_add(coach: dict, body: dict) -> tuple[int, dict]:
    date_str = (body.get("date") or "").strip()
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date_str):
        return 400, {"error": "choose a date to block"}
    conn = _conn()
    try:
        cur = conn.execute(
            "INSERT INTO coach_blockouts (coach_id, date, reason) VALUES (?,?,?)",
            (coach["id"], date_str, (body.get("reason") or "").strip()))
        conn.commit()
    except sqlite3.IntegrityError:
        return 409, {"error": "that day is already blocked out"}
    # Bookings already on the day are allowed to stand — the dashboard
    # highlights them so the coach can rearrange or cancel deliberately.
    clashing = _rows(
        "SELECT id, ref, start_time, end_time, child_name, service_name FROM bookings "
        "WHERE coach_id = ? AND date = ? AND status = 'confirmed' ORDER BY start_time",
        (coach["id"], date_str))
    return 200, {"blockout": _one("SELECT * FROM coach_blockouts WHERE id = ?", (cur.lastrowid,)),
                 "clashing_bookings": clashing}


def blockout_delete(coach: dict, blockout_id: int) -> tuple[int, dict]:
    conn = _conn()
    conn.execute("DELETE FROM coach_blockouts WHERE id = ? AND coach_id = ?",
                 (int(blockout_id), coach["id"]))
    conn.commit()
    return 200, {"ok": True}


# ----------------------------------------------------------------- finance --

def _month_keys(n: int = 6) -> list[str]:
    """The last n calendar months as 'YYYY-MM', oldest first, ending this month."""
    today = datetime.now(UK).date()
    y, m, keys = today.year, today.month, []
    for _ in range(n):
        keys.append(f"{y:04d}-{m:02d}")
        m -= 1
        if m == 0:
            m, y = 12, y - 1
    return list(reversed(keys))


def coach_finance(coach: dict) -> tuple[int, dict]:
    """Business-wide money view: earned revenue, sign-ups and unpaid sessions.

    Revenue is recognised when a session is *completed* (delivered), matching
    how coaches think about earnings; a delivered session is outstanding until
    it is marked paid. Figures span every coach, like the students list.
    """
    months = _month_keys(6)
    start_month = months[0] + "-01"

    # Revenue by month from delivered (completed) sessions.
    rev = {k: 0 for k in months}
    for r in _rows(
        "SELECT substr(date,1,7) AS ym, COALESCE(SUM(price_pence),0) AS pence "
        "FROM bookings WHERE status = 'completed' AND date >= ? GROUP BY ym",
        (start_month,)):
        if r["ym"] in rev:
            rev[r["ym"]] = r["pence"]

    # New students onboarded per month.
    signups = {k: 0 for k in months}
    for r in _rows(
        "SELECT strftime('%Y-%m', created_at, 'unixepoch') AS ym, COUNT(*) AS n "
        "FROM students GROUP BY ym"):
        if r["ym"] in signups:
            signups[r["ym"]] = r["n"]

    active_students = _one("SELECT COUNT(*) AS n FROM students")["n"]
    collected = _one("SELECT COALESCE(SUM(price_pence),0) AS p FROM bookings "
                     "WHERE status = 'completed' AND paid_at IS NOT NULL")["p"]
    outstanding_total = _one("SELECT COALESCE(SUM(price_pence),0) AS p FROM bookings "
                             "WHERE status = 'completed' AND paid_at IS NULL")["p"]
    upcoming = _one("SELECT COALESCE(SUM(price_pence),0) AS p FROM bookings "
                    "WHERE status = 'confirmed' AND starts_at > ?", (int(time.time()),))["p"]

    # Unpaid delivered sessions, grouped per child (oldest first).
    groups: dict[tuple, dict] = {}
    for b in _rows(
        "SELECT id, date, price_pence, child_name, parent_name, parent_email, parent_phone "
        "FROM bookings WHERE status = 'completed' AND paid_at IS NULL "
        "ORDER BY date ASC, start_time ASC"):
        key = (b["child_name"].lower(), (b["parent_email"] or "").lower())
        g = groups.get(key)
        if not g:
            g = groups[key] = {
                "student": b["child_name"], "parent_name": b["parent_name"],
                "parent_email": b["parent_email"], "parent_phone": b["parent_phone"],
                "amount_pence": 0, "sessions": 0,
                "oldest_date": b["date"], "booking_ids": [],
            }
        g["amount_pence"] += b["price_pence"]
        g["sessions"] += 1
        g["booking_ids"].append(b["id"])
    outstanding = sorted(groups.values(), key=lambda g: g["oldest_date"])

    return 200, {
        "months": months,
        "revenue_pence": [rev[k] for k in months],
        "signups": [signups[k] for k in months],
        "active_students": active_students,
        "earned_total_pence": sum(rev.values()),
        "this_month_pence": rev[months[-1]],
        "collected_pence": collected,
        "outstanding_pence": outstanding_total,
        "upcoming_pence": upcoming,
        "outstanding": outstanding,
    }


def coach_mark_paid(coach: dict, body: dict) -> tuple[int, dict]:
    """Mark delivered sessions paid (or, with paid=false, un-mark them)."""
    ids = body.get("booking_ids") or []
    if not isinstance(ids, list) or not ids:
        return 400, {"error": "no sessions selected"}
    try:
        ids = [int(i) for i in ids]
    except (TypeError, ValueError):
        return 400, {"error": "invalid session id"}
    paid = bool(body.get("paid", True))
    conn = _conn()
    placeholders = ",".join("?" for _ in ids)
    n = conn.execute(
        f"UPDATE bookings SET paid_at = ? WHERE id IN ({placeholders}) AND status = 'completed'",
        (int(time.time()) if paid else None, *ids)).rowcount
    conn.commit()
    return 200, {"updated": n, "paid": paid}


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
