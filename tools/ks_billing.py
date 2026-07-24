#!/usr/bin/env python3
"""KS Sports Coaching — monthly subscription billing sweep.

Raises this month's invoice for every active subscription, attaches a SumUp
pay-link and texts it to the parent, then reconciles anything already paid.

Idempotent twice over: invoices are unique on (subscription_id, period_start),
and a subscription's next_billing_date only advances once the invoice for the
period it names exists. Running this daily is therefore safe and is in fact
the intended schedule — a monthly-only cron would silently skip a month if
the box happened to be down on the 1st, whereas a daily run catches up.

Run daily from cron:
    17 6 * * * root /usr/bin/python3 /opt/agent-os/tools/ks_billing.py

Dry run (writes invoice rows, sends nothing, calls no payment API):
    KS_BILLING_DRY_RUN=1 python3 tools/ks_billing.py
"""
from __future__ import annotations
import json
import logging
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# cron does not read the systemd EnvironmentFile, so load it here — the same
# reason ks_reminders.py does. A dry-run switch has to mean the same thing in
# the web app and the sweep, or one of them bills for real on its own.
ENV_FILE = Path(os.environ.get("AGENTOS_ENV_FILE", "/etc/agent-os.env"))
if ENV_FILE.is_file():
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))

from server import ks_billing  # noqa: E402  (import after the env is populated)

logging.basicConfig(level=logging.INFO, format="%(asctime)s ks-billing %(levelname)s %(message)s")


def main() -> int:
    billed = ks_billing.run_billing()
    if billed["invoiced"]:
        logging.info("raised %d invoice(s), sent %d", billed["invoiced"], billed["sent"])
    else:
        logging.info("nothing due")

    # Chase payment on anything still outstanding from earlier months.
    reconciled = ks_billing.reconcile()
    if reconciled["paid"] or reconciled["failed"]:
        logging.info("reconciled: %d paid, %d failed",
                     reconciled["paid"], reconciled["failed"])

    print(json.dumps({"billed": billed, "reconciled": reconciled}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
