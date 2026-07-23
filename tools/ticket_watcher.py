#!/usr/bin/env python3
"""AGENT OS — Event-driven ticket watcher.

Long-running process that watches for new tickets and immediately
triggers the service desk pipeline instead of waiting for the
next cron tick. This replaces poll-based with event-driven.

Runs as a systemd service.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

API = os.environ.get("OPS_API", "http://localhost:3200/ops_tickets")
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "30"))  # seconds

# Track which tickets we've already seen
_seen = set()


def get_active_tickets() -> list[dict]:
    """Fetch all non-completed tickets."""
    try:
        req = urllib.request.Request(
            f"{API}?status=neq.completed&status=neq.cancelled&order=id.asc",
            headers={"Accept": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except Exception as e:
        print(f"[watcher] Error fetching tickets: {e}", flush=True)
        return []


def dispatch_ticket(t: dict):
    """Immediately dispatch a new or changed ticket through the pipeline."""
    tid = t["id"]
    tier = t.get("assignment_tier", "1st_line")
    title = t.get("title", "Untitled")
    
    print(f"[watcher] 🚨 New/changed ticket #{tid} on {tier}: {title}", flush=True)
    
    if tier == "1st_line":
        # Run dispatch immediately
        print(f"[watcher] → Dispatching 1st line for #{tid}", flush=True)
        subprocess.Popen(
            ["/usr/bin/python3", "/opt/agent-os/tools/dispatch.py", "--target", str(tid)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
    elif tier == "2nd_line":
        # Run 2nd line immediately
        print(f"[watcher] → Dispatching 2nd line for #{tid}", flush=True)
        subprocess.Popen(
            ["/usr/bin/python3", "/opt/agent-os/tools/second_line.py", "--target", str(tid)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
    elif tier == "3rd_line":
        # This should be handled by the MCP/Herems cron, but we could
        # also trigger it immediately if we had a webhook
        print(f"[watcher] → 3rd line ticket #{tid} — will be picked up by hourly cron", flush=True)


def watch():
    """Main loop — poll for new/changed tickets."""
    print(f"[watcher] Starting ticket watcher (poll every {POLL_INTERVAL}s)", flush=True)
    
    while True:
        tickets = get_active_tickets()
        
        for t in tickets:
            tid = t["id"]
            
            # New ticket we haven't seen
            if tid not in _seen:
                _seen.add(tid)
                dispatch_ticket(t)
            else:
                # Check if tier changed (escalation)
                pass  # Future: detect escalations and re-dispatch
        
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    try:
        watch()
    except KeyboardInterrupt:
        print("[watcher] Stopped", flush=True)
