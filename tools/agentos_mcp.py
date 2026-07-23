#!/usr/bin/env python3
"""AGENT OS MCP Server — exposes AGENT OS platform tools.

Tools:
  check_agents       — List all agents and their status
  check_projects     — List all projects/tenants
  galaxy_search      — Search memory galaxy for topics
  workspace_items    — List recent workspace gallery items
  platform_health    — Health check of all AGENT OS services
  service_status     — Check systemd service status
"""
import json
import os
import sqlite3
import subprocess
import sys
import time

DB_PATH = "/var/lib/agent-os/data.db"

SERVICES = [
    "agent-os", "ks-bot", "maxgleam", "deepseek-proxy",
    "caddy", "postgrest", "opspocket-inference"
]

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def handle_check_agents(args: dict) -> str:
    """List all AGENT OS agents and their current status."""
    conn = get_db()
    agents = conn.execute("SELECT id, name, role, last_status, last_summary, real_name FROM agents ORDER BY id").fetchall()
    conn.close()
    if not agents:
        return "No agents found in AGENT OS."
    lines = ["## AGENT OS — Agent Fleet"]
    for a in agents:
        status_icon = {"running": "🟢", "idle": "🟡", "error": "🔴", "flagged": "⚠️"}.get(a["last_status"], "⚪")
        role = a["role"] if a["role"] else "?"
        lines.append(f"\n{status_icon} #{a['id']} **{a['name']}** ({role})")
        if a["real_name"]:
            lines.append(f"   Real: {a['real_name']}")
        lines.append(f"   Status: {a['last_status']}")
        if a["last_summary"]:
            lines.append(f"   Last: {(a['last_summary'])[:100]}")
    return "\n".join(lines)

def handle_check_projects(args: dict) -> str:
    """List all projects/tenants."""
    conn = get_db()
    tenants = conn.execute("SELECT id, name, slug, brand_colour FROM tenants ORDER BY id").fetchall()
    conn.close()
    if not tenants:
        return "No tenants/projects found."
    lines = ["## AGENT OS — Projects"]
    for t in tenants:
        lines.append(f"\n  #{t['id']} **{t['name']}** ({t['slug']})")
    return "\n".join(lines)

def handle_galaxy_search(args: dict) -> str:
    """Search memory galaxy for topics."""
    query = args.get("query", "").strip()
    if not query:
        return "Error: query is required"
    conn = get_db()
    try:
        memories = conn.execute(
            "SELECT id, topic AS topic, fact, source, created_at FROM agent_memory WHERE fact LIKE ? ORDER BY created_at DESC LIMIT 20",
            (f"%{query}%",)
        ).fetchall()
    except sqlite3.OperationalError:
        conn.close()
        return "The 'memories' table does not exist yet in the database — no memories have been imported."
    conn.close()
    if not memories:
        return f"No memories found matching '{query}'."
    lines = [f"## Memory Galaxy — Results for '{query}'"]
    for m in memories:
        ts = time.strftime("%Y-%m-%d", time.gmtime(m["created_at"])) if m["created_at"] else "?"
        lines.append(f"\n  📌 **{m['topic']}** ({ts})")
        lines.append(f"     {(m['fact'] or '')[:200]}")
        source = m["source"] if m["source"] else "?"
        lines.append(f"     Source: {source}")
    return "\n".join(lines)

def handle_workspace_items(args: dict) -> str:
    """List recent workspace gallery items."""
    limit = min(int(args.get("limit", 10)), 50)
    conn = get_db()
    items = conn.execute(
        "SELECT id, type, title, description, created_at, tenant_id FROM workspace_items ORDER BY created_at DESC LIMIT ?",
        (limit,)
    ).fetchall()
    conn.close()
    if not items:
        return "No workspace items found."
    lines = [f"## Workspace Gallery — Last {len(items)} Items"]
    for i in items:
        ts = time.strftime("%Y-%m-%d %H:%M", time.gmtime(i["created_at"])) if i["created_at"] else "?"
        title = i["title"] if i["title"] else "?"
        lines.append(f"\n  #{i['id']} **{title}** ({i['type']})")
        lines.append(f"     Tenant: {i['tenant_id']} | {ts}")
        if i["description"]:
            lines.append(f"     {(i['description'])[:150]}")
    return "\n".join(lines)

def handle_platform_health(args: dict) -> str:
    """Health check of all AGENT OS services."""
    results = []
    for svc in SERVICES:
        r = subprocess.run(["systemctl", "is-active", svc], capture_output=True, text=True, timeout=5)
        status = r.stdout.strip()
        icon = {"active": "✅", "inactive": "❌", "failed": "🔴"}.get(status, "⚠️")
        results.append(f"{icon} **{svc}**: {status}")
    return "## Platform Health\n" + "\n".join(results)

def handle_service_status(args: dict) -> str:
    """Check the status of a specific systemd service."""
    svc = args.get("service", "").strip()
    if not svc:
        services_list = ", ".join(SERVICES)
        return f"Error: service is required. Available: {services_list}"
    r = subprocess.run(["systemctl", "status", svc], capture_output=True, text=True, timeout=5)
    out = r.stdout or r.stderr or ""
    # Show just the key lines
    lines = []
    for line in out.split("\n"):
        if "Active:" in line or "Loaded:" in line or "Main PID" in line or "Process:" in line:
            lines.append(line.strip())
    return f"## {svc}\n" + "\n".join(lines[:10]) if lines else out[:1000]

TOOLS = {
    "check_agents": {
        "description": "List all AGENT OS agent profiles and their current status (running/idle/error).",
        "handler": handle_check_agents,
        "inputSchema": {"type": "object", "properties": {}},
    },
    "check_projects": {
        "description": "List all business projects/tenants in AGENT OS.",
        "handler": handle_check_projects,
        "inputSchema": {"type": "object", "properties": {}},
    },
    "galaxy_search": {
        "description": "Search the memory galaxy for facts about topics, people, or projects.",
        "handler": handle_galaxy_search,
        "inputSchema": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "Search term for memories"}},
            "required": ["query"],
        },
    },
    "workspace_items": {
        "description": "List recent items in the workspace gallery (images, content, etc).",
        "handler": handle_workspace_items,
        "inputSchema": {
            "type": "object",
            "properties": {"limit": {"type": "string", "description": "Max items to return"}},
        },
    },
    "platform_health": {
        "description": "Check the health status of all AGENT OS platform services.",
        "handler": handle_platform_health,
        "inputSchema": {"type": "object", "properties": {}},
    },
    "service_status": {
        "description": "Get detailed status of a specific systemd service.",
        "handler": handle_service_status,
        "inputSchema": {
            "type": "object",
            "properties": {"service": {"type": "string", "description": "Service name"}},
            "required": ["service"],
        },
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
                    "serverInfo": {"name": "agentos", "version": "1.0.0"},
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
