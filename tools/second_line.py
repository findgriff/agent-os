#!/usr/bin/env python3
"""AGENT OS — 2nd Line resolver (DeepSeek V4 Pro tier).

Runs every 30 minutes from a Hermes cron job. Picks up tickets that
the 1st Line dispatch couldn't auto-resolve and attempts deeper
investigation using DeepSeek V4 Pro for analysis.

Safe by design: never executes commands from ticket text. Uses the
same fixed probe allowlist and diagnostic commands as dispatch.py.

Passes:
  1. Collect — pending_dispatch or in_progress tickets at 2nd_line
  2. Investigate — run diagnostics, call DeepSeek for analysis
  3. Act — close if resolved, escalate to 3rd_line if not

Usage: python3 second_line.py [--dry-run]
Log:   /var/lib/agent-os/second_line.log
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
ENV_FILE = os.path.expanduser("~/.hermes/.env")
LOG = "/var/lib/agent-os/second_line.log"
DRY = "--dry-run" in sys.argv
NOTES_CAP = 4000

log_lines: list[str] = []

PROBE_URLS = {
    "agent-os": "http://127.0.0.1:8100/healthz",
    "ks-sports": "https://kssportscoaching.co.uk/",
    "max-gleam": "https://app.maxgleam.com/",
    "magic-hair-styler": "https://magichairstyler.com/",
    "dafc-shop": "https://darleyabbeyfc.com/",
}


def log(msg: str) -> None:
    line = f"[{dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')}] {msg}"
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
    body = {**body, "updated_at": now_iso()}
    if DRY:
        log(f"DRY #{tid} would PATCH {body} ({why})")
        return
    url = f"{API}?id=eq.{tid}"
    if guard:
        url += f"&status=eq.{guard}"
    got = req("PATCH", url, body)
    if got == []:
        log(f"PATCH #{tid} SKIPPED — status changed underneath us ({why})")
    else:
        log(f"PATCH #{tid} {why}")


def read_deepseek_key() -> str | None:
    """Read DeepSeek API key from .env file."""
    if not os.path.exists(ENV_FILE):
        return None
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if line.startswith("DEEPSEEK_API_KEY="):
                val = line.split("=", 1)[1].strip().strip("'\"").strip()
                if val:
                    return val
    return None


# ── Diagnostics (shared with dispatch.py patterns) ────────────────


def probe(url: str) -> tuple[bool, int, str]:
    """(ok, latency_ms, detail)"""
    t0 = time.monotonic()
    try:
        r = urllib.request.Request(url, headers={"User-Agent": "agentos-2ndline/1.0"})
        with urllib.request.urlopen(r, timeout=10) as resp:
            ms = int((time.monotonic() - t0) * 1000)
            return 200 <= resp.status < 400, ms, f"HTTP {resp.status}"
    except urllib.error.HTTPError as e:
        return False, int((time.monotonic() - t0) * 1000), f"HTTP {e.code}"
    except Exception as e:
        return False, int((time.monotonic() - t0) * 1000), type(e).__name__


def run_cmd(args: list[str]) -> str:
    try:
        out = subprocess.run(args, capture_output=True, text=True, timeout=10)
        return (out.stdout or out.stderr).strip()
    except Exception as e:
        return f"({type(e).__name__})"


def dns_check(domain: str) -> str:
    """Check DNS resolution for a domain."""
    out = run_cmd(["dig", "+short", domain, "2>/dev/null"]) or run_cmd(["nslookup", domain, "2>/dev/null"])
    if not out:
        out = run_cmd(["getent", "hosts", domain])
    return out or "DNS resolution failed"


def system_diagnostics() -> str:
    """Extended system diagnostics for 2nd line."""
    findings = []

    # Disk
    du = shutil.disk_usage("/")
    findings.append(f"disk: {du.used * 100 // du.total}% used")

    # Memory
    try:
        with open("/proc/meminfo") as f:
            mem = {}
            for ln in f:
                k, v = ln.split(":", 1)
                mem[k] = int(v.split()[0])
        avail_pct = mem["MemAvailable"] * 100 // mem["MemTotal"]
        findings.append(f"memory: {avail_pct}% available")
    except (OSError, KeyError, ValueError):
        findings.append("memory: unknown")

    # Load
    load1 = os.getloadavg()[0]
    cpus = os.cpu_count() or 1
    findings.append(f"load: {load1:.2f} (cpus: {cpus})")

    # Uptime
    findings.append(f"uptime: {run_cmd(['uptime'])}")

    # PostgREST
    ok, ms, d = probe("http://localhost:3200/")
    findings.append(f"postgrest: {d} {ms}ms")

    # Key services
    for name, url in PROBE_URLS.items():
        ok, ms, d = probe(url)
        findings.append(f"{name}: {d} {ms}ms")

    return "; ".join(findings)


def call_deepseek(prompt: str, system: str | None = None) -> str | None:
    """Call DeepSeek API for analysis."""
    api_key = read_deepseek_key()
    if not api_key:
        return None

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    try:
        req = urllib.request.Request(
            "https://api.deepseek.com/v1/chat/completions",
            data=json.dumps({
                "model": "deepseek-chat",
                "messages": messages,
                "max_tokens": 1000,
                "temperature": 0.2
            }).encode(),
            headers=headers,
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read())
            return data["choices"][0]["message"]["content"]
    except Exception as e:
        log(f"DeepSeek API error: {e}")
        return None


def investigate_ticket(t: dict) -> dict:
    """Investigate a ticket using diagnostics + optional DeepSeek analysis.
    
    Returns: {
        'resolved': True/False,
        'evidence': str,
        'summary': str,
        'escalate': True/False
    }
    """
    text = f"{t.get('title') or ''} {t.get('description') or ''}"
    text_lower = text.lower()
    evidence_parts = []

    # 1. Always run system diagnostics
    sys_info = system_diagnostics()
    evidence_parts.append(f"System: {sys_info}")

    # 2. If DNS-related, do DNS check
    if any(w in text_lower for w in ["dns", "domain", "resolution", "mx", "ns record"]):
        dns_result = dns_check("kssportscoaching.co.uk")
        evidence_parts.append(f"DNS: {dns_result}")

    # 3. If project-related, probe the URL
    project = t.get("project") or ""
    if project in PROBE_URLS:
        ok, ms, d = probe(PROBE_URLS[project])
        evidence_parts.append(f"Probe {project}: {d} {ms}ms")
        if ok:
            # Site is up — can auto-resolve if the ticket was about downtime
            evidence_parts.append("Site is responding — issue appears resolved")

    # 4. Check if system is healthy overall
    system_healthy = all(
        probe(url)[0] for name, url in PROBE_URLS.items()
        if name in text_lower
    ) if any(name in text_lower for name in PROBE_URLS) else True

    evidence = " | ".join(evidence_parts)

    # If we can clearly resolve, do so
    if "site is responding" in evidence and any(w in text_lower for w in ["down", "unreachable", "offline", "check"]):
        return {
            "resolved": True,
            "evidence": evidence,
            "summary": "Site verified as up and responding",
            "escalate": False
        }

    # Otherwise, try DeepSeek analysis for a decision
    api_key = read_deepseek_key()
    if api_key:
        system_prompt = """You are a 2nd Line ITIL resolver for an ops board. 
Analyse the ticket and diagnostic evidence. Respond ONLY with valid JSON:
{"action": "close"|"escalate", "reason": "brief reason", "summary": "one-line resolution summary"}
Close if the evidence shows the issue is resolved or no longer present.
Escalate if the issue needs human intervention."""
        
        prompt = f"""Ticket #{t['id']}: {t.get('title')}
Description: {t.get('description', '')}
Priority: {t.get('priority', 'N/A')}
Impact: {t.get('impact', 'N/A')} × Urgency: {t.get('urgency', 'N/A')}

Diagnostic evidence:
{evidence}

Decide: close or escalate?"""
        
        result = call_deepseek(prompt, system_prompt)
        if result:
            import re
            m = re.search(r'\{.*\}', result, re.DOTALL)
            if m:
                try:
                    decision = json.loads(m.group())
                    action = decision.get("action", "escalate")
                    return {
                        "resolved": action == "close",
                        "evidence": evidence,
                        "summary": decision.get("summary", evidence[:200]),
                        "escalate": action == "escalate"
                    }
                except (json.JSONDecodeError, Exception):
                    pass

    # Default: don't resolve, escalate to human
    return {
        "resolved": False,
        "evidence": evidence,
        "summary": "2nd Line investigation complete — needs human review",
        "escalate": True
    }


def main() -> None:
    log("=== 2nd Line Resolver Run ===")

    # Collect tickets at 2nd_line that need attention
    tickets = req("GET",
        f"{API}?assignment_tier=eq.2nd_line"
        f"&status=in.(pending_dispatch,in_progress)"
        "&order=priority.desc,created_at.asc&limit=20") or []
    log(f"Found {len(tickets)} 2nd_line ticket(s) needing attention")

    for t in tickets:
        tid = t["id"]
        log(f"#{tid}: {t.get('title', 'Untitled')} [{t.get('priority', 'N/A')}]")

        # Investigate
        result = investigate_ticket(t)

        if result["resolved"]:
            # Close the ticket
            close_notes = (
                f"2nd Line (DeepSeek Pro) resolved: {result['summary']}\n"
                f"Evidence: {result['evidence']}"
            )
            base = (t.get("resolution_notes") or "").strip()
            notes = (f"{base}\n---\n{close_notes}" if base else close_notes)[:NOTES_CAP]
            patch(tid, {
                "status": "completed",
                "closure_code": "automated",
                "resolved_at": now_iso(),
                "resolution_notes": notes
            }, f"resolved — {result['summary'][:60]}")
        elif result["escalate"]:
            # Escalate to 3rd Line
            esc_count = (t.get("escalation_count") or 0) + 1
            esc_notes = (
                f"2nd Line escalated to 3rd Line (escalation #{esc_count}): "
                f"{result['summary']}\n"
                f"Evidence: {result['evidence']}"
            )
            base = (t.get("resolution_notes") or "").strip()
            notes = (f"{base}\n---\n{esc_notes}" if base else esc_notes)[:NOTES_CAP]
            patch(tid, {
                "assignment_tier": "3rd_line",
                "escalation_count": esc_count,
                "status": "pending_dispatch",
                "resolution_notes": notes
            }, f"escalated to 3rd_line ({result['summary'][:60]})")
        else:
            # Leave for now
            info_notes = (
                f"2nd Line investigated: {result['summary']}\n"
                f"Evidence: {result['evidence']}"
            )
            base = (t.get("resolution_notes") or "").strip()
            notes = (f"{base}\n---\n{info_notes}" if base else info_notes)[:NOTES_CAP]
            patch(tid, {
                "resolution_notes": notes
            }, f"investigated but unresolved — left for next cycle")

    flush_log()
    log("=== 2nd Line Run Complete ===")
    print(json.dumps({"processed": len(tickets)}))


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
        import traceback
        log("CRASH: " + traceback.format_exc().strip().replace("\n", " | "))
        flush_log()
        sys.exit(1)
