#!/usr/bin/env python3
"""Max Gleam recurring schedule generator.

Creates 'scheduled' jobs for every active property whose next clean is due,
based on properties.frequency_weeks and the property's last job. Safe to run
repeatedly — it skips anything already scheduled — which is what lets it sit
on a daily cron.

Usage:
  maxgleam_scheduler.py generate [--dry-run] [--horizon N] [--tenant ID]
  maxgleam_scheduler.py overdue  [--tenant ID]     # properties past due
  maxgleam_scheduler.py route <YYYY-MM-DD> [--crew ID]   # preview a route
  maxgleam_scheduler.py status                     # upcoming work at a glance

--dry-run reports exactly what would be created without writing anything.
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from server import maxgleam_ops as ops  # noqa: E402


def cmd_generate(args) -> int:
    result = ops.generate_schedules(tenant_id=args.tenant, horizon_days=args.horizon,
                                    dry_run=args.dry_run,
                                    stagger=not args.no_stagger)
    if args.json:
        print(json.dumps(result, indent=2))
        return 0

    head = "DRY RUN — nothing written" if result["dry_run"] else "Schedule run"
    print(f"── {head} ─────────────────────────────────────")
    print(f"  today        : {result['today']}")
    print(f"  horizon      : {result['horizon_days']} days (to {result['horizon_end']})")
    print(f"  properties   : {result['properties_considered']} active, recurring")
    print(f"  created      : {result['created_count']}")
    print(f"  skipped      : {result['skipped_count']}")
    print(f"  overdue      : {result['overdue_count']}")

    for job in result["created"][:20]:
        crew = f" crew={job['crew_id']}" if job["crew_id"] else " unassigned"
        last = job["last_job_date"] or "never cleaned"
        print(f"    + {job['scheduled_date']}  {(job['address'] or '')[:42]:42s}"
              f" £{(job['price_pence'] or 0) / 100:>6.2f}{crew}  (last: {last})")
    if result["created_count"] > 20:
        print(f"    … and {result['created_count'] - 20} more")

    if result["overdue"]:
        print(f"\n  Overdue ({result['overdue_count']}):")
        for o in result["overdue"][:15]:
            print(f"    ! {(o['address'] or '')[:42]:42s} {o['days_overdue']:>4d}d past "
                  f"its {o['frequency_weeks']}-weekly slot (last {o['last_job_date']})")
    return 0


def cmd_overdue(args) -> int:
    rows = ops.overdue_properties(tenant_id=args.tenant)
    if args.json:
        print(json.dumps(rows, indent=2))
        return 0
    if not rows:
        print("Nothing overdue — every completed property is inside its frequency.")
        return 0
    print(f"{len(rows)} overdue propert{'y' if len(rows) == 1 else 'ies'}:")
    for r in rows:
        print(f"  {(r['address'] or '')[:44]:44s} {r['days_overdue']:>4d}d past due "
              f"(last done {r['last_completed']}, every {r['frequency_weeks']}w)")
    return 0


def cmd_route(args) -> int:
    route = ops.optimize_route(args.date, crew_id=args.crew, persist=not args.no_save)
    if args.json:
        print(json.dumps(route, indent=2))
        return 0
    print(f"── Route {route['date']}"
          f"{' · ' + route['crew_name'] if route['crew_name'] else ''} ──────────────")
    if not route["stops"]:
        print("  No jobs scheduled for that date/crew.")
        return 0
    for s in route["stops"]:
        if s["routable"]:
            print(f"  {s['position']:>2d}. {s['estimated_time']}  "
                  f"{(s['address'] or '')[:40]:40s} {s['postcode'] or '':9s} "
                  f"{s['drive_km_from_previous']:>6.1f}km "
                  f"{s['drive_minutes_from_previous']:>3d}min")
        else:
            print(f"  {s['position']:>2d}.   --   "
                  f"{(s['address'] or '')[:40]:40s} {s['postcode'] or '':9s} "
                  f"  (no coordinates — cannot route)")
    print(f"\n  {route['routed_count']} routed"
          + (f", {route['unroutable_count']} without coordinates"
             if route["unroutable_count"] else "")
          + f" · {route['total_distance_km']} km · "
          f"{route['total_drive_time_min']} min driving · "
          f"finish ~{route['finish_estimate']}")
    print(f"  Estimates: {route['assumptions']['distance']}")
    return 0


def cmd_status(args) -> int:
    today = time.strftime("%Y-%m-%d")
    horizon = ops._add_days(today, 14)
    rows = ops._rows(
        "SELECT scheduled_date, COUNT(*) n, SUM(price_pence) v FROM jobs "
        " WHERE tenant_id = ? AND status = 'scheduled' AND scheduled_date BETWEEN ? AND ? "
        " GROUP BY scheduled_date ORDER BY scheduled_date", (args.tenant, today, horizon))
    if not rows:
        print("No scheduled jobs in the next 14 days.")
    else:
        print("Scheduled work, next 14 days:")
        for r in rows:
            print(f"  {r['scheduled_date']}  {r['n']:>3d} jobs  £{(r['v'] or 0) / 100:>8.2f}")
    print(f"\nOverdue properties: {len(ops.overdue_properties(tenant_id=args.tenant))}")
    return 0


def main() -> int:
    # Shared flags live on a parent parser so they work either side of the
    # subcommand — `generate --json` is the natural way to type it.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--tenant", type=int, default=ops.DEFAULT_TENANT_ID)
    common.add_argument("--json", action="store_true", help="machine-readable output")

    ap = argparse.ArgumentParser(description=__doc__, parents=[common],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", parser_class=lambda **kw: argparse.ArgumentParser(parents=[common], **kw))

    g = sub.add_parser("generate", help="create jobs that are due")
    g.add_argument("--dry-run", action="store_true", help="report without writing")
    g.add_argument("--horizon", type=int, default=14,
                   help="only schedule this many days ahead (default 14)")
    g.add_argument("--no-stagger", action="store_true",
                   help="schedule every never-cleaned property for today "
                        "instead of spreading a round per working day")
    g.set_defaults(fn=cmd_generate)

    o = sub.add_parser("overdue", help="properties past their frequency")
    o.set_defaults(fn=cmd_overdue)

    r = sub.add_parser("route", help="preview an optimised route")
    r.add_argument("date")
    r.add_argument("--crew", type=int, default=None)
    r.add_argument("--no-save", action="store_true", help="don't store the route")
    r.set_defaults(fn=cmd_route)

    s = sub.add_parser("status", help="upcoming work at a glance")
    s.set_defaults(fn=cmd_status)

    args = ap.parse_args()
    if not getattr(args, "fn", None):
        ap.print_help()
        return 1
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
