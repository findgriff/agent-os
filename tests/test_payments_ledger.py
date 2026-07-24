"""Lifecycle tests for the invoice payment ledger — the stateful money path.

test_invoicing.py pins the *pure* money logic (which price a job bills, the
balance view of a fetched row). This file covers the part that actually
mutates: record_payment / unmark_payment / settle_online, where an
append-only invoice_payments ledger drives the invoice's rolled-up status
through unpaid → partial → paid and back. That state machine is where a
double-key, a bad revert, or a lost partial payment would corrupt a
customer's balance, and none of it was exercised before.

Hermetic like the rest of the suite: each test stands up its own throwaway
maxgleam-shaped SQLite DB (faithful to the live invoices DDL) and points
server.partner._conn at it, so the live maxgleam database is never touched.
The invoice_payments / invoice_reminders tables are created lazily by the
module itself, exactly as they are in production.
"""
import sqlite3

import pytest

from server import partner
from server import maxgleam_invoicing as inv


# Faithful to the live maxgleam invoices DDL (vat_pence / items_json added by a
# later migration); only the columns the invoicing code reads are modelled.
_SCHEMA = """
CREATE TABLE tenants(id INTEGER PRIMARY KEY, name TEXT, slug TEXT, email TEXT,
  currency TEXT, settings_json TEXT, sumup_api_key TEXT, sumup_merchant_code TEXT);
CREATE TABLE customers(id INTEGER PRIMARY KEY, tenant_id INT, name TEXT, email TEXT,
  phone TEXT, tags TEXT, archived INT DEFAULT 0, notes TEXT);
CREATE TABLE properties(id INTEGER PRIMARY KEY, tenant_id INT, customer_id INT,
  address TEXT, postcode TEXT, price_pence INT, frequency_weeks INT,
  access_notes TEXT, partner_company_id INT);
CREATE TABLE jobs(id INTEGER PRIMARY KEY, tenant_id INT, property_id INT,
  scheduled_date TEXT, status TEXT, price_pence INT, notes TEXT,
  completed_at INT, signoff_status TEXT, partner_company_id INT);
CREATE TABLE invoices(id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INT NOT NULL,
  customer_id INT NOT NULL, job_id INT, number TEXT NOT NULL, amount_pence INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unpaid', method TEXT, sumup_checkout_id TEXT,
  sumup_checkout_url TEXT, issued_at INT NOT NULL DEFAULT 0, paid_at INT,
  vat_pence INT NOT NULL DEFAULT 0, items_json TEXT NOT NULL DEFAULT '[]');
CREATE TABLE comms_log(id INTEGER PRIMARY KEY, tenant_id INT, customer_id INT,
  kind TEXT, content TEXT);
INSERT INTO tenants(id,name,slug,email,currency,settings_json)
  VALUES(2,'CWC','cwc','a@b.c','GBP','{}');
INSERT INTO customers(id,tenant_id,name,email) VALUES(10,2,'Jane','jane@e.com');
INSERT INTO properties(id,tenant_id,customer_id,address,partner_company_id)
  VALUES(20,2,10,'12 Hoole Rd',NULL);
INSERT INTO jobs(id,tenant_id,property_id,status) VALUES(30,2,20,'done');
"""

TID = 2


@pytest.fixture
def db(monkeypatch):
    """A fresh in-memory maxgleam DB wired into the invoicing module.

    The module caches "ledger table exists" in thread-locals; those are reset
    so a fresh DB (with no tables yet) doesn't skip lazy creation.
    """
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA)
    conn.commit()
    monkeypatch.setattr(partner, "_conn", lambda: conn)
    monkeypatch.setattr(inv._payments_local, "ready", False, raising=False)
    monkeypatch.setattr(inv._reminder_local, "ready", False, raising=False)
    return conn


def _invoice(db, iid=1, amount=5000, status="unpaid", **cols):
    fields = {"id": iid, "tenant_id": TID, "customer_id": 10, "job_id": 30,
              "number": f"INV-2026-{iid:04d}", "amount_pence": amount,
              "status": status, "issued_at": 1_700_000_000, **cols}
    keys = ",".join(fields)
    db.execute(f"INSERT INTO invoices({keys}) VALUES({','.join('?' * len(fields))})",
               tuple(fields.values()))
    db.commit()
    return iid


def _state(iid=1):
    _c, r = inv.payment_history(iid, tenant_id=TID)
    return (r["invoice"]["status"], r["paid_pence"], r["outstanding_pence"],
            len(r["payments"]))


# ── record_payment: partial → full ──────────────────────────────────

def test_partial_then_full_settles_via_ledger(db):
    _invoice(db, amount=5000)
    code, r = inv.record_payment(1, "cash", 2000, tenant_id=TID)
    assert code == 200
    assert _state() == ("partial", 2000, 3000, 1)
    # Amount omitted settles whatever is outstanding.
    code, r = inv.record_payment(1, "transfer", tenant_id=TID)
    assert code == 200
    assert _state() == ("paid", 5000, 0, 2)
    assert r["invoice"]["method"] == "transfer"


def test_full_payment_with_amount_omitted(db):
    _invoice(db, amount=4500)
    code, r = inv.record_payment(1, "cash", tenant_id=TID)
    assert code == 200
    assert _state() == ("paid", 4500, 0, 1)


def test_overpayment_is_refused(db):
    _invoice(db, amount=5000)
    code, r = inv.record_payment(1, "cash", 9999, tenant_id=TID)
    assert code == 400 and "outstanding" in r["error"]
    assert _state() == ("unpaid", 0, 5000, 0)     # nothing recorded


def test_zero_or_negative_amount_refused(db):
    _invoice(db, amount=5000)
    assert inv.record_payment(1, "cash", 0, tenant_id=TID)[0] == 400
    assert inv.record_payment(1, "cash", -100, tenant_id=TID)[0] == 400


def test_paying_an_already_paid_invoice_is_refused(db):
    _invoice(db, amount=5000)
    inv.record_payment(1, "cash", tenant_id=TID)
    code, r = inv.record_payment(1, "cash", tenant_id=TID)
    assert code == 409 and "already paid" in r["error"]


def test_unknown_method_refused(db):
    _invoice(db, amount=5000)
    code, r = inv.record_payment(1, "bitcoin", tenant_id=TID)
    assert code == 400 and "method must be" in r["error"]


def test_void_invoice_cannot_take_payment(db):
    _invoice(db, amount=5000, status="void")
    code, r = inv.record_payment(1, "cash", tenant_id=TID)
    assert code == 409 and "cancelled" in r["error"]


# ── unmark_payment: reversing keyed-in mistakes ─────────────────────

def test_unmark_walks_back_partial_then_to_unpaid(db):
    _invoice(db, amount=5000)
    inv.record_payment(1, "cash", 2000, tenant_id=TID)
    inv.record_payment(1, "transfer", tenant_id=TID)     # now paid, 2 ledger rows
    assert _state() == ("paid", 5000, 0, 2)
    assert inv.unmark_payment(1, tenant_id=TID)[0] == 200
    assert _state() == ("partial", 2000, 3000, 1)        # transfer removed
    assert inv.unmark_payment(1, tenant_id=TID)[0] == 200
    assert _state() == ("unpaid", 0, 5000, 0)            # cash removed


def test_unmark_with_nothing_to_reverse(db):
    _invoice(db, amount=5000)
    code, r = inv.unmark_payment(1, tenant_id=TID)
    assert code == 409 and "no recorded payment" in r["error"]


def test_unmark_reverts_legacy_full_mark_without_ledger_rows(db):
    # A pre-ledger invoice marked paid directly (no invoice_payments rows) still
    # reverts wholesale to unpaid.
    _invoice(db, amount=5000, status="paid", method="cash", paid_at=1_700_000_500)
    code, r = inv.unmark_payment(1, tenant_id=TID)
    assert code == 200
    assert _state() == ("unpaid", 0, 5000, 0)


# ── settle_online: the SumUp reconcile write ────────────────────────

def test_settle_online_pays_in_full_and_is_idempotent(db):
    _invoice(db, amount=3000)
    assert inv.settle_online(1, tenant_id=TID) is True
    assert _state() == ("paid", 3000, 0, 1)
    # A second settle (concurrent portal sync + cron) is a no-op.
    assert inv.settle_online(1, tenant_id=TID) is False


def test_settle_online_only_bills_the_remainder_of_a_partial(db):
    _invoice(db, amount=5000)
    inv.record_payment(1, "cash", 2000, tenant_id=TID)     # £20 offline
    assert inv.settle_online(1, tenant_id=TID) is True
    # Ledger holds the £20 cash + the £30 online remainder, not a double £50.
    assert _state() == ("paid", 5000, 0, 2)


def test_online_payment_cannot_be_unmarked(db):
    _invoice(db, amount=3000)
    inv.settle_online(1, tenant_id=TID)
    code, r = inv.unmark_payment(1, tenant_id=TID)
    assert code == 409 and "online card payment" in r["error"]


# ── partner scoping ─────────────────────────────────────────────────

def test_partner_cannot_touch_another_companys_invoice(db):
    # The invoice's property has partner_company_id NULL, so a partner token
    # scoped to company 999 must not see it.
    _invoice(db, amount=5000)
    assert inv.record_payment(1, "cash", tenant_id=TID, company_id=999)[0] == 404
    assert inv.unmark_payment(1, tenant_id=TID, company_id=999)[0] == 404
    assert inv.payment_history(1, tenant_id=TID, company_id=999)[0] == 404
