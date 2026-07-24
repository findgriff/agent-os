"""Structural tests for the invoice PDF — the hand-rolled byte format.

The platform has no reportlab/wkhtmltopdf, so server.pdf writes a PDF by hand:
a content stream wrapped in catalog/pages/page/contents/fonts objects, with a
cross-reference table of byte offsets and a /Length that must equal the stream
size exactly. Get any of those wrong and the file opens as corrupt for the
customer — but every render still *looks* like bytes, so a plain "it returned
something" check misses it. These tests parse the output the way a real reader
does: walk the xref, confirm each offset lands on its object, and check the
declared stream length against the actual bytes.

Everything here is DB-free — ``_render_invoice_pdf`` takes plain (row, tenant)
dicts — so it pins the format without standing up the maxgleam database, the
same split test_invoicing.py uses.
"""
import re

from server import maxgleam_invoicing as inv


TENANT = {"name": "Chester Window Cleaner", "email": "hello@cwc.co.uk"}

# A fixed "issued" far enough in the past that the unpaid states read overdue
# deterministically; individual tests override status/amounts as needed.
_ISSUED = 1_600_000_000


def _row(**over):
    base = {
        "number": "INV-2026-0042", "amount_pence": 5000, "vat_pence": 0,
        "status": "unpaid", "issued_at": _ISSUED, "paid_at": None, "method": None,
        "items_json": None, "sumup_checkout_url": "https://pay.sumup.com/b2c/x",
        "customer_name": "Jane O'Brien", "customer_email": "jane@example.com",
        "address": "12 Hoole Rd", "postcode": "CH2 3NJ", "ledger_paid": 0,
    }
    base.update(over)
    return base


def _assert_valid_pdf(pdf: bytes):
    """Parse a single-page PDF the way a reader's front-end does and assert it
    is internally consistent. Returns the decoded content stream for callers
    that want to assert on what was drawn."""
    assert pdf.startswith(b"%PDF-1.4"), "missing PDF header"
    assert pdf.rstrip().endswith(b"%%EOF"), "missing %%EOF"

    # startxref must point exactly at the 'xref' keyword.
    tail = pdf.rsplit(b"startxref", 1)[1]
    xref_pos = int(tail.strip().split(b"\n", 1)[0])
    assert pdf[xref_pos:xref_pos + 4] == b"xref", "startxref does not point at xref"

    # Every xref offset must land on '<n> 0 obj'. A stale offset here is the
    # classic hand-rolled-PDF corruption, so it is the core assertion.
    lines = pdf[xref_pos:].split(b"\n")
    count = int(lines[1].split()[1])            # subsection header "0 N"
    for i, entry in enumerate(lines[2:2 + count]):
        cols = entry.split()
        if i == 0:
            assert cols[2] == b"f", "object 0 must be the free entry"
            continue
        off = int(cols[0])
        assert pdf[off:].startswith(f"{i} 0 obj".encode()), \
            f"xref entry {i} points at offset {off}, not '{i} 0 obj'"

    # trailer /Size counts every object including the free obj 0.
    size = int(re.search(rb"/Size (\d+)", pdf).group(1))
    assert size == count, f"trailer /Size {size} != xref count {count}"

    # /Length must equal the real stream byte count (the separator EOLs around
    # 'stream'/'endstream' are not counted, per spec).
    m = re.search(rb"<< /Length (\d+) >>\nstream\n", pdf)
    declared = int(m.group(1))
    body = pdf[m.end():pdf.index(b"\nendstream", m.end())]
    assert declared == len(body), f"/Length {declared} != stream bytes {len(body)}"
    return body.decode("latin-1")


# ── every invoice state renders a structurally valid PDF ────────────

def test_unpaid_with_paylink_is_valid():
    _assert_valid_pdf(inv._render_invoice_pdf(_row(), TENANT))


def test_paid_is_valid_and_shows_paid_marker():
    stream = _assert_valid_pdf(inv._render_invoice_pdf(
        _row(status="paid", method="cash", paid_at=_ISSUED + 86400), TENANT))
    assert "PAID" in stream


def test_part_paid_is_valid_and_shows_a_balance():
    stream = _assert_valid_pdf(inv._render_invoice_pdf(_row(ledger_paid=2000), TENANT))
    # Part-paid draws the 'Balance due' block; the £30 remainder must appear.
    assert "Balance due" in stream


def test_void_is_valid_and_cancelled():
    stream = _assert_valid_pdf(inv._render_invoice_pdf(_row(status="void"), TENANT))
    assert "cancelled" in stream


def test_vat_invoice_is_valid():
    _assert_valid_pdf(inv._render_invoice_pdf(
        _row(amount_pence=6000, vat_pence=1000), TENANT))


def test_blank_customer_and_no_items_still_valid():
    # A minimal invoice — no address, no email, no stored line items — must
    # still fall back to a single "Window cleaning" line and render cleanly.
    _assert_valid_pdf(inv._render_invoice_pdf(
        _row(items_json="[]", customer_name=None, address=None,
             postcode=None, customer_email=None, sumup_checkout_url=None), TENANT))


def test_non_latin_and_overlong_description_degrade_not_corrupt():
    # Smart quotes / accents / a >78-char description must degrade to '?' and a
    # truncation, never corrupt the byte stream or blow the /Length.
    import json
    long_desc = "Café clean — " + "x" * 120 + " €µ"
    _assert_valid_pdf(inv._render_invoice_pdf(
        _row(items_json=json.dumps([{"label": long_desc, "amount_pence": 5000}])), TENANT))


def test_malformed_items_json_falls_back_cleanly():
    # A corrupt items_json must not raise — it falls back to the default line.
    _assert_valid_pdf(inv._render_invoice_pdf(_row(items_json="{not json"), TENANT))
