"""In-browser Hermes chat — talk to Hermes from the AGENT OS web UI.

The agent-os service runs as root, whose ~/.hermes/.env has an inference
provider configured, so it can drive the Hermes CLI directly:

    hermes -z "<message>" --continue agentos-web-<user_id>

`-z` runs a single non-interactive turn; `--continue <name>` chains it onto a
named session so Hermes remembers earlier turns (a real conversation, not a
string of amnesiac one-shots). Each HQ user gets their own session, so one
person's chat never bleeds into another's.

Security: the user's message is passed as a single argv element with
shell=False — it is never interpolated into a shell string, so there is no
command-injection surface no matter what the message contains. The session
name is derived from the integer user id and additionally sanitised.
"""
from __future__ import annotations
import os
import re
import subprocess
import threading

from server import db as db_module

# Resolved lazily against app.get_db so we share the one HQ connection pool.
_get_db = None

HERMES_BIN = os.environ.get("HERMES_BIN", "hermes")
# The provider keys live in root's Hermes config; the service is root, but we
# force HOME so this holds even if systemd leaves HOME unset in the unit.
HERMES_HOME = os.environ.get("HERMES_HOME", "/root")
# A cold `hermes -z` is ~6s; allow generous head-room for tool-using turns
# without hanging a request thread forever.
CALL_TIMEOUT = int(os.environ.get("HERMES_TIMEOUT", "150"))
MAX_MESSAGE = 4000
HISTORY_LIMIT = 100

# One Hermes session is single-threaded state on disk. Serialise calls per
# session so two overlapping sends can't corrupt the same conversation.
_session_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _bind_db():
    """Late import to avoid a circular import with server.app at module load."""
    global _get_db
    if _get_db is None:
        from server.app import get_db
        _get_db = get_db
    return _get_db()


def _ensure_table(conn) -> None:
    # schema.sql already carries this table, but a live DB that predates the
    # column set won't pick it up without a restart running the script; a
    # guarded create keeps this module self-sufficient regardless.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS hermes_chat ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " user_id INTEGER, role TEXT NOT NULL, content TEXT NOT NULL,"
        " created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')))")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_hermes_chat_user "
                 "ON hermes_chat(user_id, id)")
    conn.commit()


def _session_name(user_id: int) -> str:
    name = f"agentos-web-{user_id}"
    return re.sub(r"[^a-z0-9-]", "", name)


def _lock_for(session: str) -> threading.Lock:
    with _locks_guard:
        lock = _session_locks.get(session)
        if lock is None:
            lock = _session_locks[session] = threading.Lock()
        return lock


def _msg_dto(r: dict) -> dict:
    return {"id": r["id"], "role": r["role"],
            "content": r["content"], "created_at": r["created_at"]}


def _run_hermes(message: str, session: str) -> tuple[bool, str]:
    """Drive one Hermes turn. Returns (ok, text). Never raises."""
    env = {**os.environ, "HOME": HERMES_HOME}
    argv = [HERMES_BIN, "-z", message,
            "--continue", session, "--no-restore-cwd"]
    try:
        proc = subprocess.run(
            argv, env=env, capture_output=True, text=True,
            timeout=CALL_TIMEOUT, check=False)
    except subprocess.TimeoutExpired:
        return False, ("Hermes took too long to respond and the request timed "
                       "out. Please try again.")
    except FileNotFoundError:
        return False, "The Hermes CLI is not installed on this host."
    except Exception as e:                                    # noqa: BLE001
        return False, f"Could not reach Hermes: {e}"

    out = (proc.stdout or "").strip()
    if proc.returncode != 0:
        # Surface the CLI's own diagnostic (e.g. no provider configured),
        # trimmed, rather than a bare 500.
        detail = (proc.stderr or "").strip().splitlines()
        hint = detail[-1] if detail else "unknown error"
        return False, f"Hermes could not complete that: {hint}"
    if not out:
        return False, "Hermes returned an empty response."
    return True, out


# ----------------------------------------------------------------- API -----

def history(user: dict) -> tuple[int, dict]:
    """Recent transcript for the signed-in user, oldest first."""
    conn = _bind_db()
    _ensure_table(conn)
    rows = db_module.rows(
        conn,
        "SELECT * FROM (SELECT * FROM hermes_chat WHERE user_id = ? "
        "               ORDER BY id DESC LIMIT ?) ORDER BY id ASC",
        (user["id"], HISTORY_LIMIT))
    return 200, {"messages": [_msg_dto(r) for r in rows]}


def chat(user: dict, message) -> tuple[int, dict]:
    """Persist the user's message, ask Hermes, persist and return the reply."""
    text = (message or "").strip() if isinstance(message, str) else ""
    if not text:
        return 400, {"error": "a message is required"}
    if len(text) > MAX_MESSAGE:
        return 400, {"error": f"message must be {MAX_MESSAGE} characters or fewer"}

    conn = _bind_db()
    _ensure_table(conn)
    session = _session_name(user["id"])

    db_module.insert(conn, "hermes_chat",
                     {"user_id": user["id"], "role": "user", "content": text})

    with _lock_for(session):
        ok, reply = _run_hermes(text, session)

    row_id = db_module.insert(
        conn, "hermes_chat",
        {"user_id": user["id"], "role": "hermes", "content": reply})

    return 200, {"ok": ok, "reply": reply, "message": {
        "id": row_id, "role": "hermes", "content": reply}}
