"""Unit tests for the Max Gleam GPS module's pure logic.

These exercise the DB-free core — coordinate cleaning, great-circle distance,
and the geofence — so the correctness-critical maths is pinned without standing
up the (separate, absent-in-this-suite) maxgleam database. Anything that opens a
connection lives in the endpoint suite instead; nothing here calls ``_conn()``.
"""
from server import maxgleam_gps as gps


# ── haversine_m ─────────────────────────────────────────────────────

def test_haversine_zero_for_same_point():
    assert gps.haversine_m(51.5, -0.1, 51.5, -0.1) == 0.0


def test_haversine_one_degree_latitude():
    # One degree of latitude is ~111.2 km everywhere; a good anchor because it
    # is independent of longitude. Tolerant to a few metres of rounding.
    assert abs(gps.haversine_m(0.0, 0.0, 1.0, 0.0) - 111195) < 5


def test_haversine_is_symmetric():
    there = gps.haversine_m(51.50, -0.10, 51.52, -0.12)
    back = gps.haversine_m(51.52, -0.12, 51.50, -0.10)
    assert abs(there - back) < 1e-6


# ── _clean_coords ───────────────────────────────────────────────────

def test_clean_coords_accepts_floats():
    assert gps._clean_coords({"lat": 51.5, "lng": -0.12}) == (51.5, -0.12)


def test_clean_coords_coerces_strings():
    # A phone posting JSON may hand us the fix as strings; float() bridges it.
    assert gps._clean_coords({"lat": "51.5", "lng": "-0.12"}) == (51.5, -0.12)


def test_clean_coords_rejects_missing():
    assert gps._clean_coords({}) is None
    assert gps._clean_coords({"lat": 51.5}) is None


def test_clean_coords_rejects_non_numeric():
    assert gps._clean_coords({"lat": "north", "lng": "west"}) is None
    assert gps._clean_coords({"lat": None, "lng": None}) is None


def test_clean_coords_rejects_out_of_range():
    assert gps._clean_coords({"lat": 91.0, "lng": 0.0}) is None
    assert gps._clean_coords({"lat": 0.0, "lng": 181.0}) is None


# ── _geofence ───────────────────────────────────────────────────────

def _pos(lat, lng):
    return {"lat": lat, "lng": lng, "timestamp": 0, "job_id": 1}


def test_geofence_none_without_position_or_job():
    job = {"latitude": 51.5, "longitude": -0.1}
    assert gps._geofence(None, job) is None
    assert gps._geofence(_pos(51.5, -0.1), None) is None


def test_geofence_none_when_stop_never_geocoded():
    # A property with no lat/lng can't be measured against — surface that as
    # "unknowable" rather than a bogus distance.
    assert gps._geofence(_pos(51.5, -0.1), {"latitude": None, "longitude": None}) is None


def test_geofence_on_site_within_radius():
    # ~100 m north of the stop (100 / 111195 deg of latitude) is inside the
    # 150 m fence.
    job = {"latitude": 51.5, "longitude": -0.1}
    fence = gps._geofence(_pos(51.5 + 0.0009, -0.1), job)
    assert fence["on_site"] is True
    assert 90 <= fence["distance_m"] <= 110


def test_geofence_off_site_beyond_radius():
    # ~280 m north is outside the fence — the signal the office wants when a
    # crew reports from the wrong street.
    job = {"latitude": 51.5, "longitude": -0.1}
    fence = gps._geofence(_pos(51.5 + 0.0025, -0.1), job)
    assert fence["on_site"] is False
    assert fence["distance_m"] > gps.GEOFENCE_M


# ── _on_site_seconds ────────────────────────────────────────────────

def test_on_site_seconds_none_without_start():
    assert gps._on_site_seconds(None, 1000) is None
    assert gps._on_site_seconds({"started_at": None}, 1000) is None


def test_on_site_seconds_counts_from_start():
    assert gps._on_site_seconds({"started_at": 1000}, 1600) == 600


def test_on_site_seconds_never_negative():
    # Clock skew (a fix stamped before the recorded start) must not read as a
    # negative dwell time.
    assert gps._on_site_seconds({"started_at": 2000}, 1000) == 0


# ── _retention_report ───────────────────────────────────────────────

_DAY = 86400


def test_retention_report_empty_log_is_healthy():
    # No points at all — nothing stale, so the prune has nothing to answer for.
    r = gps._retention_report(now=10 * _DAY, count=0, oldest=None, newest=None, stale=0)
    assert r["points"] == 0
    assert r["oldest"] is None
    assert r["oldest_age_days"] is None
    assert r["healthy"] is True


def test_retention_report_within_window_is_healthy():
    now = 100 * _DAY
    r = gps._retention_report(now=now, count=50, oldest=now - 3 * _DAY,
                              newest=now, stale=0)
    assert r["oldest_age_days"] == 3.0
    assert r["retention_days"] == gps.RETENTION_DAYS
    assert r["cutoff"] == now - gps.RETENTION_DAYS * _DAY
    assert r["healthy"] is True


def test_retention_report_stale_points_are_unhealthy():
    # A point older than the window survives → the cron has been skipped or is
    # failing, and the office must see that.
    now = 100 * _DAY
    r = gps._retention_report(now=now, count=50, oldest=now - 20 * _DAY,
                              newest=now, stale=4)
    assert r["oldest_age_days"] == 20.0
    assert r["stale_points"] == 4
    assert r["healthy"] is False
