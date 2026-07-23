"""
ITIL 4 Service Desk — Escalation Engine & Agent Pipeline
Part of the AGENT OS Ops Board system.

3-Tier Model:
  1st Line → DeepSeek V4 Flash  (auto-triage via dispatch.py, routine fixes)
  2nd Line → DeepSeek V4 Pro    (deeper investigation via second_line.py)
  3rd Line → Griff + Hermes + Claude (human escalation)

Usage:
  python3 service_desk.py check         # Check all active tickets for SLA/escalation
  python3 service_desk.py resolve <id>  # Mark a ticket as resolved
  python3 service_desk.py reset <id>    # Reset ticket back to 1st_line for re-dispatch
  python3 service_desk.py health        # Quick health check of monitored projects
  python3 service_desk.py weekly        # Full weekly scan
"""
import json
import os
import sys
import time
from datetime import datetime, timezone
from urllib.request import Request, urlopen

API = os.environ.get("OPS_API", "http://localhost:3200/ops_tickets")


def api_get(url):
    req = Request(url, headers={"Accept": "application/json"})
    with urlopen(req) as r:
        return json.loads(r.read())


def api_patch(url, data):
    body = json.dumps(data).encode()
    req = Request(url, data=body, method="PATCH",
                  headers={"Content-Type": "application/json"})
    with urlopen(req) as r:
        return r.read()


def esc():
    """Priority matrix based on Impact × Urgency (ITIL 4)."""
    matrix = {
        ("critical", "critical"): "P1-Critical",
        ("critical", "high"):    "P1-Critical",
        ("high",    "critical"): "P1-Critical",
        ("high",    "high"):     "P2-High",
        ("critical","medium"):   "P2-High",
        ("high",    "medium"):   "P3-Medium",
        ("medium",  "critical"): "P2-High",
        ("medium",  "high"):     "P3-Medium",
        ("medium",  "medium"):   "P4-Low",
        ("low",     "*"):        "P5-Planning",
        ("*",       "low"):      "P5-Planning",
    }
    return matrix.get


def check():
    """Check all active tickets and escalate if needed."""
    tickets = api_get(API + "?status=neq.completed&status=neq.cancelled")
    now = datetime.now(timezone.utc)

    for t in tickets:
        imp = t.get("impact", "medium")
        urg = t.get("urgency", "medium")

        # ITIL 4 Priority Matrix
        if imp == "critical" and urg in ("critical", "high"):
            priority = "P1-Critical"
            sla_hours = 1
        elif (imp == "critical" and urg == "medium") or (imp == "high" and urg == "critical"):
            priority = "P2-High"
            sla_hours = 4
        elif (imp == "high" and urg in ("medium", "high")) or (imp == "medium" and urg == "critical"):
            priority = "P3-Medium"
            sla_hours = 8
        elif imp == "medium" and urg in ("medium", "low"):
            priority = "P4-Low"
            sla_hours = 24
        else:
            priority = "P5-Planning"
            sla_hours = 72

        # Check SLA
        created = datetime.fromisoformat(t["created_at"].replace("Z", "+00:00"))
        sla_target = sla_hours * 3600
        elapsed = (now - created).total_seconds()
        sla_pct = min(100, round((elapsed / sla_target) * 100, 1)) if sla_target else 0

        # Auto-escalate: lower thresholds so tickets move faster
        tier = t.get("assignment_tier", "1st_line")
        esc_count = t.get("escalation_count", 0)

        # 1st Line → 2nd Line if dispatch couldn't handle it (>= 1 escalation)
        if tier == "1st_line" and esc_count >= 1:
            print(f"  → #{t['id']}: Escalating to 2nd Line (escalated {esc_count}x)")
            api_patch(f"{API}?id=eq.{t['id']}",
                      {"assignment_tier": "2nd_line", "updated_at": now.isoformat()})

        # 2nd Line → 3rd Line if second_line.py couldn't resolve (>= 2 escalations)
        elif tier == "2nd_line" and esc_count >= 2:
            print(f"  → #{t['id']}: Escalating to 3rd Line (HUMAN REQUIRED)")
            api_patch(f"{API}?id=eq.{t['id']}",
                      {"assignment_tier": "3rd_line", "updated_at": now.isoformat()})

        # SLA breach alert
        if sla_pct >= 100 and t["status"] not in ("completed", "cancelled"):
            print(f"  ⚠ #{t['id']}: SLA BREACHED ({priority}) — {t['title']}")

        print(f"  #{t['id']:>4} [{tier:>8}] {priority:12} SLA:{sla_pct:5.1f}% — {t['title'][:50]}")


def resolve(tid: int):
    """Mark a ticket as resolved."""
    now = datetime.now(timezone.utc).isoformat()
    api_patch(f"{API}?id=eq.{tid}",
              {"status": "completed", "closure_code": "automated",
               "resolved_at": now, "updated_at": now})
    print(f"✅ #{tid} resolved")


def reset_ticket(tid: int):
    """Reset a ticket back to 1st_line for re-dispatch."""
    now = datetime.now(timezone.utc).isoformat()
    api_patch(f"{API}?id=eq.{tid}",
              {"assignment_tier": "1st_line", "status": "pending_dispatch",
               "updated_at": now})
    print(f"🔄 #{tid} reset to 1st_line / pending_dispatch")


def check_health():
    """Check all projects are responding."""
    targets = {
        "KS Sports Coaching": "https://kssportscoaching.co.uk",
        "AGENT OS": "https://agents.opspocket.com",
        "Max Gleam": "https://maxgleam.co.uk",
    }
    for name, url in targets.items():
        try:
            req = Request(url, method="HEAD")
            with urlopen(req, timeout=10) as r:
                status = r.status
            if status >= 400:
                print(f"  ❌ {name}: DOWN ({status})")
            else:
                print(f"  ✅ {name}: OK ({status})")
        except Exception as e:
            print(f"  ❌ {name}: UNREACHABLE ({e})")


def weekly_scan():
    """Nightly/weekly engineering scan."""
    print("=== Weekly Engineering Scan ===")
    check_health()

    tickets = api_get(API + "?status=neq.completed&status=neq.cancelled&order=priority.desc&limit=20")
    print(f"\nActive tickets: {len(tickets)}")
    for t in tickets:
        print(f"  #{t['id']:>4} [{t['priority']:>7}] {t['title'][:60]}")

    by_tier = {"1st_line": 0, "2nd_line": 0, "3rd_line": 0}
    for t in tickets:
        tier = t.get("assignment_tier", "1st_line")
        by_tier[tier] = by_tier.get(tier, 0) + 1
    print(f"\nTier breakdown: 1st Line: {by_tier['1st_line']} | 2nd Line: {by_tier['2nd_line']} | 3rd Line: {by_tier['3rd_line']}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    if cmd == "check":
        check()
    elif cmd == "resolve":
        resolve(int(sys.argv[2]))
    elif cmd == "reset":
        reset_ticket(int(sys.argv[2]))
    elif cmd == "health":
        check_health()
    elif cmd == "weekly":
        weekly_scan()
    else:
        print(f"Unknown command: {cmd}")
