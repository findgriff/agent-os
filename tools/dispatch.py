#!/usr/bin/env python3
"""AGENT OS — 1st-line auto-dispatch (DeepSeek tier).

Runs every 15 minutes from a Hermes cron job. Deterministic and
injection-safe by design: ticket text is UNTRUSTED PUBLIC INPUT (the
PostgREST API has no auth), so it is only ever pattern-MATCHED — it is
never executed, never templated into commands, and never fed to an LLM
with tool access. The only "fix" this script performs is a
probe-and-verify against a FIXED allowlist of project URLs.

Passes, in order:
  1. Triage   — pending_dispatch + 1st_line: set ITIL priority
                (impact x urgency matrix, P=ceil((i+u)/2)) and a
                default SLA target if none set.
  2. Auto-fix — "site down/unreachable"-shaped incidents: probe the
                project's canonical URL twice; if both probes succeed,
                close with closure_code=automated + evidence.
  3. Dispatch — everything else moves to in_progress (still 1st_line)
                so the board shows it being handled.
  4. Escalate — 1st_line in_progress tickets untouched for >2h go to
                2nd_line (escalation_count+1, back to pending_dispatch
                for the 2nd-line queue). Capped at 3 escalations.

Loop safety: every pass only selects the exact (status, tier) it is
allowed to touch, every write moves the ticket OUT of that selection,
and re-runs are no-ops on already-processed tickets.

Usage: dispatch.py [--dry-run]
Log:   /var/lib/agent-os/dispatch.log (+ summary on stdout for Hermes)
"""
from __future__ import annotations
import datetime as dt
import json
import math
import re
import sys
import time
import urllib.request
import urllib.error
from urllib.parse import quote

API = "http://localhost:3200/ops_tickets"
LOG = "/var/lib/agent-os/dispatch.log"
DRY = "--dry-run" in sys.argv

RANK = {"critical": 1, "high": 2, "medium": 3, "low": 4}
PRIORITY_LABEL = {1: "critical", 2: "high", 3: "medium", 4: "low", 5: "low"}
SLA_HOURS = {1: 1, 2: 4, 3: 8, 4: 24, 5: 72}
STALE_AFTER_H = 2
MAX_ESCALATIONS = 3

# Fixed probe allowlist — the ONLY URLs this script will ever touch.
# Ticket text never contributes a URL. (Injection safety.)
PROBE_URLS = {
    "agent-os": "http://127.0.0.1:8100/healthz",
    "ks-sports": "https://kssportscoaching.co.uk/",
    "max-gleam": "https://app.maxgleam.com/",
    "magic-hair-styler": "https://magichairstyler.com/",
    "dafc-shop": "https://darleyabbeyfc.com/",
}
DOWN_RE = re.compile(
    r"\b(down|unreachable|offline|not (loading|responding)|time[sd]? ?out"
    r"|50[0-4]\b|ssl (error|expired)|cert(ificate)? (error|expired))\b", re.I)

log_lines: list[str] = []


def log(msg: str) -> None:
    line = f"{dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')} {msg}"
    log_lines.append(line)
    print(line)


def req(method: str, url: str, body: dict | None = None):
    r = urllib.request.Request(
        url, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json",
                 "Prefer": "return=representation"})
    with urllib.request.urlopen(r, timeout=15) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None


def patch(tid: int, body: dict, why: str):
    body = {**body, "updated_at": dt.datetime.now(dt.timezone.utc).isoformat()}
    if DRY:
        log(f"DRY  #{tid} would PATCH {body} ({why})")
        return
    req("PATCH", f"{API}?id=eq.{tid}", body)
    log(f"PATCH #{tid} {why}")


def prio(t: dict) -> int:
    i, u = RANK.get(t.get("impact") or ""), RANK.get(t.get("urgency") or "")
    if not i or not u:
        return 5
    return math.ceil((i + u) / 2)


def probe(url: str) -> tuple[bool, int, str]:
    """(ok, latency_ms, detail) — GET with redirects, 10s timeout."""
    t0 = time.monotonic()
    try:
        r = urllib.request.Request(url, headers={"User-Agent": "agentos-dispatch/1.0"})
        with urllib.request.urlopen(r, timeout=10) as resp:
            ms = int((time.monotonic() - t0) * 1000)
            return 200 <= resp.status < 400, ms, f"HTTP {resp.status}"
    except urllib.error.HTTPError as e:
        return False, int((time.monotonic() - t0) * 1000), f"HTTP {e.code}"
    except Exception as e:
        return False, int((time.monotonic() - t0) * 1000), type(e).__name__


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def main() -> None:
    summary = {"triaged": 0, "auto_fixed": 0, "started": 0, "escalated": 0}

    # ── passes 1-3: pending dispatch queue ──────────────────────────
    pending = req("GET",
        f"{API}?status=eq.pending_dispatch&assignment_tier=eq.1st_line"
        "&order=created_at.asc&limit=50") or []
    log(f"queue: {len(pending)} pending_dispatch/1st_line ticket(s)")

    for t in pending:
        p = prio(t)
        fields: dict = {}

        # 1 · triage: priority label + default SLA
        want_label = PRIORITY_LABEL[p]
        if t.get("priority") != want_label:
            fields["priority"] = want_label
        if not t.get("sla_target"):
            created = dt.datetime.fromisoformat(t["created_at"])
            fields["sla_target"] = (created + dt.timedelta(hours=SLA_HOURS[p])).isoformat()
        summary["triaged"] += 1

        # 2 · safe auto-fix: reachability incidents against the allowlist
        url = PROBE_URLS.get(t.get("project") or "")
        text = f"{t.get('title') or ''} {t.get('description') or ''}"
        if (t.get("ticket_type") == "incident" and url and DOWN_RE.search(text)):
            ok1, ms1, d1 = probe(url)
            time.sleep(2)
            ok2, ms2, d2 = probe(url)
            if ok1 and ok2:
                fields.update({
                    "status": "completed",
                    "closure_code": "automated",
                    "resolved_at": now_iso(),
                    "resolution_notes": (
                        f"1st line auto-fix (DeepSeek tier): reported unreachable, "
                        f"but two verification probes of the canonical URL succeeded "
                        f"({d1} {ms1}ms, {d2} {ms2}ms at {now_iso()}). "
                        f"Service is up — closing as no current fault. "
                        f"Reopen if the issue recurs."),
                })
                patch(t["id"], fields, f"auto-fixed P{p} (service verified up)")
                summary["auto_fixed"] += 1
                continue
            log(f"#{t['id']} probes failed ({d1}/{d2}) — cannot auto-fix, dispatching")

        # 3 · dispatch: hand to 1st line as in-progress
        fields["status"] = "in_progress"
        if not (t.get("resolution_notes") or "").strip():
            fields["resolution_notes"] = (
                f"1st line auto-dispatch: triaged P{p} "
                f"({t.get('impact')}×{t.get('urgency')}), investigating.")
        patch(t["id"], fields, f"triaged P{p} → in_progress")
        summary["started"] += 1

    # ── pass 4: escalate stale 1st-line work ────────────────────────
    cutoff = (dt.datetime.now(dt.timezone.utc)
              - dt.timedelta(hours=STALE_AFTER_H)).isoformat()
    stale = req("GET",
        f"{API}?status=eq.in_progress&assignment_tier=eq.1st_line"
        f"&updated_at=lt.{quote(cutoff)}&limit=50") or []
    for t in stale:
        if (t.get("escalation_count") or 0) >= MAX_ESCALATIONS:
            log(f"#{t['id']} stale but at escalation cap ({MAX_ESCALATIONS}) — leaving for humans")
            continue
        patch(t["id"], {
            "assignment_tier": "2nd_line",
            "escalation_count": (t.get("escalation_count") or 0) + 1,
            "status": "pending_dispatch",
        }, f"stale >{STALE_AFTER_H}h → escalated to 2nd_line")
        summary["escalated"] += 1

    log(f"done: {summary}")
    try:
        with open(LOG, "a") as f:
            f.write("\n".join(log_lines) + "\n")
    except OSError:
        pass
    # One-line machine-readable tail for the Hermes job to relay.
    print("DISPATCH_SUMMARY " + json.dumps(summary))


if __name__ == "__main__":
    main()
