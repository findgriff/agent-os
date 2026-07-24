"""Lifecycle tests for the crew time clock — the stateful clock-in/out path.

The GPS suite pins the DB-free maths; this file covers the part that mutates:
clock_in / clock_out over the time_logs table. That is where the one-open-log
guarantee, the jobs.started_at mirror, and the tenant boundary on a raw log_id
live — none of it was exercised before.

Hermetic like the rest of the suite: each test stands up its own throwaway
maxgleam-shaped SQLite DB (faithful to the live time_logs / subcontractors DDL)
and points server.partner._conn at it, so the live maxgleam database is never
touched. activity.log is stubbed — the feed is covered elsewhere and needs its
own tables; here it would only be noise.
"""
import sqlite3

import pytest

from server import partner
from server import maxgleam_reports as reports


# Faithful to the live DDL; only the columns the clock code reads are modelled.
# Two tenants so the cross-tenant log_id guard has something to cross.
_SCHEMA = """
CREATE TABLE tenants(id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE customers(id INTEGER PRIMARY KEY, tenant_id INT, name TEXT);
CREATE TABLE properties(id INTEGER PRIMARY KEY, tenant_id INT, customer_id INT,
  address TEXT, postcode TEXT, position INT, partner_company_id INT);
CREATE TABLE jobs(id INTEGER PRIMARY KEY, tenant_id INT, property_id INT,
  scheduled_date TEXT, status TEXT, price_pence INT, subcontractor_id INT,
  started_at INT, completed_at INT, partner_company_id INT);
CREATE TABLE subcontractors(id INTEGER PRIMARY KEY, tenant_id INT NOT NULL,
  name TEXT NOT NULL, company_name TEXT, active INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active');
CREATE TABLE time_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INT REFERENCES jobs(id), subcontractor_id INT REFERENCES subcontractors(id),
  clock_in INT NOT NULL, clock_out INT, total_minutes INT, notes TEXT,
  created_at INT NOT NULL DEFAULT 0);

INSERT INTO tenants(id,name) VALUES(2,'CWC'),(3,'Rival');
INSERT INTO customers(id,tenant_id,name) VALUES(10,2,'Jane');
INSERT INTO properties(id,tenant_id,customer_id,address,position)
  VALUES(20,2,10,'12 Hoole Rd',1);
INSERT INTO jobs(id,tenant_id,property_id,scheduled_date,status,price_pence,subcontractor_id)
  VALUES(30,2,20,'2026-07-24','scheduled',2500,100);
-- Crew 100 belongs to our tenant (2); crew 999 belongs to the rival (3).
INSERT INTO subcontractors(id,tenant_id,name) VALUES(100,2,'Sam'),(999,3,'Mallory');
"""

TID = 2


@pytest.fixture
def db(monkeypatch):
    """A fresh in-memory maxgleam DB wired into the reports module.

    reports._conn() delegates to partner._conn(), so patching partner is enough.
    activity.log() writes to tables this schema does not model — stub it, as the
    clock path's return value, not the audit trail, is what these tests pin.
    """
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA)
    conn.commit()
    monkeypatch.setattr(partner, "_conn", lambda: conn)
    monkeypatch.setattr(reports.activity, "log", lambda *a, **k: None)
    return conn


# ── clock_in ────────────────────────────────────────────────────────────

def test_clock_in_opens_a_log_and_mirrors_started_at(db):
    status, body = reports.clock_in({"crew_id": 100, "job_id": 30}, TID)
    assert status == 200
    log = body["log"]
    assert log["job_id"] == 30 and log["subcontractor_id"] == 100
    assert log["clock_out"] is None and log["open"] is True
    # The row is really there, and the job now reads as started.
    assert db.execute("SELECT COUNT(*) FROM time_logs WHERE clock_out IS NULL").fetchone()[0] == 1
    assert db.execute("SELECT started_at FROM jobs WHERE id=30").fetchone()[0] is not None


def test_clock_in_without_a_job_is_general_duties(db):
    status, body = reports.clock_in({"crew_id": 100}, TID)
    assert status == 200
    assert body["log"]["job_id"] is None


def test_clock_in_requires_a_crew_id(db):
    status, body = reports.clock_in({}, TID)
    assert status == 400 and "crew_id" in body["error"]


def test_clock_in_unknown_crew_is_404(db):
    status, _ = reports.clock_in({"crew_id": 12345}, TID)
    assert status == 404


def test_clock_in_crew_from_another_tenant_is_404(db):
    # Crew 999 exists, but not in this tenant — the scope must hide it.
    status, _ = reports.clock_in({"crew_id": 999}, TID)
    assert status == 404


def test_clock_in_unknown_job_is_404(db):
    status, _ = reports.clock_in({"crew_id": 100, "job_id": 88888}, TID)
    assert status == 404


def test_second_clock_in_is_blocked_while_one_is_open(db):
    first = reports.clock_in({"crew_id": 100, "job_id": 30}, TID)
    assert first[0] == 200
    status, body = reports.clock_in({"crew_id": 100}, TID)
    assert status == 409
    assert "clock out first" in body["error"]
    # The open log points back at the job they are still on.
    assert body["open_log"]["job_id"] == 30
    # And no second row was written.
    assert db.execute("SELECT COUNT(*) FROM time_logs").fetchone()[0] == 1


# ── clock_out ───────────────────────────────────────────────────────────

def test_clock_out_closes_the_open_log(db):
    reports.clock_in({"crew_id": 100, "job_id": 30}, TID)
    status, body = reports.clock_out({"crew_id": 100}, TID)
    assert status == 200
    assert body["log"]["clock_out"] is not None and body["log"]["open"] is False
    # A just-opened log rounds up to the 1-minute floor, never 0.
    assert body["log"]["total_minutes"] >= 1
    assert db.execute("SELECT COUNT(*) FROM time_logs WHERE clock_out IS NULL").fetchone()[0] == 0


def test_clock_out_with_no_open_log_is_404(db):
    status, _ = reports.clock_out({"crew_id": 100}, TID)
    assert status == 404


def test_clock_out_requires_crew_or_log_id(db):
    status, body = reports.clock_out({}, TID)
    assert status == 400 and "required" in body["error"]


def test_clock_in_out_cycle_lets_you_start_again(db):
    reports.clock_in({"crew_id": 100, "job_id": 30}, TID)
    reports.clock_out({"crew_id": 100}, TID)
    # With the first log closed, a fresh clock-in is allowed — no lingering 409.
    status, _ = reports.clock_in({"crew_id": 100}, TID)
    assert status == 200


def test_clock_out_by_log_id_rejects_another_tenants_log(db):
    # A rival crew (tenant 3) opens a log; that log's id must not be clockable
    # out by our tenant's caller, even though we hand the exact id.
    _, opened = reports.clock_in({"crew_id": 999}, 3)
    rival_log_id = opened["log"]["id"]
    status, _ = reports.clock_out({"log_id": rival_log_id}, TID)
    assert status == 404
    # The rival's log is untouched — still open.
    row = db.execute("SELECT clock_out FROM time_logs WHERE id=?", (rival_log_id,)).fetchone()
    assert row["clock_out"] is None


def test_clock_out_by_log_id_works_within_the_tenant(db):
    _, opened = reports.clock_in({"crew_id": 100, "job_id": 30}, TID)
    log_id = opened["log"]["id"]
    status, body = reports.clock_out({"log_id": log_id}, TID)
    assert status == 200 and body["log"]["id"] == log_id
