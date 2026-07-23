#!/usr/bin/env python3
"""KS Sports Coaching MCP Server — exposes coaching business tools.

Tools:
  check_unknowns     — List unanswered questions from the chatbot
  add_knowledge      — Add a new FAQ entry to the knowledge base
  update_pricing     — Update a pricing placeholder in the knowledge base
  check_contacts     — List recent contact form submissions
  service_info       — Get info about a specific coaching service
"""
import json
import os
import sys
from pathlib import Path

KNOWLEDGE_FILE = Path("/opt/ks-bot/knowledge.json")
UNKNOWNS_FILE = Path("/var/lib/ks-bot/unknowns.jsonl")
CONTACTS_FILE = Path("/var/lib/ks-bot/contacts.jsonl")

def load_kb() -> dict:
    try:
        return json.loads(KNOWLEDGE_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {"faq": [], "business": {}, "services": [], "credentials": []}

def save_kb(kb: dict):
    KNOWLEDGE_FILE.write_text(json.dumps(kb, indent=2))

def handle_check_unknowns(args: dict) -> str:
    """List unanswered questions from the chatbot."""
    if not UNKNOWNS_FILE.exists():
        return "No unknown questions recorded."
    lines = [f"## Unanswered Questions"]
    count = 0
    for line in UNKNOWNS_FILE.read_text().strip().split("\n"):
        if line.strip():
            try:
                entry = json.loads(line)
                ts = entry.get("timestamp", 0)
                time_str = time.strftime("%Y-%m-%d %H:%M", time.gmtime(ts)) if ts else "unknown"
                lines.append(f"\n  **Q:** {entry.get('message','?')}")
                lines.append(f"  **When:** {time_str}")
                count += 1
            except json.JSONDecodeError:
                pass
    if count == 0:
        return "No unknown questions recorded."
    lines.append(f"\n\n_{count} total unknown questions_")
    return "\n".join(lines)

def handle_add_knowledge(args: dict) -> str:
    """Add a new FAQ entry to the knowledge base."""
    question = args.get("question", "").strip()
    answer = args.get("answer", "").strip()
    if not question or not answer:
        return "Error: question and answer are required"
    kb = load_kb()
    kb.setdefault("faq", []).append({"question": question, "answer": answer})
    save_kb(kb)
    return f"✅ Added FAQ: '{question}'"

def handle_update_pricing(args: dict) -> str:
    """Update a pricing placeholder in the knowledge base."""
    service_name = args.get("service", "").strip()
    price = args.get("price", "").strip()
    if not service_name or not price:
        return "Error: service name and price are required"
    kb = load_kb()
    for s in kb.get("services", []):
        if service_name.lower() in s["name"].lower():
            old_price = s.get("price", "")
            s["price"] = price
            save_kb(kb)
            return f"✅ Updated '{s['name']}' price: {old_price} → {price}"
    return f"⚠️ Service '{service_name}' not found. Available: {', '.join(s['name'] for s in kb.get('services',[]))}"

def handle_check_contacts(args: dict) -> str:
    """List recent contact form submissions."""
    if not CONTACTS_FILE.exists():
        return "No contact form submissions yet."
    lines = [f"## Recent Contact Form Submissions"]
    count = 0
    for line in reversed(CONTACTS_FILE.read_text().strip().split("\n")):
        if line.strip() and count < 10:
            try:
                entry = json.loads(line)
                ts = entry.get("timestamp", 0)
                time_str = time.strftime("%Y-%m-%d %H:%M", time.gmtime(ts)) if ts else "unknown"
                lines.append(f"\n  **{entry.get('name','?')}** ({entry.get('email','?')})")
                lines.append(f"  **Interest:** {entry.get('interest','Not specified')}")
                lines.append(f"  **Message:** {(entry.get('message','') or '')[:150]}")
                lines.append(f"  **When:** {time_str}")
                count += 1
            except json.JSONDecodeError:
                pass
    if count == 0:
        return "No contact form submissions yet."
    return "\n".join(lines)

def handle_service_info(args: dict) -> str:
    """Get info about a specific coaching service."""
    service_name = args.get("service", "").strip()
    kb = load_kb()
    if service_name:
        for s in kb.get("services", []):
            if service_name.lower() in s["name"].lower():
                return (
                    f"## {s['name']}\n"
                    f"**Description:** {s['description']}\n"
                    f"**Duration:** {s['duration']}\n"
                    f"**Price:** {s['price']}\n"
                    f"**Audience:** {s['audience']}"
                )
        return f"Service '{service_name}' not found"
    # List all services
    lines = ["## All Services"]
    for s in kb.get("services", []):
        lines.append(f"\n  **{s['name']}** — {s['price']} ({s['duration']})")
    return "\n".join(lines)

TOOLS = {
    "check_unknowns": {
        "description": "List all unanswered questions from the KS chatbot that need human answers.",
        "handler": handle_check_unknowns,
        "inputSchema": {"type": "object", "properties": {}},
    },
    "add_knowledge": {
        "description": "Add a new FAQ question and answer to the knowledge base so the chatbot can answer it.",
        "handler": handle_add_knowledge,
        "inputSchema": {
            "type": "object",
            "properties": {
                "question": {"type": "string", "description": "The question parents ask"},
                "answer": {"type": "string", "description": "The answer to give"},
            },
            "required": ["question", "answer"],
        },
    },
    "update_pricing": {
        "description": "Update pricing information for a specific coaching service.",
        "handler": handle_update_pricing,
        "inputSchema": {
            "type": "object",
            "properties": {
                "service": {"type": "string", "description": "Service name (e.g. '1-to-1 Coaching')"},
                "price": {"type": "string", "description": "New price text (e.g. 'From £35 per session')"},
            },
            "required": ["service", "price"],
        },
    },
    "check_contacts": {
        "description": "List recent contact form submissions from the KS website.",
        "handler": handle_check_contacts,
        "inputSchema": {"type": "object", "properties": {}},
    },
    "service_info": {
        "description": "Get information about a specific coaching service or list all services.",
        "handler": handle_service_info,
        "inputSchema": {
            "type": "object",
            "properties": {
                "service": {"type": "string", "description": "Service name (leave empty to list all)"}
            },
        },
    },
}

# ── MCP Protocol ────────────────────────────────────────────────────
import time

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
                    "serverInfo": {"name": "ks-bot", "version": "1.0.0"},
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
