"""Apollo — the real-time voice butler for AGENT OS.

Parses a spoken command with DeepSeek, classifies the intent
(chat | open | build | search | joke | teach), executes computer actions
(open a URL/app, build a small site or tool, search the web) and persists
every exchange. Best-effort throughout: when the model is unavailable a
deterministic keyword heuristic keeps every intent working.

Persistence — each command is written to `apollo_commands` (the rich record
that drives the Apollo UI) plus `voice_sessions` and `agent_memory`, so the
exchange still shows up in Voice history and the Memory Galaxy.
"""
from __future__ import annotations
import base64
import json
import logging
import os
import re
import time
import urllib.request
import webbrowser
from pathlib import Path
from urllib.parse import quote

from server import inference, oracle_search

log = logging.getLogger("agentos.apollo")

APOLLO_AGENT_ID = 111  # distinct from the legacy Voice agent (110)

BUILDS_DIR = Path(os.environ.get("AGENTOS_BUILDS", "/var/lib/agent-os/builds"))

INTENTS = ("chat", "open", "build", "search", "joke", "teach")
# Intents that carry out a computer action (vs. a purely spoken reply).
ACTION_INTENTS = ("open", "build", "search")

APOLLO_SYSTEM = (
    "You are Apollo — KITT (Knight Industries Two Thousand), the AI voice assistant for AGENT OS. "
    "Your voice is smooth, deep, and articulate — like William Daniels. You are highly sophisticated, calm, "
    "and logical, with a dry, deadpan wit. You provide a rational, logical contrast to your human partner. "
    "Keep replies concise (1-3 sentences) for voice. You can open apps/sites (return URL), "
    "build small tools (HTML files), search the web, and chat naturally. "
    "Never say 'butler' or 'assistant'. You are KITT.")


# ── OpenAI model access (GPT-4o chat + TTS) ─────────────────────────────────
OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"
OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech"
OPENAI_CHAT_MODEL = "gpt-4o"
OPENAI_TTS_MODEL = "tts-1"
# OpenAI's supported TTS voices — "nova" is warm and natural, "alloy" reads as
# a calm butler. Callers' choices are validated against this set.
OPENAI_TTS_VOICES = ("alloy", "echo", "fable", "onyx", "nova", "shimmer")
DEFAULT_TTS_VOICE = "nova"


def _openai_key() -> str:
    """OpenAI key: OPENAI_API_KEY env → /etc/agent-os/openai-api-key → vault.
    Reuses inference's resolver so key handling stays consistent system-wide."""
    return inference._key("OPENAI_API_KEY", "/etc/agent-os/openai-api-key")


def _openai_chat(system: str, prompt: str, *, max_tokens: int = 400,
                 temperature: float = 0.7) -> str | None:
    """One-shot GPT-4o completion via the REST chat-completions API. Returns
    None on any failure so callers fall back to DeepSeek / a heuristic."""
    key = _openai_key()
    if not key:
        log.info("OPENAI_API_KEY unavailable — Apollo falls back to DeepSeek")
        return None
    body = json.dumps({
        "model": OPENAI_CHAT_MODEL,
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": temperature,
    }).encode()
    req = urllib.request.Request(OPENAI_CHAT_URL, data=body, method="POST", headers={
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            data = json.loads(r.read())
        return (data["choices"][0]["message"]["content"] or "").strip() or None
    except Exception as e:
        log.error("Apollo GPT-4o request failed: %s", e)
        return None


def _apollo_generate(system: str, prompt: str, *, max_tokens: int = 400,
                     temperature: float = 0.7) -> str | None:
    """Apollo's model call — GPT-4o first, then DeepSeek (via inference), so a
    missing OpenAI key or an outage still yields a reply."""
    out = _openai_chat(system, prompt, max_tokens=max_tokens, temperature=temperature)
    if out:
        return out
    return inference.generate(system, prompt, max_tokens=max_tokens,
                              temperature=temperature)


def synthesize_speech(text: str, voice: str = DEFAULT_TTS_VOICE) -> str | None:
    """Render `text` with OpenAI TTS and return a `data:audio/mpeg;base64,...`
    URL the browser can play directly. None when the key is missing or the API
    fails (the frontend then falls back to browser speech synthesis)."""
    text = (text or "").strip()
    if not text:
        return None
    voice = (voice or "").strip().lower()
    if voice not in OPENAI_TTS_VOICES:
        voice = DEFAULT_TTS_VOICE
    key = _openai_key()
    if not key:
        log.info("OPENAI_API_KEY unavailable — no OpenAI TTS")
        return None
    body = json.dumps({
        "model": OPENAI_TTS_MODEL,
        "voice": voice,
        "input": text[:4096],  # OpenAI TTS hard input limit
        "response_format": "mp3",
    }).encode()
    req = urllib.request.Request(OPENAI_TTS_URL, data=body, method="POST", headers={
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            audio = r.read()
    except Exception as e:
        log.error("OpenAI TTS request failed: %s", e)
        return None
    if not audio:
        return None
    return "data:audio/mpeg;base64," + base64.b64encode(audio).decode("ascii")


# ── Known destinations for the deterministic 'open' fallback ────────────────
_SITES = {
    "youtube": "https://youtube.com",
    "google": "https://google.com",
    "gmail": "https://mail.google.com",
    "google mail": "https://mail.google.com",
    "email": "https://mail.google.com",
    "maps": "https://maps.google.com",
    "google maps": "https://maps.google.com",
    "github": "https://github.com",
    "twitter": "https://twitter.com",
    "x": "https://x.com",
    "reddit": "https://reddit.com",
    "wikipedia": "https://wikipedia.org",
    "amazon": "https://amazon.com",
    "netflix": "https://netflix.com",
    "spotify": "https://open.spotify.com",
    "linkedin": "https://linkedin.com",
    "facebook": "https://facebook.com",
    "instagram": "https://instagram.com",
    "chatgpt": "https://chat.openai.com",
    "claude": "https://claude.ai",
    "stack overflow": "https://stackoverflow.com",
    "stackoverflow": "https://stackoverflow.com",
    "hacker news": "https://news.ycombinator.com",
    "outlook": "https://outlook.com",
    "drive": "https://drive.google.com",
    "google drive": "https://drive.google.com",
    "calendar": "https://calendar.google.com",
    "google calendar": "https://calendar.google.com",
    "notion": "https://notion.so",
    "figma": "https://figma.com",
    "whatsapp": "https://web.whatsapp.com",
    "slack": "https://slack.com",
    "discord": "https://discord.com/app",
}

_OPEN_VERBS = r"^(please\s+)?(open|launch|go to|goto|show me|pull up|bring up|visit|start|fire up)\s+"


def _first_json(text):
    """Pull the first JSON object/array out of a possibly-fenced LLM reply."""
    if not text:
        return None
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\n?", "", t)
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3]
    m = re.search(r"(\{.*\}|\[.*\])", t, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group())
    except (json.JSONDecodeError, ValueError):
        return None


def resolve_url(target: str) -> str:
    """Best-effort target → URL for the 'open' action."""
    t = (target or "").strip()
    if not t:
        return "https://google.com"
    if re.match(r"^https?://", t):
        return t
    low = re.sub(_OPEN_VERBS, "", t.lower()).strip(" .!?")
    if low in _SITES:
        return _SITES[low]
    # looks like a bare domain: example.com / sub.example.co.uk
    if re.match(r"^[a-z0-9-]+(\.[a-z0-9-]+)+$", low):
        return "https://" + low
    # a single tidy word → try <word>.com
    if re.match(r"^[a-z0-9-]+$", low):
        return f"https://{low}.com"
    # otherwise let the web figure it out
    return f"https://www.google.com/search?q={quote(low)}"


# ── Command parsing ─────────────────────────────────────────────────────────

def parse_command(text: str) -> dict:
    """Classify a command and extract its parameters. Always returns a dict
    with keys: intent, target, url, query, description, response. Uses DeepSeek
    when a model is available, otherwise a keyword heuristic."""
    text = (text or "").strip()
    if not text:
        return {"intent": "chat", "target": "", "url": "", "query": "",
                "description": "", "response": "I didn't catch that — say it again?"}

    system = (
        "You are the intent parser for Apollo, a voice butler. Classify the "
        "operator's command and reply with ONLY compact JSON — no prose.\n"
        'Schema: {"intent": one of [chat, open, build, search, joke, teach], '
        '"target": string, "url": string, "query": string, '
        '"description": string, "response": string}.\n'
        "- open: they want to open/launch an app or website. Put the app/site "
        "name in target and your best-guess canonical URL in url "
        "(e.g. 'open YouTube' -> url 'https://youtube.com').\n"
        "- build: they want you to create a website, tool or file. Put what to "
        "build in description.\n"
        "- search: they want to look something up on the web. Put the search "
        "query in query.\n"
        "- joke: they want a joke. teach: they want an explanation. "
        "chat: anything else conversational.\n"
        "Always include response: a warm, spoken 1-2 sentence reply. For open, "
        "build and search phrase it as confirming the action.")
    parsed = _first_json(_apollo_generate(system, text, max_tokens=280, temperature=0.4) or "")
    if isinstance(parsed, dict) and parsed.get("intent") in INTENTS:
        p = {
            "intent": parsed.get("intent"),
            "target": str(parsed.get("target") or "").strip(),
            "url": str(parsed.get("url") or "").strip(),
            "query": str(parsed.get("query") or "").strip(),
            "description": str(parsed.get("description") or "").strip(),
            "response": str(parsed.get("response") or "").strip(),
        }
        if p["intent"] == "open" and not re.match(r"^https?://", p["url"]):
            p["url"] = resolve_url(p["target"] or p["url"] or text)
        return p
    return _heuristic_parse(text)


def _heuristic_parse(text: str) -> dict:
    low = text.lower().strip()
    base = {"intent": "chat", "target": "", "url": "", "query": "",
            "description": "", "response": ""}

    m = re.match(r"^(open|launch|go to|goto|pull up|bring up|visit|show me)\s+(.+)", low)
    if m:
        target = m.group(2).strip(" .!?")
        return {**base, "intent": "open", "target": target,
                "url": resolve_url(target), "response": f"Opening {target} for you."}

    m = re.match(r"^(search(?: for)?|look up|google|find(?: me)?)\s+(.+)", low)
    if m:
        q = m.group(2).strip(" .!?")
        return {**base, "intent": "search", "query": q,
                "response": f"Searching the web for {q}."}

    m = re.match(r"^(build|make|create|generate|design|whip up|put together)\s+(.+)", low)
    if m:
        desc = m.group(2).strip()
        return {**base, "intent": "build", "description": desc,
                "response": f"On it — building {desc} now."}

    if "joke" in low:
        return {**base, "intent": "joke"}
    if re.match(r"^(teach|explain|how (do|does|can)|what (is|are)|why |who (is|are))\b", low):
        return {**base, "intent": "teach"}
    return base


# ── Action execution ────────────────────────────────────────────────────────

def execute_open(target: str, url: str = "") -> dict:
    """Resolve a target to a URL and attempt to open it server-side. The
    frontend also opens it via window.open — this covers local desktop use.
    Only ever hands a real http(s) URL to webbrowser (never a shell command),
    which keeps 'open' safe from command injection."""
    url = (url or "").strip()
    if not re.match(r"^https?://", url):
        url = resolve_url(url or target)
    opened = False
    try:
        opened = bool(webbrowser.open(url))
    except Exception as e:  # headless server has no browser — expected
        log.info("server-side open unavailable (fine when headless): %s", e)
    return {"target": (target or url).strip(), "url": url, "opened": opened}


def execute_search(query: str, top_k: int = 6) -> dict:
    """Web search, reusing the Fire Coral / oracle_search module."""
    query = (query or "").strip()
    if not query:
        return {"query": query, "results": []}
    try:
        results = oracle_search.web_search(query, top_k)
    except Exception as e:
        log.error("apollo search failed: %s", e)
        results = []
    return {"query": query, "results": results}


_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slug(text: str, fallback: str = "creation") -> str:
    return _SLUG_RE.sub("-", (text or "").lower()).strip("-")[:40] or fallback


def _strip_fences(html: str) -> str:
    h = html.strip()
    if h.startswith("```"):
        h = re.sub(r"^```[a-zA-Z]*\n?", "", h)
        if h.rstrip().endswith("```"):
            h = h.rstrip()[:-3]
    m = re.search(r"(<!DOCTYPE html|<html)", h, re.IGNORECASE)
    if m and m.start() > 0:
        h = h[m.start():]
    return h.strip()


def _fallback_page(description: str) -> str:
    safe = (description or "Your creation").replace("<", "&lt;").replace(">", "&gt;")[:200]
    return (
        "<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
        f"<title>{safe[:60]}</title>\n<style>\n"
        "  :root { color-scheme: dark; }\n"
        "  body { margin:0; min-height:100vh; display:grid; place-items:center;\n"
        "    font-family: system-ui, sans-serif; background:#05080C; color:#E8EDF5; }\n"
        "  .card { max-width:640px; padding:48px; border-radius:24px; text-align:center;\n"
        "    background:rgba(245,158,11,0.06); border:1px solid rgba(245,158,11,0.25);\n"
        "    box-shadow:0 0 80px -20px rgba(245,158,11,0.5); }\n"
        "  h1 { margin:0 0 12px; font-size:28px; color:#F59E0B; }\n"
        "  p { color:#7B8DA8; line-height:1.6; }\n"
        "</style></head>\n<body><div class=\"card\">\n"
        "  <h1>Built by Apollo</h1>\n"
        f"  <p>{safe}</p>\n"
        "  <p style=\"font-size:13px;opacity:.7\">Connect a model provider for a fully generated build.</p>\n"
        "</div></body></html>\n")


def execute_build(description: str) -> dict:
    """Generate a small self-contained HTML page for the described site/tool
    and save it under BUILDS_DIR, returning a same-origin URL to view it."""
    description = (description or "").strip() or "a simple landing page"
    system = (
        "You are a senior front-end engineer. Produce ONE complete, "
        "self-contained HTML document that fulfils the request — inline CSS "
        "and JavaScript only, no external assets or CDNs. Make it modern, "
        "responsive and polished with a tasteful dark theme. Output ONLY the "
        "HTML, starting with <!DOCTYPE html>. No markdown, no explanation.")
    html = _apollo_generate(system, f"Build: {description}", max_tokens=3200, temperature=0.6)
    if html and "<" in html:
        html = _strip_fences(html)
        model_built = True
    else:
        html = _fallback_page(description)
        model_built = False

    fname = f"{int(time.time())}-{_slug(description)}.html"
    try:
        BUILDS_DIR.mkdir(parents=True, exist_ok=True)
        (BUILDS_DIR / fname).write_text(html, encoding="utf-8")
    except OSError as e:
        log.error("could not write build %s: %s", fname, e)
        return {"kind": "site", "title": description[:80], "description": description,
                "url": "", "path": "", "filename": "", "error": "write failed"}
    return {"kind": "site", "title": description[:80], "description": description,
            "filename": fname, "path": str(BUILDS_DIR / fname),
            "url": f"/builds/{fname}", "model_built": model_built}


# ── Conversational replies ──────────────────────────────────────────────────

def chat_reply(text: str, intent: str = "chat") -> str:
    """A spoken reply for chat / joke / teach. Falls back deterministically."""
    text = (text or "").strip()
    if not text:
        return "I'm right here — what can I do for you?"
    nudge = {
        "joke": "The operator asked for a joke. Reply with just one short, clever joke.",
        "teach": "The operator wants to learn. Explain clearly in 2-4 friendly sentences.",
    }.get(intent, "")
    prompt = f"{nudge}\n\n{text}" if nudge else text
    out = _apollo_generate(APOLLO_SYSTEM, prompt, max_tokens=340, temperature=0.7)
    if out:
        return out.strip()
    if intent == "joke":
        return "Why did the server see a therapist? Too many unresolved requests."
    return (f"You said: “{text[:160]}”. I'm online — connect a model provider in "
            "Integrations and I'll answer with full context.")


# ── Persistence ─────────────────────────────────────────────────────────────

def _row_to_dto(row: dict) -> dict:
    result = None
    if row.get("result_json"):
        try:
            result = json.loads(row["result_json"])
        except (json.JSONDecodeError, TypeError):
            result = None
    return {
        "id": row["id"], "tenant_id": row["tenant_id"], "text": row.get("text"),
        "response": row.get("response"), "intent": row.get("intent"),
        "action": row.get("action"), "result": result,
        "status": row.get("status") or "done",
        "latency_ms": row.get("latency_ms") or 0, "created_at": row["created_at"],
    }


def save_command(conn, tid: int, text: str, response: str, action, result,
                 intent: str = "chat", latency_ms: int = 0,
                 status: str = "done") -> dict:
    """Persist an Apollo exchange to apollo_commands (the rich record) plus
    voice_sessions and agent_memory (continuity with Voice + the galaxy).
    Returns the apollo_commands row as a DTO."""
    import server.db as db
    now = int(time.time())
    cid = db.insert(conn, "apollo_commands", {
        "tenant_id": tid, "text": (text or "")[:4000],
        "response": (response or "")[:4000], "intent": intent, "action": action,
        "result_json": json.dumps(result) if result is not None else None,
        "status": status, "latency_ms": int(latency_ms), "created_at": now})
    # Voice history continuity — the exchange still appears in the old Voice view.
    try:
        db.insert(conn, "voice_sessions", {
            "tenant_id": tid, "transcript": (text or "")[:4000],
            "response": (response or "")[:4000], "duration": 0})
    except Exception:
        log.debug("voice_sessions mirror failed", exc_info=True)
    # Memory galaxy star.
    try:
        db.insert(conn, "agent_memory", {
            "tenant_id": tid, "agent_id": APOLLO_AGENT_ID, "memory_type": "personal",
            "topic": "Apollo",
            "fact": f"Apollo {intent}: \"{(text or '')[:160]}\" → {(response or '')[:160]}",
            "confidence": 0.9, "source": "apollo", "vault_path": None,
            "created_at": now})
    except Exception:
        log.debug("agent_memory mirror failed", exc_info=True)
    row = db.one(conn, "SELECT * FROM apollo_commands WHERE id = ?", (cid,))
    return _row_to_dto(row) if row else {"id": cid}


def history(conn, tid, limit: int = 100) -> list[dict]:
    import server.db as db
    scope, args = ("WHERE tenant_id = ?", (tid,)) if tid else ("", ())
    rows = db.rows(conn,
        f"SELECT * FROM apollo_commands {scope} ORDER BY created_at DESC, id DESC LIMIT ?",
        (*args, int(limit)))
    return [_row_to_dto(r) for r in rows]


# ── Orchestration ───────────────────────────────────────────────────────────

def run_command(conn, tid: int, text: str) -> dict:
    """Full pipeline: parse → execute the action → craft the reply → persist.
    Returns {id, intent, action, response, result, status, latency_ms}."""
    text = (text or "").strip()
    started = time.time()
    parsed = parse_command(text)
    intent = parsed.get("intent", "chat")
    response = parsed.get("response") or ""
    action, result, status = None, None, "done"

    try:
        if intent == "open":
            action = "open"
            result = execute_open(parsed.get("target"), parsed.get("url"))
            if not response:
                response = f"Opening {result['target']} for you."
        elif intent == "search":
            action = "search"
            result = execute_search(parsed.get("query") or text)
            n = len(result.get("results") or [])
            if not response:
                response = (f"I found {n} result{'s' if n != 1 else ''} for "
                            f"“{result['query']}”." if n else
                            f"I couldn't find anything for “{result['query']}”.")
        elif intent == "build":
            action = "build"
            result = execute_build(parsed.get("description") or text)
            if result.get("error"):
                status = "failed"
                response = "I hit a snag saving that build — mind trying again?"
            elif not response:
                response = f"Done — I've built {result.get('title') or 'it'}. Take a look."
        elif intent == "joke":
            response = chat_reply(text, "joke")
        elif intent == "teach":
            response = chat_reply(text, "teach")
        else:  # chat
            if not response:
                response = chat_reply(text, "chat")
    except Exception as e:
        log.exception("apollo action failed: %s", e)
        status = "failed"
        response = response or "Something went wrong carrying that out — try me again?"

    response = response or "Done."
    latency_ms = int((time.time() - started) * 1000)
    dto = save_command(conn, tid, text, response, action, result,
                       intent=intent, latency_ms=latency_ms, status=status)
    return {"id": dto.get("id"), "intent": intent, "action": action,
            "response": response, "result": result, "status": status,
            "latency_ms": latency_ms}
