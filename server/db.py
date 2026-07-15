"""SQLite helpers for AGENT OS. Single database, tenant_id scoping.

Thread-local connections so ThreadingHTTPServer can fire parallel API
calls without racing on a shared cursor (same pattern as maxgleam).
"""
from __future__ import annotations
import sqlite3
import threading
from pathlib import Path

SCHEMA_PATH = Path(__file__).parent / "schema.sql"


def connect(path: str) -> sqlite3.Connection:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(SCHEMA_PATH.read_text())
    conn.commit()
    return conn


_pool = threading.local()


def get_thread_conn(db_path: str) -> sqlite3.Connection:
    """Return this thread's connection, creating one on first access."""
    conn = getattr(_pool, "conn", None)
    if conn is None:
        conn = connect(db_path)
        _pool.conn = conn
    return conn


def rows(conn, sql: str, args=()) -> list[dict]:
    return [dict(r) for r in conn.execute(sql, args).fetchall()]


def one(conn, sql: str, args=()) -> dict | None:
    r = conn.execute(sql, args).fetchone()
    return dict(r) if r else None


def insert(conn, table: str, data: dict) -> int:
    cols = ", ".join(data)
    ph = ", ".join("?" for _ in data)
    cur = conn.execute(f"INSERT INTO {table} ({cols}) VALUES ({ph})",
                       tuple(data.values()))
    conn.commit()
    return cur.lastrowid


def update(conn, table: str, row_id: int, tenant_id: int, data: dict) -> None:
    sets = ", ".join(f"{k} = ?" for k in data)
    conn.execute(f"UPDATE {table} SET {sets} WHERE id = ? AND tenant_id = ?",
                 (*data.values(), row_id, tenant_id))
    conn.commit()
