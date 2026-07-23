#!/usr/bin/env python3
"""Max Gleam — notification and referral sweeps.

  notify    send the 24h-before reminders and post-sign-off thank-yous
  referrals promote referred friends who have booked, and apply credits
  all       both (what cron runs)

Notifications are gated by MAXGLEAM_NOTIFY_DRY_RUN (default "1" = log only).
Nothing is sent to a customer until that is set to 0 in /etc/agent-os.env.
Both sweeps are idempotent, so running them often is harmless.

Cron:
    */30 * * * * root /usr/bin/python3 /opt/agent-os/tools/maxgleam_growth_sweep.py all
"""
from __future__ import annotations
import argparse
import json
import logging
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# cron does not read the systemd EnvironmentFile, so load it here. Without
# this the sweep would run with MAXGLEAM_NOTIFY_DRY_RUN unset — which defaults
# to dry-run, but would also disagree with the server if the office had gone
# live. One switch has to mean the same thing in both places.
ENV_FILE = Path(os.environ.get("AGENTOS_ENV_FILE", "/etc/agent-os.env"))
if ENV_FILE.is_file():
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))

from server import maxgleam_notify as notify      # noqa: E402
from server import maxgleam_referrals as referrals  # noqa: E402

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s maxgleam-growth %(levelname)s %(message)s")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("what", nargs="?", default="all",
                    choices=("all", "notify", "referrals"))
    ap.add_argument("--tenant", type=int, default=notify.DEFAULT_TENANT_ID)
    ap.add_argument("--dry-run", action="store_true",
                    help="referral sweep: report without writing "
                         "(notifications are gated by MAXGLEAM_NOTIFY_DRY_RUN)")
    args = ap.parse_args()

    out: dict = {}
    if args.what in ("all", "notify"):
        out["notify"] = notify.run_sweep(args.tenant)
        logging.info("notify: processed=%s by_status=%s dry_run=%s",
                     out["notify"]["processed"], out["notify"]["by_status"],
                     out["notify"]["dry_run"])
    if args.what in ("all", "referrals"):
        out["referrals"] = referrals.run_sweep(args.tenant, dry_run=args.dry_run)
        logging.info("referrals: signed_up=%s rewarded=%s credit=%sp",
                     out["referrals"]["signed_up_count"],
                     out["referrals"]["rewarded_count"],
                     out["referrals"]["credit_applied_pence"])

    # Keep the log readable: counts to the logger, detail to stdout only when
    # something actually happened.
    if (out.get("notify", {}).get("processed")
            or out.get("referrals", {}).get("rewarded_count")
            or out.get("referrals", {}).get("signed_up_count")):
        print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
