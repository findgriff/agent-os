#!/usr/bin/env python3
"""AGENT OS — 1st-line auto-dispatch (DeepSeek tier).

Runs every 15 minutes from a Hermes cron job. Deterministic and
injection-safe by design: ticket text is UNTRUSTED PUBLIC INPUT (the
PostgREST API has no auth), so it is only ever pattern-MATCHED — it is
never executed, never templated into commands or URLs, and never fed to
an LLM with tool access. Probe URLs come from a fixed allowlist and
every diagnostic command is a fixed argument list.

Passes, in order:
  1. Triage    — pending_dispatch + 1st_line: set ITIL priority
                 (impact x urgency matrix, P=ceil((i+u)/2)) and a
                 default SLA target if none set.
  2. Attempt   — every triaged ticket gets the project-appropriate
                 check, not just site-down incidents:
                   system-shaped text  -> local VPS diagnostics
                                          (df -h /, free -h, uptime,
                                          PostgREST on :3200)
                   project with a URL  -> double reachability probe
                   anything else       -> informational env check.
                 Checks healthy + action-shaped text -> close with
                 closure_code=automated and the evidence in
                 resolution_notes. Otherwise -> in_progress with the
                 evidence attached for human review.
  3. Re-check  — in_progress/1st_line tickets are re-attempted every
                 run; if the fault has cleared, close them. A failed
                 re-check writes NOTHING — updated_at is preserved so
                 the escalation timer in pass 4 still fires.
  4. Escalate  — 1st_line in_progress untouched beyond the stale window
                 goes to 2nd_line (escalation_count+1, back to
                 pending_dispatch). Capped at 3 escalations.

Loop safety: every write either moves the ticket out of its pass's
selection, or (re-check) only happens when closing. Re-runs are no-ops
on already-processed tickets.

Usage: dispatch.py [--dry-run]
Log:   /var/lib/agent-os/dispatch.log (+ DISPATCH_SUMMARY on stdout)
"""
from __future__ import annotations
import datetime as dt
import json
import math
import os
import re
import shutil
import subprocess
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
STALE_AFTER_M = 20
MAX_ESCALATIONS = 3
NOTES_CAP = 4000  # resolution_notes growth bound across appends

# Fixed probe allowlist — the ONLY remote URLs this script will ever
# touch. Ticket text never contributes a URL. (Injection safety.)
PROBE_URLS = {
    "agent-os": "http://127.0.0.1:8100/healthz",
    "ks-sports": "https://kssportscoaching.co.uk/",
    "max-gleam": "https://app.maxgleam.com/",
    "magic-hair-styler": "https://magichairstyler.com/",
    "dafc-shop": "https://darleyabbeyfc.com/",
}

# Action-shaped text — deliberately broad (2026-07-20): 1st line runs a
# check on nearly everything instead of parking tickets. Still only a
# pattern match against untrusted text; it gates CLOSURE, not commands.
ACTION_RE = re.compile(
    r"\b(down|unreachable|offline|not (loading|responding|working)"
    r"|time[sd]? ?out|50[0-4]\b|ssl (error|expired)"
    r"|cert(ificate)? (error|expired)"
    r"|check|investigate|review|look at|error|issue|problem|fix)\b", re.I)

# System/VPS-shaped tickets get local diagnostics instead of a URL probe.
# NB: bare "load" is excluded on purpose — "page would not load" is a web
# complaint, not a loadavg one.
SYS_RE = re.compile(
    r"\b(vps|server|host|disk|storage|memory|ram|cpu"
    r"|load ?avg|load average|(high|cpu|server) load"
    r"|postgrest|database|db)\b", re.I)

log_lines: list[str] = []


def log(msg: str) -> None:
    line = f"{dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')} {msg}"
    log_lines.append(line)
    print(line)


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def req(method: str, url: str, body: dict | None = None):
    r = urllib.request.Request(
        url, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json",
                 "Prefer": "return=representation"})
    with urllib.request.urlopen(r, timeout=15) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None


def patch(tid: int, body: dict, why: str, guard: str | None = None):
    """PATCH one ticket. `guard` restricts the write to tickets still in
    that status, so a human editing the board mid-run can't be clobbered."""
    body = {**body, "updated_at": now_iso()}
    if DRY:
        log(f"DRY  #{tid} would PATCH {body} ({why})")
        return
    url = f"{API}?id=eq.{tid}"
    if guard:
        url += f"&status=eq.{guard}"
    got = req("PATCH", url, body)
    if got == []:
        log(f"PATCH #{tid} SKIPPED — status changed underneath us ({why})")
    else:
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


def run_cmd(args: list[str]) -> str:
    """Run a FIXED command (never ticket-derived) for evidence output."""
    try:
        out = subprocess.run(args, capture_output=True, text=True, timeout=10)
        return (out.stdout or out.stderr).strip()
    except Exception as e:
        return f"({type(e).__name__})"


def system_check() -> tuple[bool, str]:
    """Local VPS diagnostics: disk, memory, load, PostgREST.
    Health verdict comes from structured sources; the human-readable
    command output is attached as evidence."""
    findings, healthy = [], True

    du = shutil.disk_usage("/")
    disk_pct = du.used * 100 // du.total
    if disk_pct >= 90:
        healthy = False
    df_lines = run_cmd(["df", "-h", "/"]).splitlines()
    findings.append(f"disk {disk_pct}% used ({df_lines[-1] if df_lines else 'n/a'})")

    mem = {}
    try:
        with open("/proc/meminfo") as f:
            for ln in f:
                k, v = ln.split(":", 1)
                mem[k] = int(v.split()[0])
        avail_pct = mem["MemAvailable"] * 100 // mem["MemTotal"]
    except (OSError, KeyError, ValueError):
        avail_pct = -1
    if 0 <= avail_pct < 10:
        healthy = False
    free_lines = run_cmd(["free", "-h"]).splitlines()
    findings.append(
        f"memory {avail_pct}% available "
        f"({free_lines[1] if len(free_lines) > 1 else 'n/a'})")

    load1 = os.getloadavg()[0]
    cpus = os.cpu_count() or 1
    if load1 > 2 * cpus:
        healthy = False
    findings.append(f"load {load1:.2f} on {cpus} cpu ({run_cmd(['uptime'])})")

    ok, ms, d = probe("http://localhost:3200/")
    if not ok:
        healthy = False
    findings.append(f"postgrest {d} {ms}ms")

    return healthy, "; ".join(findings)


def attempt_fix(t: dict) -> tuple[bool | None, str, str]:
    """Project-appropriate 1st-line check.

    Returns (healthy, evidence, kind):
      healthy True  — checks passed, safe to close if the ticket is
                      action-shaped
      healthy False — a check FAILED; leave for humans with findings
      healthy None  — no check can verify this request; evidence is
                      informational only, never close
    """
    text = f"{t.get('title') or ''} {t.get('description') or ''}"
    url = PROBE_URLS.get(t.get("project") or "")

    if SYS_RE.search(text):
        healthy, ev = system_check()
        return healthy, f"VPS diagnostics: {ev}", "system"

    if url:
        ok1, ms1, d1 = probe(url)
        time.sleep(2)
        ok2, ms2, d2 = probe(url)
        ev = f"probe {url}: {d1} {ms1}ms, {d2} {ms2}ms"
        return ok1 and ok2, ev, "probe"

    # No project URL and not system-shaped — box health is still useful
    # context but cannot verify the request itself, so never auto-close.
    _, ev = system_check()
    return None, f"environment check (informational): {ev}", "info"


def close_fields(note: str, existing: str | None) -> dict:
    base = (existing or "").strip()
    notes = (f"{base}\n---\n{note}" if base else note)[:NOTES_CAP]
    return {"status": "completed", "closure_code": "automated",
            "resolved_at": now_iso(), "resolution_notes": notes}


def main() -> None:
    summary = {"triaged": 0, "auto_fixed": 0, "dispatched": 0,
               "rechecked": 0, "recheck_closed": 0, "escalated": 0}
    touched: set[int] = set()

    # ── passes 1+2: triage the pending queue and attempt each ticket ─
    pending = req("GET",
        f"{API}?status=eq.pending_dispatch&assignment_tier=eq.1st_line"
        "&order=created_at.asc&limit=50") or []
    log(f"queue: {len(pending)} pending_dispatch/1st_line ticket(s)")

    for t in pending:
        p = prio(t)
        fields: dict = {}
        text = f"{t.get('title') or ''} {t.get('description') or ''}"

        # 1 · triage: priority label + default SLA
        if t.get("priority") != PRIORITY_LABEL[p]:
            fields["priority"] = PRIORITY_LABEL[p]
        if not t.get("sla_target"):
            created = dt.datetime.fromisoformat(t["created_at"])
            fields["sla_target"] = (
                created + dt.timedelta(hours=SLA_HOURS[p])).isoformat()
        summary["triaged"] += 1
        touched.add(t["id"])

        # 2 · attempt the project-appropriate check on EVERY ticket
        healthy, evidence, kind = attempt_fix(t)

        if healthy is True and ACTION_RE.search(text):
            fields.update(close_fields(
                f"1st line auto-fix (DeepSeek tier): {kind} check verified "
                f"healthy — {evidence}. Closing as no current fault; reopen "
                f"if the issue recurs.", t.get("resolution_notes")))
            patch(t["id"], fields,
                  f"auto-fixed P{p} ({kind} check healthy)",
                  guard="pending_dispatch")
            summary["auto_fixed"] += 1
            continue

        # not auto-closable — dispatch to in_progress WITH the evidence
        if healthy is False:
            why = f"{kind} check FAILED — needs human"
        elif healthy is True:
            why = "checks healthy but request needs a human"
        else:
            why = "no automated check for this request"
        note = (f"1st line auto-dispatch: triaged P{p} "
                f"({t.get('impact')}×{t.get('urgency')}); attempted {kind} "
                f"check — {evidence}. {why}.")
        base = (t.get("resolution_notes") or "").strip()
        fields["status"] = "in_progress"
        fields["resolution_notes"] = (
            f"{base}\n---\n{note}" if base else note)[:NOTES_CAP]
        patch(t["id"], fields, f"triaged P{p} → in_progress ({why})",
              guard="pending_dispatch")
        summary["dispatched"] += 1

    # ── pass 3: re-check tickets already in progress at 1st line ────
    inprog = req("GET",
        f"{API}?status=eq.in_progress&assignment_tier=eq.1st_line"
        "&order=created_at.asc&limit=50") or []
    for t in inprog:
        if t["id"] in touched:
            continue
        summary["rechecked"] += 1
        text = f"{t.get('title') or ''} {t.get('description') or ''}"
        healthy, evidence, kind = attempt_fix(t)
        if healthy is True and ACTION_RE.search(text):
            patch(t["id"], close_fields(
                f"1st line re-check: {kind} check now verifies healthy — "
                f"{evidence}. Transient issue cleared; closing.",
                t.get("resolution_notes")),
                f"re-check verified healthy → closed", guard="in_progress")
            summary["recheck_closed"] += 1
        else:
            # Deliberately NO write: preserving updated_at keeps the
            # escalation timer honest and stops notes growing unbounded.
            log(f"#{t['id']} re-check: {kind} — {evidence[:150]} — "
                f"still needs human, leaving for escalation timer")

    # ── pass 4: escalate stale 1st-line work ────────────────────────
    cutoff = (dt.datetime.now(dt.timezone.utc)
              - dt.timedelta(minutes=STALE_AFTER_M)).isoformat()
    stale = req("GET",
        f"{API}?status=eq.in_progress&assignment_tier=eq.1st_line"
        f"&updated_at=lt.{quote(cutoff)}&limit=50") or []
    for t in stale:
        if t["id"] in touched:
            continue  # dispatched this run — updated_at is fresh anyway
        if (t.get("escalation_count") or 0) >= MAX_ESCALATIONS:
            log(f"#{t['id']} stale but at escalation cap ({MAX_ESCALATIONS}) — leaving for humans")
            continue
        patch(t["id"], {
            "assignment_tier": "2nd_line",
            "escalation_count": (t.get("escalation_count") or 0) + 1,
            "status": "pending_dispatch",
        }, f"stale >{STALE_AFTER_M}m → escalated to 2nd_line",
            guard="in_progress")
        summary["escalated"] += 1

    log(f"done: {summary}")
    flush_log()
    # One-line machine-readable tail for the Hermes job to relay.
    print("DISPATCH_SUMMARY " + json.dumps(summary))


def flush_log() -> None:
    try:
        with open(LOG, "a") as f:
            f.write("\n".join(log_lines) + "\n")
    except OSError:
        pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # A crashed run must still leave a trace in the log file —
        # otherwise a tick silently vanishes (observed 2026-07-19 21:45).
        import traceback
        log("CRASH: " + traceback.format_exc().strip().replace("\n", " | "))
        flush_log()
        print("DISPATCH_SUMMARY " + json.dumps(
            {"error": "crashed — see dispatch.log"}))
        sys.exit(1)
