"""Unit tests for the GPS prune-verify cron's end-state reasoning.

Exercises the DB-free verdict helper — does a retention_status() report read as
a clean prune or a failing one — without a log file or a database. The status
input is built with maxgleam_gps._retention_report, so these also pin the shape
contract between the module that produces the report and the cron that reads it.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))

import maxgleam_gps_prune_verify as verify  # noqa: E402
from server import maxgleam_gps as gps       # noqa: E402

_DAY = 86400
_NOW = 100 * _DAY


def test_end_state_passes_on_clean_report():
    status = gps._retention_report(now=_NOW, count=42, oldest=_NOW - 2 * _DAY,
                                   newest=_NOW, stale=0)
    ok, msg = verify._end_state_verdict(status)
    assert ok is True
    assert "clean" in msg
    assert "42 points" in msg


def test_end_state_fails_when_stale_points_survive():
    # A point older than the window remains → the prune ran but did not achieve
    # retention; the cron must FAIL so it surfaces.
    status = gps._retention_report(now=_NOW, count=42, oldest=_NOW - 30 * _DAY,
                                   newest=_NOW, stale=5)
    ok, msg = verify._end_state_verdict(status)
    assert ok is False
    assert "5 points older than" in msg
    assert "survive the prune" in msg


def test_end_state_empty_log_is_clean():
    # Nothing logged at all is a healthy end-state, not a failure.
    status = gps._retention_report(now=_NOW, count=0, oldest=None,
                                   newest=None, stale=0)
    ok, _ = verify._end_state_verdict(status)
    assert ok is True
