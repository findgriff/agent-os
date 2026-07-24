"""Unit tests for Max Gleam invoicing — the DB-free money logic.

Everything under test here is pure (dict/scalar in, value out), so it is pinned
without standing up the (separate, absent-in-this-suite) maxgleam database — the
same split the GPS suite uses; nothing here calls ``_conn()``. Coverage:

  * ``_invoice_amount``  — which price a job bills at (property vs job vs first clean)
  * ``_invoice_dto``     — the balance view: paid / outstanding / overdue / partial
  * ``_outstanding``     — pence still owed on a fetched invoice row
  * ``_stage_due`` / ``_days_overdue`` — which reminder an overdue invoice has reached
  * ``_reminder_body``   — the chase text bills the balance, not the gross
  * ``_month_bounds``    — the tax-report month range maths
"""
from server import maxgleam_invoicing as inv


DAY = 86400


def test_property_price_wins_for_a_recurring_job():
    # Recurring jobs copy the property price onto the job, so both agree; the
    # property (contracted) rate is authoritative.
    assert inv._invoice_amount(
        {"job_price": 2000, "property_price": 2000, "job_notes": "Regular clean"}
    ) == 2000


def test_property_price_wins_even_when_job_price_differs():
    # A normal job priced below the property's standing rate still bills the
    # contracted rate — this is the intentional behaviour the fix must preserve.
    assert inv._invoice_amount(
        {"job_price": 1500, "property_price": 2000, "job_notes": ""}
    ) == 2000


def test_first_clean_uses_its_own_higher_price():
    # The bug this fix closes: a £45 first clean was billed the £20 recurring
    # rate. The "First clean" notes marker (set by convert_quote) selects the
    # job's own price.
    assert inv._invoice_amount(
        {"job_price": 4500, "property_price": 2000,
         "job_notes": "First clean (from quote)"}
    ) == 4500


def test_ad_hoc_job_falls_back_to_job_price():
    # A property with no standing price (ad-hoc work) bills the job's price
    # rather than £0.
    assert inv._invoice_amount(
        {"job_price": 3000, "property_price": 0, "job_notes": ""}
    ) == 3000


def test_first_clean_without_a_job_price_still_falls_back():
    # Defensive: a first clean with no price recorded must not return 0 when the
    # property has a rate — the marker only redirects when a job price exists.
    assert inv._invoice_amount(
        {"job_price": 0, "property_price": 2000,
         "job_notes": "First clean (from quote)"}
    ) == 2000


def test_missing_keys_default_to_zero():
    assert inv._invoice_amount({}) == 0


# ── _invoice_dto: the balance view ──────────────────────────────────
#
# Money display for one invoice. The invoices table only stores
# unpaid/partial/paid/void; 'overdue' and 'partial' are derived here, and the
# outstanding balance is the gross less whatever the payment ledger has taken.

NOW = 1_700_000_000  # a fixed "now" so overdue maths is deterministic


def _row(**over):
    """A fetched invoice row with sensible defaults; override per test."""
    base = {"amount_pence": 2000, "vat_pence": 0, "status": "unpaid",
            "issued_at": NOW, "ledger_paid": 0}
    base.update(over)
    return base


def test_dto_unpaid_recent_owes_the_full_gross():
    d = inv._invoice_dto(_row(), NOW)
    assert d["paid_pence"] == 0
    assert d["outstanding_pence"] == 2000
    assert d["is_overdue"] is False
    assert d["display_status"] == "unpaid"


def test_dto_paid_owes_nothing():
    d = inv._invoice_dto(_row(status="paid"), NOW)
    assert d["paid_pence"] == 2000
    assert d["outstanding_pence"] == 0
    assert d["display_status"] == "paid"


def test_dto_void_owes_nothing_and_counts_no_payment():
    # A cancelled invoice is neither owed nor received — void must not leak into
    # paid totals.
    d = inv._invoice_dto(_row(status="void"), NOW)
    assert d["paid_pence"] == 0
    assert d["outstanding_pence"] == 0
    assert d["display_status"] == "void"


def test_dto_part_paid_shows_partial_and_remaining_balance():
    d = inv._invoice_dto(_row(ledger_paid=1200), NOW)
    assert d["paid_pence"] == 1200
    assert d["outstanding_pence"] == 800
    assert d["display_status"] == "partial"
    assert d["is_overdue"] is False


def test_dto_ledger_overpay_is_clamped_to_the_gross():
    # A ledger total above the invoice gross (double-keyed payment, say) must
    # never report negative outstanding or paid > gross.
    d = inv._invoice_dto(_row(ledger_paid=5000), NOW)
    assert d["paid_pence"] == 2000
    assert d["outstanding_pence"] == 0


def test_dto_unpaid_past_threshold_is_overdue():
    d = inv._invoice_dto(_row(issued_at=NOW - 31 * DAY), NOW)
    assert d["is_overdue"] is True
    assert d["display_status"] == "overdue"
    assert d["days_outstanding"] == 31


def test_dto_overdue_wins_over_partial_in_the_label():
    # A part-paid invoice that is also past the threshold reads 'overdue', not
    # 'partial' — the more urgent state is the one surfaced.
    d = inv._invoice_dto(_row(ledger_paid=500, issued_at=NOW - 45 * DAY), NOW)
    assert d["is_overdue"] is True
    assert d["outstanding_pence"] == 1500
    assert d["display_status"] == "overdue"


def test_dto_net_is_gross_less_vat():
    d = inv._invoice_dto(_row(amount_pence=2400, vat_pence=400), NOW)
    assert d["net_pence"] == 2000


# ── _outstanding: pence still owed ──────────────────────────────────


def test_outstanding_zero_for_paid_and_void():
    assert inv._outstanding({"status": "paid", "amount_pence": 2000, "ledger_paid": 0}) == 0
    assert inv._outstanding({"status": "void", "amount_pence": 2000, "ledger_paid": 0}) == 0


def test_outstanding_is_gross_less_ledger():
    assert inv._outstanding({"status": "unpaid", "amount_pence": 2000, "ledger_paid": 750}) == 1250


def test_outstanding_never_negative():
    assert inv._outstanding({"status": "partial", "amount_pence": 2000, "ledger_paid": 9999}) == 0


# ── _stage_due / _days_overdue: reminder targeting ──────────────────
#
# Two nudges at 30 and 60 days. _stage_due returns the *highest* stage reached
# so an invoice already 65 days old when the feature switches on gets the 60-day
# message, not a stale 30-day one.


def test_stage_due_none_before_first_stage():
    assert inv._stage_due(0) is None
    assert inv._stage_due(29) is None


def test_stage_due_thirty_day_band():
    assert inv._stage_due(30) == 30
    assert inv._stage_due(59) == 30


def test_stage_due_sixty_day_band_takes_the_highest():
    assert inv._stage_due(60) == 60
    assert inv._stage_due(200) == 60


def test_days_overdue_zero_without_issue_date():
    assert inv._days_overdue({}, NOW) == 0
    assert inv._days_overdue({"issued_at": None}, NOW) == 0


def test_days_overdue_never_negative_for_a_future_issue_date():
    assert inv._days_overdue({"issued_at": NOW + 5 * DAY}, NOW) == 0


def test_days_overdue_counts_whole_days_elapsed():
    assert inv._days_overdue({"issued_at": NOW - 45 * DAY}, NOW) == 45


# ── _reminder_body: chase the balance, not the gross ────────────────


def test_reminder_body_uses_outstanding_balance_when_present():
    # A customer who part-paid must be chased for what's left, never the gross.
    body = inv._reminder_body(
        {"customer_name": "Jane Smith", "number": "INV-2026-0007",
         "amount_pence": 2000, "outstanding_pence": 800}, "https://pay/x")
    assert "£8.00" in body
    assert "£20.00" not in body
    assert "Jane" in body and "Smith" not in body   # first name only
    assert "INV-2026-0007" in body
    assert "https://pay/x" in body


def test_reminder_body_falls_back_to_gross_without_a_ledger_view():
    body = inv._reminder_body(
        {"customer_name": "Jo", "number": "INV-1", "amount_pence": 2000}, "L")
    assert "£20.00" in body


def test_reminder_body_greets_there_when_name_missing():
    body = inv._reminder_body({"number": "INV-1", "amount_pence": 1000}, "L")
    assert body.startswith("Hi there,")


# ── _month_bounds: tax-report range ─────────────────────────────────


def test_month_bounds_reports_the_requested_span():
    _s, _e, frm, to = inv._month_bounds("2026-01", "2026-03")
    assert (frm, to) == ("2026-01", "2026-03")


def test_month_bounds_upper_bound_is_exclusive_first_of_next_month():
    import datetime as dt
    start_ts, end_ts, _f, _t = inv._month_bounds("2026-01", "2026-03")
    # end is exclusive: the first instant of April, so a 31 Mar invoice is in
    # range but a 1 Apr one is not.
    assert dt.datetime.fromtimestamp(end_ts) == dt.datetime(2026, 4, 1)
    assert dt.datetime.fromtimestamp(start_ts) == dt.datetime(2026, 1, 1)


def test_month_bounds_swaps_a_reversed_range():
    _s, _e, frm, to = inv._month_bounds("2026-06", "2026-02")
    assert (frm, to) == ("2026-02", "2026-06")
