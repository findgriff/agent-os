#!/usr/bin/env python3
"""Max Gleam MCP Server — exposes cleaning operations as MCP tools.

Tools:
  check_jobs          — Get today's completed and scheduled job counts
  check_escalations   — Get pending work requests needing attention
  job_detail          — Get details of a specific job by ID
  property_info       — Get property details by ID
  run_briefing        — Run the daily briefing summary
"""
import json
import os
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone

DB_PATH = "/var/lib/maxgleam/app.db"
SCRIPT_PATH = "/opt/hermes-superbrain/maxgleam-agent.py"

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def handle_check_jobs(args: dict) -> str:
    """Get today's job counts."""
    conn = get_db()
    today = datetime.now().strftime("%Y-%m-%d")
    done = conn.execute("SELECT COUNT(*) FROM jobs WHERE status='done' AND scheduled_date=?", (today,)).fetchone()[0]
    scheduled = conn.execute("SELECT COUNT(*) FROM jobs WHERE status='scheduled' AND scheduled_date=?", (today,)).fetchone()[0]
    total = conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
    active_partners = conn.execute("SELECT COUNT(*) FROM partner_companies WHERE active=1").fetchone()[0]
    active_crew = conn.execute("SELECT COUNT(*) FROM subcontractors WHERE active=1").fetchone()[0]
    conn.close()
    return (
        f"## Max Gleam — Job Status ({today})\n\n"
        f"**Jobs:** {done} completed today, {scheduled} scheduled today\n"
        f"**Total jobs in system:** {total}\n"
        f"**Partners:** {active_partners} active\n"
        f"**Crew:** {active_crew} active"
    )

def handle_check_escalations(args: dict) -> str:
    """Get pending work requests that need attention."""
    conn = get_db()
    pending = conn.execute(
        "SELECT * FROM work_requests WHERE status='pending' OR status='accepted' ORDER BY id ASC LIMIT 20"
    ).fetchall()
    conn.close()
    if not pending:
        return "No pending work requests needing attention."
    lines = [f"## Pending Work Requests ({len(pending)})"]
    for wr in pending:
        lines.append(f"\n  #{wr['id']}: {wr.get('title','?')}")
        lines.append(f"    Status: {wr['status']} | Partner: {wr.get('partner_company_id','?')}")
        notes = (wr.get('notes') or '')[:100]
        if notes:
            lines.append(f"    Notes: {notes}")
    return "\n".join(lines)

def handle_job_detail(args: dict) -> str:
    """Get details of a specific job."""
    jid = args.get("job_id")
    if not jid:
        return "Error: job_id is required"
    conn = get_db()
    job = conn.execute("SELECT * FROM jobs WHERE id=?", (jid,)).fetchone()
    if not job:
        conn.close()
        return f"Job #{jid} not found"
    conn.close()
    job = dict(job)
    return (
        f"## Job #{jid}\n"
        f"**Property:** {job.get('property_id','?')}\n"
        f"**Scheduled:** {job.get('scheduled_date','?')}\n"
        f"**Status:** {job.get('status','?')}\n"
        f"**Crew:** {job.get('subcontractor_id','?')}\n"
        f"**Price:** £{job.get('price_pence',0)/100:.2f}\n"
        f"**Notes:** {(job.get('notes') or 'None')[:200]}"
    )

def handle_property_info(args: dict) -> str:
    """Get property details."""
    pid = args.get("property_id")
    if not pid:
        return "Error: property_id is required"
    conn = get_db()
    prop = conn.execute("SELECT * FROM properties WHERE id=?", (pid,)).fetchone()
    if not prop:
        conn.close()
        return f"Property #{pid} not found"
    conn.close()
    prop = dict(prop)
    return (
        f"## Property #{pid}\n"
        f"**Address:** {prop.get('address','?')}\n"
        f"**Partner:** {prop.get('partner_company_id','?')}\n"
        f"**Frequency:** Every {prop.get('frequency_weeks','?')} weeks\n"
        f"**Price:** £{prop.get('price_pence',0)/100:.2f}\n"
        f"**Access:** {(prop.get('access_notes') or 'None')[:200]}"
    )

def handle_run_briefing(args: dict) -> str:
    """Run the daily briefing and return results."""
    try:
        result = subprocess.run(
            ["/usr/bin/python3", SCRIPT_PATH, "briefing"],
            capture_output=True, text=True, timeout=30
        )
        output = result.stdout or result.stderr or "No output"
        return f"## Daily Briefing\n\n{output[:2000]}"
    except Exception as e:
        return f"Error running briefing: {e}"

TOOLS = {
    "check_jobs": {
        "description": "Get today's completed and scheduled job counts plus active partners and crew.",
        "handler": handle_check_jobs,
        "inputSchema": {"type": "object", "properties": {}},
    },
    "check_escalations": {
        "description": "List pending work requests that need attention, including missed cleans and damage reports.",
        "handler": handle_check_escalations,
        "inputSchema": {"type": "object", "properties": {}},
    },
    "job_detail": {
        "description": "Get full details of a specific job by ID.",
        "handler": handle_job_detail,
        "inputSchema": {
            "type": "object",
            "properties": {"job_id": {"type": "string", "description": "The job ID"}},
            "required": ["job_id"],
        },
    },
    "property_info": {
        "description": "Get property details including address, frequency, price, and access notes.",
        "handler": handle_property_info,
        "inputSchema": {
            "type": "object",
            "properties": {"property_id": {"type": "string", "description": "The property ID"}},
            "required": ["property_id"],
        },
    },
    "run_briefing": {
        "description": "Generate the daily operations briefing for Max Gleam.",
        "handler": handle_run_briefing,
        "inputSchema": {"type": "object", "properties": {}},
    },
}

# ── MCP Protocol ────────────────────────────────────────────────────
def main():
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
                    "serverInfo": {"name": "maxgleam", "version": "1.0.0"},
                }
            elif method == "tools/list":
                response["result"] = {
                    "tools": [
                        {"name": n, "description": t["description"], "inputSchema": t["inputSchema"]}
                        for n, t in TOOLS.items()
                    ]
                }
            elif method == "tools/call":
                tool_name = params.get("name", "")
                tool_args = params.get("arguments", {})
                tool = TOOLS.get(tool_name)
                if not tool:
                    response["error"] = {"code": -32601, "message": f"Tool not found: {tool_name}"}
                else:
                    result = tool["handler"](tool_args)
                    response["result"] = {"content": [{"type": "text", "text": result}]}
            elif method == "notifications/initialized":
                response = None
            else:
                response["error"] = {"code": -32601, "message": f"Method not found: {method}"}
        except Exception as e:
            response["error"] = {"code": -32000, "message": str(e)}

        if response is not None:
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()

if __name__ == "__main__":
    main()
