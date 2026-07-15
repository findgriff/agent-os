"""Auth for AGENT OS: email + password → opaque bearer session (30 days).

Passwords are PBKDF2-HMAC-SHA256 (stdlib only), stored as
`pbkdf2$<iterations>$<salt_hex>$<hash_hex>`. Same hashing scheme as
maxgleam, so users copied from the maxgleam DB can sign in unchanged.
"""
from __future__ import annotations
import hashlib
import hmac
import re
import secrets
import time

from server import db as db_module

SESSION_TTL = 30 * 24 * 3600
PBKDF2_ITERATIONS = 600_000
MIN_PASSWORD_LEN = 8
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def valid_email(email: str) -> bool:
    return bool(EMAIL_RE.match(email or ""))


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(),
                                 bytes.fromhex(salt), PBKDF2_ITERATIONS)
    return f"pbkdf2${PBKDF2_ITERATIONS}${salt}${digest.hex()}"


def verify_password(password: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        scheme, iters, salt, expected = stored.split("$")
        if scheme != "pbkdf2":
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(),
                                     bytes.fromhex(salt), int(iters))
        return hmac.compare_digest(digest.hex(), expected)
    except (ValueError, TypeError):
        return False


def create_session(conn, user_id: int) -> str:
    session = secrets.token_urlsafe(32)
    db_module.insert(conn, "sessions", {
        "token": session, "user_id": user_id,
        "expires_at": int(time.time()) + SESSION_TTL,
    })
    return session


def user_for_session(conn, bearer: str) -> dict | None:
    if not bearer:
        return None
    return db_module.one(conn,
        "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
        "WHERE s.token = ? AND s.expires_at > strftime('%s','now')", (bearer,))
