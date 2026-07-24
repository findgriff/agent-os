"""KS coach session lifecycle — a deactivated coach must lose access at once.

coach_login already refuses inactive coaches, but the bug this guards is the
already-issued token: session_subject must re-check `active` so deactivating a
coach revokes their live session instead of leaving the dashboard open until
the 30-day token TTL expires.

Hermetic: points ks at a throwaway DB and forces a clean schema init, so the
live KS database (/var/lib/ks-bot/bookings.db) is never touched.
"""
import pytest

from server import ks as ksmod


@pytest.fixture
def ks(tmp_path):
    ksmod.DB_PATH = str(tmp_path / "ks-test.db")
    ksmod._pool.ks_conn = None
    ksmod._initialised = False
    try:
        yield ksmod
    finally:
        conn = getattr(ksmod._pool, "ks_conn", None)
        if conn is not None:
            conn.close()
        ksmod._pool.ks_conn = None
        ksmod._initialised = False


def _make_coach(ks, active=1):
    conn = ks._conn()  # triggers schema + seed on first use
    cur = conn.execute(
        "INSERT INTO coaches (slug, name, bio, active) VALUES (?,?,?,?)",
        ("test-coach", "Test Coach", "bio", active))
    conn.commit()
    return cur.lastrowid


def test_active_coach_session_resolves(ks):
    coach_id = _make_coach(ks)
    token = ks._session_create("coach", coach_id)
    subj = ks.session_subject(token, "coach")
    assert subj is not None and subj["id"] == coach_id


def test_deactivated_coach_token_is_revoked(ks):
    coach_id = _make_coach(ks)
    token = ks._session_create("coach", coach_id)
    # Sanity: valid while active.
    assert ks.session_subject(token, "coach") is not None
    # Deactivate the coach — the existing token must stop resolving.
    conn = ks._conn()
    conn.execute("UPDATE coaches SET active = 0 WHERE id = ?", (coach_id,))
    conn.commit()
    assert ks.session_subject(token, "coach") is None


def test_wrong_kind_never_crosses_over(ks):
    """A coach token must not resolve when asked for as a parent (and the
    parent branch keeps working with no `active` filter injected)."""
    coach_id = _make_coach(ks)
    token = ks._session_create("coach", coach_id)
    assert ks.session_subject(token, "parent") is None
