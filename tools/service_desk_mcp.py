#!/usr/bin/env python3
"""AGENT OS — Service Desk MCP Server.

Exposes the ITIL 4 service desk as MCP tools that any AI agent can call.
This turns 3rd Line into an automated agent dispatch rather than
a manual check.

Tools:
  check_tickets       — List all active tickets by tier with SLA
  investigate_ticket  — Run diagnostics on a specific ticket
  resolve_ticket      — Mark ticket resolved with evidence
  escalate_ticket     — Escalate a ticket to next tier
  ticket_detail       — Get full details of a specific ticket

Usage:
  hermes mcp add service-desk --command "python3 /opt/agent-os/tools/service_desk_mcp.py"
  (Already configured in config.yaml)
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import urllib.error

API = os.environ.get("OPS_API", "http://localhost:3200/ops_tickets")

# Fixed probe allowlist — same as dispatch.py
PROBE_URLS = {
    "agent-os": "http://127.0.0.1:8100/healthz",
    "ks-sports": "https://kssportscoaching.co.uk/",
    "max-gleam": "https://app.maxgleam.com/",
    "magic-hair-styler": "https://magichairstyler.com/",
    "dafc-shop": "https://darleyabbeyfc.com/",
}

# ── API helpers ─────────────────────────────────────────────────────

def api_get(url: str) -> list | dict:
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except Exception as e:
        return {"error": str(e)}

def api_patch(url: str, data: dict) -> dict | None:
    body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, method="PATCH",
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10):
            return None
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}", "detail": e.read().decode()[:200]}
    except Exception as e:
        return {"error": str(e)}

# ── Diagnostic helpers ──────────────────────────────────────────────

def probe(url: str) -> tuple[bool, int, str]:
    t0 = time.monotonic()
    try:
        r = urllib.request.Request(url, headers={"User-Agent": "agentos-mcp/1.0"})
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

def system_diagnostics() -> str:
    findings = []
    du = shutil.disk_usage("/")
    findings.append(f"disk:{du.used*100//du.total}%")
    try:
        with open("/proc/meminfo") as f:
            mem = {}
            for ln in f:
                k, v = ln.split(":", 1)
                mem[k] = int(v.split()[0])
        avail_pct = mem["MemAvailable"] * 100 // mem["MemTotal"]
        findings.append(f"mem:{avail_pct}%avail")
    except:
        findings.append("mem:unknown")
    load1 = os.getloadavg()[0]
    cpus = os.cpu_count() or 1
    findings.append(f"load:{load1:.2f}/{cpus}cpu")
    for name, url in PROBE_URLS.items():
        ok, ms, d = probe(url)
        findings.append(f"{name}:{d}{ms}ms")
    return " | ".join(findings)

# ── Tool handlers ───────────────────────────────────────────────────

def handle_check_tickets(args: dict) -> str:
    """List all active tickets by tier."""
    tickets = api_get(f"{API}?status=neq.completed&status=neq.cancelled&order=priority.desc")
    if isinstance(tickets, dict) and "error" in tickets:
        return f"Error: {tickets['error']}"
    
    lines = []
    by_tier = {"1st_line": [], "2nd_line": [], "3rd_line": []}
    for t in tickets:
        tier = t.get("assignment_tier", "1st_line")
        by_tier.setdefault(tier, []).append(t)
    
    for tier_name in ["1st_line", "2nd_line", "3rd_line"]:
        ts = by_tier.get(tier_name, [])
        lines.append(f"\n## {tier_name} ({len(ts)} tickets)")
        for t in ts:
            lines.append(f"  #{t['id']} [{t.get('priority','?')}] {t.get('title','?')}")
            lines.append(f"    Status: {t['status']} | Esc: {t.get('escalation_count',0)}")
    
    return "\n".join(lines)

def handle_investigate_ticket(args: dict) -> str:
    """Run diagnostics on a specific ticket."""
    tid = args.get("ticket_id")
    if not tid:
        return "Error: ticket_id is required"
    
    tickets = api_get(f"{API}?id=eq.{tid}")
    if isinstance(tickets, dict) and "error" in tickets:
        return f"Error fetching ticket: {tickets['error']}"
    if not tickets:
        return f"Ticket #{tid} not found"
    
    t = tickets[0]
    text = f"{t.get('title','')} {t.get('description','')}"
    text_lower = text.lower()
    
    evidence = []
    
    # Run system diagnostics
    sys_info = system_diagnostics()
    evidence.append(f"System: {sys_info}")
    
    # DNS check if relevant
    if any(w in text_lower for w in ["dns", "domain", "resolution"]):
        dig = run_cmd(["dig", "+short", "kssportscoaching.co.uk"])
        evidence.append(f"DNS: {dig[:150] or 'failed'}")
    
    # Project probe if relevant
    project = t.get("project", "")
    if project in PROBE_URLS:
        ok, ms, d = probe(PROBE_URLS[project])
        evidence.append(f"Probe {project}: {d} {ms}ms")
    
    # All probes
    for name, url in PROBE_URLS.items():
        ok, ms, d = probe(url)
        evidence.append(f"Health {name}: {d} {ms}ms")
    
    return (
        f"## Investigation Results — Ticket #{tid}\n\n"
        f"**Title:** {t.get('title','?')}\n"
        f"**Priority:** {t.get('priority','?')} | **Tier:** {t.get('assignment_tier','?')}\n"
        f"**Impact:** {t.get('impact','?')} | **Urgency:** {t.get('urgency','?')}\n"
        f"**SLA Target:** {t.get('sla_target','N/A')}\n\n"
        f"### Diagnostics\n"
        + "\n".join(f"- {e}" for e in evidence)
    )

def handle_resolve_ticket(args: dict) -> str:
    """Mark a ticket as resolved."""
    tid = args.get("ticket_id")
    notes = args.get("notes", "Resolved by 3rd Line agent via MCP")
    
    if not tid:
        return "Error: ticket_id is required"
    
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    result = api_patch(f"{API}?id=eq.{tid}", {
        "status": "completed",
        "closure_code": "automated",
        "resolved_at": now,
        "resolution_notes": f"3rd Line (MCP agent) resolved: {notes}",
        "updated_at": now,
    })
    if result and "error" in result:
        return f"Error: {result['error']}"
    return f"✅ Ticket #{tid} resolved. Notes: {notes}"

def handle_escalate_ticket(args: dict) -> str:
    """Escalate a ticket to the next tier."""
    tid = args.get("ticket_id")
    notes = args.get("notes", "Escalated by 3rd Line agent")
    
    if not tid:
        return "Error: ticket_id is required"
    
    tickets = api_get(f"{API}?id=eq.{tid}")
    if isinstance(tickets, dict) and "error" in tickets:
        return f"Error: {tickets['error']}"
    if not tickets:
        return f"Ticket #{tid} not found"
    
    t = tickets[0]
    current_tier = t.get("assignment_tier", "1st_line")
    esc_count = t.get("escalation_count", 0) + 1
    
    # Map to next tier
    next_tier = {"1st_line": "2nd_line", "2nd_line": "3rd_line", "3rd_line": "3rd_line"}.get(current_tier, "3rd_line")
    
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    result = api_patch(f"{API}?id=eq.{tid}", {
        "assignment_tier": next_tier,
        "escalation_count": esc_count,
        "status": "pending_dispatch",
        "resolution_notes": f"3rd Line escalated: {notes}",
        "updated_at": now,
    })
    if result and "error" in result:
        return f"Error: {result['error']}"
    return f"🔄 Ticket #{tid} escalated from {current_tier} to {next_tier} (esc #{esc_count})"

def handle_ticket_detail(args: dict) -> str:
    """Get full details of a specific ticket."""
    tid = args.get("ticket_id")
    if not tid:
        return "Error: ticket_id is required"
    
    tickets = api_get(f"{API}?id=eq.{tid}")
    if isinstance(tickets, dict) and "error" in tickets:
        return f"Error: {tickets['error']}"
    if not tickets:
        return f"Ticket #{tid} not found"
    
    t = tickets[0]
    return (
        f"## Ticket #{tid}\n"
        f"**Title:** {t.get('title','?')}\n"
        f"**Description:** {t.get('description','N/A')}\n"
        f"**Status:** {t.get('status','?')} | **Tier:** {t.get('assignment_tier','?')}\n"
        f"**Priority:** {t.get('priority','?')} | **Impact:** {t.get('impact','?')} | **Urgency:** {t.get('urgency','?')}\n"
        f"**Escalations:** {t.get('escalation_count',0)}\n"
        f"**Created:** {t.get('created_at','?')}\n"
        f"**Project:** {t.get('project','N/A')}\n"
        f"**Notes:** {(t.get('resolution_notes') or 'None')[:300]}"
    )

# ── Tool definitions ────────────────────────────────────────────────

TOOLS = {
    "check_tickets": {
        "description": "List all active service desk tickets grouped by tier (1st/2nd/3rd Line). Returns ticket IDs, priorities, and SLA status.",
        "handler": handle_check_tickets,
        "inputSchema": {"type": "object", "properties": {}},
    },
    "investigate_ticket": {
        "description": "Run full system diagnostics for a specific ticket. Probes URLs, checks DNS, disk, memory, CPU, and all monitored services.",
        "handler": handle_investigate_ticket,
        "inputSchema": {
            "type": "object",
            "properties": {
                "ticket_id": {"type": "string", "description": "The ticket ID number to investigate"}
            },
            "required": ["ticket_id"],
        },
    },
    "resolve_ticket": {
        "description": "Mark a ticket as resolved with closure notes. Use this when investigation shows the issue is resolved.",
        "handler": handle_resolve_ticket,
        "inputSchema": {
            "type": "object",
            "properties": {
                "ticket_id": {"type": "string", "description": "The ticket ID to resolve"},
                "notes": {"type": "string", "description": "Resolution summary / evidence"}
            },
            "required": ["ticket_id"],
        },
    },
    "escalate_ticket": {
        "description": "Escalate a ticket to the next support tier (1st→2nd, 2nd→3rd). Use when investigation finds an issue that needs human attention.",
        "handler": handle_escalate_ticket,
        "inputSchema": {
            "type": "object",
            "properties": {
                "ticket_id": {"type": "string", "description": "The ticket ID to escalate"},
                "notes": {"type": "string", "description": "Reason for escalation"}
            },
            "required": ["ticket_id"],
        },
    },
    "ticket_detail": {
        "description": "Get full details of a single ticket including title, description, priority, SLA target, and resolution notes.",
        "handler": handle_ticket_detail,
        "inputSchema": {
            "type": "object",
            "properties": {
                "ticket_id": {"type": "string", "description": "The ticket ID"}
            },
            "required": ["ticket_id"],
        },
    },
}

# ── MCP Server (JSON-RPC over stdio) ────────────────────────────────

def main():
    """Process JSON-RPC messages from stdin and write responses to stdout."""
    for line in sys.stdin:
        try:
            request = json.loads(line.strip())
        except json.JSONDecodeError:
            continue

        req_id = request.get("id")
        method = request.get("method", "")
        params = request.get("params", {})

        response = {"jsonrpc": "2.0", "id": req_id}

        try:
            if method == "initialize":
                response["result"] = {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {
                        "name": "agentos-service-desk",
                        "version": "1.0.0"
                    },
                }

            elif method == "tools/list":
                response["result"] = {
                    "tools": [
                        {
                            "name": name,
                            "description": tool["description"],
                            "inputSchema": tool["inputSchema"],
                        }
                        for name, tool in TOOLS.items()
                    ]
                }

            elif method == "tools/call":
                tool_name = params.get("name", "")
                tool_args = params.get("arguments", {})
                tool = TOOLS.get(tool_name)

                if not tool:
                    response["error"] = {
                        "code": -32601,
                        "message": f"Tool not found: {tool_name}"
                    }
                else:
                    result = tool["handler"](tool_args)
                    response["result"] = {
                        "content": [{"type": "text", "text": result}]
                    }

            elif method == "notifications/initialized":
                response = None  # No response for notifications

            else:
                response["error"] = {
                    "code": -32601,
                    "message": f"Method not found: {method}",
                }

        except Exception as e:
            response["error"] = {
                "code": -32000,
                "message": str(e),
            }

        if response is not None:
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
