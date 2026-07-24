"""Unit tests for Max Gleam invoice-amount selection.

`_invoice_amount` is pure (dict in, pence out) so it is pinned here without a
DB — the same split used by the GPS suite. The rule under test: the property's
standing contracted rate wins, EXCEPT for a first clean booked from a quote,
which carries its own one-off price and must not be silently under-billed at
the recurring rate.
"""
from server import maxgleam_invoicing as inv


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
