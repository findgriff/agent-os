#!/usr/bin/env python3
"""Max Gleam automatic email alerts — the cron entry point.

Evaluates every alert rule against the live estate and emails the office when
one fires. Safe to run repeatedly: each alert has a cooldown, so a daily timer
does not re-send the same list every morning.

Usage:
  maxgleam_alerts.py check                    # what would fire (sends nothing)
  maxgleam_alerts.py run --dry-run            # full pass, logs, sends nothing
  maxgleam_alerts.py run                      # live — this sends email
  maxgleam_alerts.py run --kind daily_digest  # one rule only
  maxgleam_alerts.py run --force              # ignore the cooldown
  maxgleam_alerts.py history [--limit N]      # what has already gone out
  maxgleam_alerts.py backfill                 # rebuild the staff activity log

--dry-run is the only difference between a rehearsal and the real thing;
everything else (evaluation, dedupe, logging) runs identically.
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from server import maxgleam_alerts as alerts      # noqa: E402
from server import maxgleam_activity as activity   # noqa: E402
from server.maxgleam_ops import DEFAULT_TENANT_ID  # noqa: E402


def _stamp(epoch) -> str:
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(epoch)) if epoch else "—"


def cmd_check(args) -> int:
    status, data = alerts.preview(args.tenant)
    if args.json:
        print(json.dumps(data, indent=2))
        return 0
    print("── Alert check ─────────────────────────────────────")
    print(f"  mail configured : {data['mail_configured']} ({data['mail_from']})")
    print(f"  rules firing    : {len(data['alerts'])} of {len(data['kinds'])}")
    if not data["alerts"]:
        print("\n  Nothing to report — the estate is clean.")
        return 0
    for a in data["alerts"]:
        flag = "WOULD SEND" if a["would_send"] else f"cooldown until +{a['cooldown_hours']}h"
        print(f"\n  [{a['severity'].upper():5s}] {a['kind']}  ({flag})")
        print(f"    {a['subject']}")
        print(f"    to: {', '.join(a['recipients']) or '(nobody)'}")
        if a["last_sent_at"]:
            print(f"    last sent: {_stamp(a['last_sent_at'])}")
        if args.verbose:
            for line in a["body"].splitlines():
                print(f"    | {line}")
    return 0


def cmd_run(args) -> int:
    kinds = tuple(args.kind) if args.kind else None
    result = alerts.run(args.tenant, dry_run=args.dry_run, kinds=kinds,
                        force=args.force)
    if args.json:
        print(json.dumps(result, indent=2))
        return 0
    head = "DRY RUN — nothing sent" if result["dry_run"] else "Alert run"
    print(f"── {head} ─────────────────────────────────────")
    print(f"  evaluated : {result['evaluated']}")
    print(f"  sent      : {result['sent']}")
    print(f"  skipped   : {result['skipped']}")
    print(f"  failed    : {result['failed']}")
    for r in result["results"]:
        mark = {"sent": "+", "skipped": ".", "failed": "!"}.get(r["status"], "?")
        extra = f" ({r.get('reason')})" if r.get("reason") else ""
        # "sent" in a dry run means "would have been sent" — say so, or the
        # rehearsal reads exactly like the real thing.
        shown = "would send" if result["dry_run"] and r["status"] == "sent" else r["status"]
        print(f"    {mark} {r['kind']:20s} {shown}{extra}")
        if r.get("recipients"):
            print(f"      → {', '.join(r['recipients'])}")
        if r.get("error"):
            print(f"      ! {r['error']}")
    return 1 if result["failed"] else 0


def cmd_history(args) -> int:
    _status, data = alerts.history(args.tenant, args.limit)
    if args.json:
        print(json.dumps(data, indent=2))
        return 0
    print(f"── Alert history ({data['count']}) ──────────────────")
    for a in data["alerts"]:
        tag = "DRY" if a["dry_run"] else a["status"].upper()
        print(f"  {_stamp(a['sent_at'])}  [{tag:6s}] {a['kind']:20s} "
              f"{a['subject'][:56]}")
        if a["error"]:
            print(f"      ! {a['error']}")
    return 0


def cmd_backfill(args) -> int:
    written = activity.backfill(args.tenant)
    print("── Activity backfill ───────────────────────────────")
    for k, v in written.items():
        print(f"  {k:16s}: {v}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--tenant", type=int, default=DEFAULT_TENANT_ID)
    p.add_argument("--json", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("check", help="what would fire (sends nothing)")
    c.add_argument("-v", "--verbose", action="store_true", help="show full bodies")
    c.set_defaults(fn=cmd_check)

    r = sub.add_parser("run", help="evaluate and send")
    r.add_argument("--dry-run", action="store_true", help="log but send nothing")
    r.add_argument("--force", action="store_true", help="ignore the cooldown")
    r.add_argument("--kind", action="append", choices=list(alerts.KINDS),
                   help="restrict to one rule (repeatable)")
    r.set_defaults(fn=cmd_run)

    h = sub.add_parser("history", help="what has already gone out")
    h.add_argument("--limit", type=int, default=50)
    h.set_defaults(fn=cmd_history)

    b = sub.add_parser("backfill", help="rebuild the staff activity log")
    b.set_defaults(fn=cmd_backfill)

    args = p.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
