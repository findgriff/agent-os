#!/usr/bin/env python3
"""KS Sports Coaching — SMS reminder sweep.

Sends the 24-hour and 1-hour reminders for confirmed bookings. Idempotent:
every send is recorded in sms_log under a UNIQUE (booking_id, kind) index, so
running this twice never texts a parent twice.

Run every 15 minutes from cron:
    */15 * * * * root /usr/bin/python3 /opt/agent-os/tools/ks_reminders.py

Dry run (logs instead of sending):
    KS_SMS_DRY_RUN=1 python3 tools/ks_reminders.py
"""
from __future__ import annotations
import json
import logging
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# cron does not read the systemd EnvironmentFile, so load it here. Without
# this the sweep would text parents for real while the web app sat in
# dry-run — one switch has to mean the same thing in both places.
ENV_FILE = Path(os.environ.get("AGENTOS_ENV_FILE", "/etc/agent-os.env"))
if ENV_FILE.is_file():
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))

from server import ks  # noqa: E402  (import after the env is populated)

logging.basicConfig(level=logging.INFO, format="%(asctime)s ks-reminders %(levelname)s %(message)s")


def main() -> int:
    due = ks.due_reminders()
    if not due:
        logging.info("nothing due")
        print(json.dumps({"due": 0, "sent": {}}))
        return 0

    logging.info("%d reminder(s) due", len(due))
    result = ks.run_reminders()
    logging.info("result %s", result)
    print(json.dumps({"due": len(due), "sent": result}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
