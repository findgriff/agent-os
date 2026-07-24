"""Unit tests for the Max Gleam GPS module's pure logic.

These exercise the DB-free core — coordinate cleaning, great-circle distance,
and the geofence — so the correctness-critical maths is pinned without standing
up the (separate, absent-in-this-suite) maxgleam database. Anything that opens a
connection lives in the endpoint suite instead; nothing here calls ``_conn()``.
"""
import math

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


# ── _route_distance_m ───────────────────────────────────────────────

def _pt(lat, lng):
    return {"lat": lat, "lng": lng}


def test_route_distance_zero_for_empty_or_single():
    # Nowhere to travel to from no fixes, or from just one.
    assert gps._route_distance_m([]) == 0
    assert gps._route_distance_m([_pt(51.5, -0.1)]) == 0


def test_route_distance_sums_legs():
    # Two ~1-degree-latitude legs north (~111.2 km each) total ~222.4 km.
    pts = [_pt(0.0, 0.0), _pt(1.0, 0.0), _pt(2.0, 0.0)]
    assert abs(gps._route_distance_m(pts) - 2 * 111195) < 20


def test_route_distance_matches_single_haversine_leg():
    # A one-leg route is exactly its haversine — the helper adds nothing.
    a, b = _pt(51.50, -0.10), _pt(51.52, -0.12)
    assert abs(gps._route_distance_m([a, b])
               - gps.haversine_m(51.50, -0.10, 51.52, -0.12)) < 1e-9


# ── _bearing ────────────────────────────────────────────────────────

def test_bearing_cardinal_directions():
    # Small steps from a base point so the initial bearing reads cleanly.
    base = (51.5, -0.1)
    assert abs(gps._bearing(*base, 51.6, -0.1) - 0) < 1      # due north
    assert abs(gps._bearing(*base, 51.5, 0.0) - 90) < 1      # due east
    assert abs(gps._bearing(*base, 51.4, -0.1) - 180) < 1    # due south
    assert abs(gps._bearing(*base, 51.5, -0.2) - 270) < 1    # due west


# ── _movement ───────────────────────────────────────────────────────

def _mpt(lat, lng, ts):
    return {"lat": lat, "lng": lng, "timestamp": ts, "job_id": 1}


def test_movement_none_without_two_fixes():
    assert gps._movement(None, _mpt(51.5, -0.1, 100)) is None
    assert gps._movement(_mpt(51.5, -0.1, 100), None) is None


def test_movement_none_when_out_of_order():
    # last no newer than prev — can't derive a speed, don't invent one.
    prev = _mpt(51.5, -0.1, 200)
    last = _mpt(51.6, -0.1, 200)
    assert gps._movement(prev, last) is None
    assert gps._movement(prev, _mpt(51.6, -0.1, 100)) is None


def test_movement_none_when_gap_too_large():
    # Two fixes MOVEMENT_MAX_GAP + apart: the crew was offline between them, so
    # the average speed says nothing about now.
    prev = _mpt(51.5, -0.1, 0)
    last = _mpt(51.51, -0.1, gps.MOVEMENT_MAX_GAP + 1)
    assert gps._movement(prev, last) is None


def test_movement_parked_jitter_reads_as_stopped():
    # ~3 m of wander over 20 s (~0.3 mph) is a parked phone, not a moving van.
    prev = _mpt(51.5, -0.1, 1000)
    last = _mpt(51.50003, -0.1, 1020)
    m = gps._movement(prev, last)
    assert m["moving"] is False
    assert m["speed_mph"] < gps.MOVING_MPH


def test_movement_driving_reports_speed_and_heading():
    # ~200 m east over 20 s ≈ 22 mph, heading ~90°.
    prev = _mpt(51.5, -0.1, 1000)
    last = _mpt(51.5, -0.1 + 200 / (111320 * math.cos(math.radians(51.5))), 1020)
    m = gps._movement(prev, last)
    assert m["moving"] is True
    assert 20 <= m["speed_mph"] <= 25
    assert 80 <= m["heading"] <= 100
