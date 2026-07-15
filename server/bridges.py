"""Bridges — connectors that expose external platforms inside AGENT OS.

Each bridge knows how to (a) test its connection and (b) describe the
virtual agents/resources it contributes. Everything degrades gracefully:
a missing key or offline service returns a status dict, never raises.

Platforms: hermes | chatgpt | fal | claude_sdk | kimi | omi
"""
from __future__ import annotations
import json
import os
import random
import sqlite3
import time
import urllib.request

from server import inference

HERMES_DB = os.path.expanduser("~/.hermes/state.db")
VAULT_DIR = os.path.expanduser("~/.superbrain/vault")

PLATFORMS = ("hermes", "chatgpt", "fal", "claude_sdk", "kimi", "omi")

PLATFORM_META = {
    "hermes": {"label": "Hermes", "kind": "memory",
               "blurb": "Session history + superbrain vault"},
    "chatgpt": {"label": "ChatGPT", "kind": "inference",
                "blurb": "OpenAI assistants as proxied agents"},
    "fal": {"label": "Fal.ai", "kind": "media",
            "blurb": "Image generation capability"},
    "claude_sdk": {"label": "Claude SDK", "kind": "inference",
                   "blurb": "Anthropic models for agent runs"},
    "kimi": {"label": "Kimi", "kind": "inference",
             "blurb": "Moonshot models for agent runs"},
    "omi": {"label": "Omi", "kind": "wearable",
            "blurb": "Omi wearable conversations → vault memory (webhook)"},
}

# Platforms that expose a two-way chat surface inside AGENT OS.
CHATTABLE = ("hermes", "chatgpt", "fal", "claude_sdk", "kimi", "omi")


def _http_json(url, headers, timeout=15):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def test_connection(platform: str, config: dict) -> dict:
    """Return {status: connected|disconnected|error, detail: str, ...}."""
    fn = {
        "hermes": _test_hermes, "chatgpt": _test_chatgpt, "fal": _test_fal,
        "claude_sdk": _test_claude, "kimi": _test_kimi, "omi": _test_omi,
    }.get(platform)
    if not fn:
        return {"status": "error", "detail": f"unknown platform '{platform}'"}
    try:
        return fn(config or {})
    except Exception as e:
        return {"status": "error", "detail": str(e)}


# ── Hermes ──────────────────────────────────────────────────────────────

def _test_hermes(config) -> dict:
    have_db = os.path.exists(HERMES_DB)
    have_vault = os.path.isdir(VAULT_DIR)
    sessions = 0
    if have_db:
        try:
            conn = sqlite3.connect(f"file:{HERMES_DB}?mode=ro", uri=True)
            tables = {r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
            for cand in ("sessions", "conversations", "messages"):
                if cand in tables:
                    sessions = conn.execute(f"SELECT COUNT(*) FROM {cand}").fetchone()[0]
                    break
            conn.close()
        except Exception as e:
            return {"status": "error", "detail": f"hermes db: {e}"}
    status = "connected" if (have_db or have_vault) else "disconnected"
    return {"status": status,
            "detail": f"db={'yes' if have_db else 'no'} vault={'yes' if have_vault else 'no'}",
            "sessions": sessions}


def hermes_sessions(limit=25) -> list:
    """Recent Hermes sessions as virtual-agent seeds. Empty on any error."""
    if not os.path.exists(HERMES_DB):
        return []
    try:
        conn = sqlite3.connect(f"file:{HERMES_DB}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        tables = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        table = next((c for c in ("sessions", "conversations") if c in tables), None)
        if not table:
            return []
        rows = [dict(r) for r in conn.execute(
            f"SELECT * FROM {table} ORDER BY rowid DESC LIMIT ?", (limit,))]
        conn.close()
        return rows
    except Exception:
        return []


# ── ChatGPT (OpenAI) ────────────────────────────────────────────────────

def _openai_key(config) -> str:
    return (config.get("api_key") or os.environ.get("OPENAI_API_KEY", "")).strip()


def _test_chatgpt(config) -> dict:
    key = _openai_key(config)
    if not key:
        return {"status": "disconnected", "detail": "no OpenAI API key"}
    data = _http_json("https://api.openai.com/v1/models",
                      {"Authorization": f"Bearer {key}"})
    n = len(data.get("data", []))
    return {"status": "connected", "detail": f"{n} models available", "models": n}


def chatgpt_run(config, prompt: str, system: str = "") -> str | None:
    key = _openai_key(config)
    if not key:
        return None
    body = json.dumps({
        "model": config.get("model", "gpt-4o-mini"),
        "messages": ([{"role": "system", "content": system}] if system else [])
                    + [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request("https://api.openai.com/v1/chat/completions",
        data=body, method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            data = json.loads(r.read())
        return data["choices"][0]["message"]["content"]
    except Exception:
        return None


# ── Fal.ai ──────────────────────────────────────────────────────────────

def _test_fal(config) -> dict:
    key = (config.get("api_key") or os.environ.get("FAL_KEY", "")).strip()
    if not key:
        return {"status": "disconnected", "detail": "no Fal.ai API key"}
    # Fal has no cheap unauthenticated ping; treat a present, well-formed key
    # as connected and let the first real generation surface any auth error.
    return {"status": "connected", "detail": "key present",
            "model": config.get("model", "fal-ai/flux/dev")}


def fal_generate(config, prompt: str) -> dict:
    """Submit an image generation. Returns {status, image_url|error}."""
    key = (config.get("api_key") or os.environ.get("FAL_KEY", "")).strip()
    if not key:
        return {"status": "error", "error": "no Fal.ai API key"}
    model = config.get("model", "fal-ai/flux/dev")
    body = json.dumps({"prompt": prompt}).encode()
    req = urllib.request.Request(f"https://fal.run/{model}", data=body, method="POST",
        headers={"Authorization": f"Key {key}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            data = json.loads(r.read())
        img = (data.get("images") or [{}])[0].get("url")
        return {"status": "ok", "image_url": img, "raw": data}
    except Exception as e:
        return {"status": "error", "error": str(e)}


# ── Claude SDK ──────────────────────────────────────────────────────────

def _test_claude(config) -> dict:
    key = (config.get("api_key") or os.environ.get("ANTHROPIC_API_KEY", "")
           or inference._key("ANTHROPIC_API_KEY", "/etc/agent-os/anthropic-api-key"))
    if not key:
        return {"status": "disconnected", "detail": "no Anthropic API key"}
    out = inference.generate("You are a connection test.", "Reply with OK.",
                             model="claude", max_tokens=8, api_key=key)
    return ({"status": "connected", "detail": "handshake ok"} if out
            else {"status": "error", "detail": "no response from Anthropic"})


# ── Kimi (Moonshot) ─────────────────────────────────────────────────────

def _test_kimi(config) -> dict:
    key = (config.get("api_key") or os.environ.get("MOONSHOT_API_KEY", "")
           or inference._key("MOONSHOT_API_KEY", "/etc/agent-os/moonshot-api-key"))
    if not key:
        return {"status": "disconnected", "detail": "no Moonshot API key"}
    out = inference.generate("You are a connection test.", "Reply with OK.",
                             model="kimi", max_tokens=8, api_key=key)
    return ({"status": "connected", "detail": "handshake ok"} if out
            else {"status": "error", "detail": "no response from Moonshot"})


# ── Omi (Based Hardware wearable) ───────────────────────────────────────

def _test_omi(config) -> dict:
    """Omi is push-only via webhook — always 'connected' once added; it needs
    no key, just the webhook URL configured on the Omi side."""
    have_vault = os.path.isdir(VAULT_DIR)
    return {"status": "connected",
            "detail": "webhook ready" + ("" if have_vault else " (vault missing)"),
            "webhook": "/api/omi/webhook"}


# ── Chat surface (POST /api/bridges/:id/chat) ───────────────────────────

def hermes_chat(message: str = "", agent_id: int | None = None) -> str:
    """Chat with the Hermes agent. Creates an inbox message and triggers
    the agent run pipeline so Hermes responds via AI (DeepSeek/Claude)."""
    if not agent_id:
        return "Hermes agent not found in this tenant."
    try:
        from server import app as agentos_app
        conn = agentos_app.get_db()
        from server import agents, db as db_module
        a = db_module.one(conn, "SELECT * FROM agents WHERE id = ?", (agent_id,))
        if not a:
            return "Hermes agent not found."
        mid = db_module.insert(conn, "agent_inbox", {
            "tenant_id": a["tenant_id"], "to_agent_id": agent_id,
            "from_agent_id": None, "subject": "Chat",
            "body": message, "status": "pending",
        })
        conn.execute("UPDATE agent_inbox SET thread_id = ? WHERE id = ?", (mid, mid))
        conn.commit()
        result = agents.run_agent(conn, db_module, dict(a), a["tenant_id"])
        if result.get("action") == "error":
            return f"Hermes encountered an error: {result.get('summary', 'unknown')}"
        details = result.get("details") or {}
        draft = details.get("draft") or details.get("content") or ""
        return draft.strip() or "Hermes processed your message."
    except Exception as e:
        return f"Hermes error: {e}"


def bridge_chat(platform: str, config: dict, message: str) -> dict:
    """Route a chat message to the right backend. Always returns
    {reply: str, ok: bool} and never raises."""
    config = config or {}
    message = (message or "").strip()
    try:
        if platform == "hermes":
            aid = config.get("agent_id")
            return {"ok": True, "reply": hermes_chat(message, agent_id=aid)}
        if platform == "chatgpt":
            out = chatgpt_run(config, message,
                              system="You are a helpful assistant proxied inside AGENT OS.")
            return ({"ok": True, "reply": out} if out else
                    {"ok": False, "reply": "ChatGPT is unavailable — check the API key on this connection."})
        if platform == "claude_sdk":
            out = inference.generate(
                "You are Claude, answering inside the AGENT OS command centre.",
                message, model="claude", max_tokens=500,
                api_key=config.get("api_key"))
            return ({"ok": True, "reply": out} if out else
                    {"ok": False, "reply": "Claude is unavailable — check the Anthropic API key."})
        if platform == "kimi":
            out = inference.generate(
                "You are Kimi, answering inside the AGENT OS command centre.",
                message, model="kimi", max_tokens=500,
                api_key=config.get("api_key"))
            return ({"ok": True, "reply": out} if out else
                    {"ok": False, "reply": "Kimi is unavailable — check the Moonshot API key."})
        if platform == "fal":
            return {"ok": True, "reply": "Fal.ai is an image engine — head to the "
                    "**Studio** to generate images from a prompt."}
        if platform == "omi":
            return {"ok": True, "reply": "Omi is a push-only wearable bridge. Conversations "
                    "captured on your Omi arrive automatically and become vault memories."}
    except Exception as e:  # defensive — bridges never raise to the handler
        return {"ok": False, "reply": f"Bridge error: {e}"}
    return {"ok": False, "reply": f"'{platform}' has no chat surface."}
