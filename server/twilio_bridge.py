"""Twilio API wrapper for the Call Center system.
Handles making outbound calls via Twilio's REST API.
Uses stdlib only — no pip installs needed.

Credentials are read from the environment at call time (NOT at import time —
the systemd unit and the CLI populate os.environ at different moments):
    TWILIO_ACCOUNT_SID
    TWILIO_AUTH_TOKEN
    TWILIO_PHONE_NUMBER

Set them in /etc/agent-os.env (the systemd EnvironmentFile). For CLI runs
they are also picked up from ~/.hermes/.env as a fallback.

The webhook base URL is TWILIO_WEBHOOK_BASE (default https://agents.opspocket.com).
It must be a public HTTPS origin that reverse-proxies to this server, because
Twilio fetches the conversation TwiML from it mid-call.
"""
import base64
import hashlib
import hmac
import json
import os
import urllib.request
import urllib.error
from pathlib import Path
from urllib.parse import urlencode, quote
from xml.sax.saxutils import escape as xml_escape

# Env files consulted (in order) when a Twilio var is missing from os.environ.
# systemd already loads /etc/agent-os.env; this is for CLI invocations.
ENV_FILES = (Path("/etc/agent-os.env"), Path(os.path.expanduser("~/.hermes/.env")))

DEFAULT_WEBHOOK_BASE = "https://agents.opspocket.com"
_env_loaded = False


def _load_env_files() -> None:
    """Populate os.environ from the env files, without overriding what's set."""
    global _env_loaded
    if _env_loaded:
        return
    _env_loaded = True
    for path in ENV_FILES:
        try:
            if not path.exists():
                continue
            for line in path.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, val = line.split("=", 1)
                key = key.strip()
                if key and key not in os.environ:
                    os.environ[key] = val.strip().strip("'\"")
        except OSError:
            continue


def creds() -> tuple[str, str, str]:
    """Return (account_sid, auth_token, phone_number), reading env lazily."""
    _load_env_files()
    return (
        os.environ.get("TWILIO_ACCOUNT_SID", ""),
        os.environ.get("TWILIO_AUTH_TOKEN", ""),
        os.environ.get("TWILIO_PHONE_NUMBER", ""),
    )


def is_configured() -> bool:
    sid, token, phone = creds()
    return bool(sid and token and phone)


def config_status() -> dict:
    """Which Twilio settings are present — never returns the values themselves."""
    sid, token, phone = creds()
    return {
        "account_sid": bool(sid),
        "auth_token": bool(token),
        "phone_number": bool(phone),
        "webhook_base": webhook_base(),
        "configured": bool(sid and token and phone),
    }


def webhook_base() -> str:
    _load_env_files()
    return os.environ.get("TWILIO_WEBHOOK_BASE", DEFAULT_WEBHOOK_BASE).rstrip("/")


def webhook_url(path: str = "/api/call-center/handle-response", **params) -> str:
    """Absolute URL Twilio should POST to. Relative TwiML action URLs do not
    work for inline TwiML (there is no base URL to resolve them against), so
    every action URL must be absolute."""
    url = f"{webhook_base()}{path}"
    if params:
        url += "?" + urlencode(params, quote_via=quote)
    return url


def _auth_header(sid: str, token: str) -> str:
    return "Basic " + base64.b64encode(f"{sid}:{token}".encode()).decode()


def _req(method: str, path: str, data: dict | None = None) -> dict:
    sid, token, _ = creds()
    if not sid or not token:
        return {"error": "Twilio not configured"}
    url = f"https://api.twilio.com/2010-04-01/Accounts/{sid}/{path}"
    headers = {"Authorization": _auth_header(sid, token), "Accept": "application/json"}
    body = None
    if data:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        body = urlencode(data).encode()

    try:
        req = urllib.request.Request(url, data=body, method=method, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}", "detail": e.read().decode()[:300]}
    except Exception as e:
        return {"error": str(e)}


# ── TwiML builders ───────────────────────────────────────────────────
# All caller-supplied text is XML-escaped. Script copy contains apostrophes
# and ampersands ("Bar & Grill"), which would otherwise produce invalid TwiML
# and drop the call.

VOICE = "alice"
LANG = "en-GB"


def _say(text: str) -> str:
    return f'<Say voice="{VOICE}" language="{LANG}">{xml_escape(text or "")}</Say>'


def gather_twiml(say: str, business: str, prompt: str = "Go ahead, I'm listening.",
                 timeout: int = 5, fallback: str = "I didn't catch that. Thanks for your time. Goodbye.") -> str:
    """Speak `say`, then listen. Twilio POSTs the transcript to the absolute
    action URL, carrying ?business= so the handler knows which script to use."""
    action = webhook_url(business=business)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    {_say(say)}
    <Gather input="speech" timeout="{timeout}" speechTimeout="auto" method="POST" action="{xml_escape(action)}">
        {_say(prompt)}
    </Gather>
    {_say(fallback)}
</Response>"""


def hangup_twiml(closing: str) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    {_say(closing)}
    <Hangup/>
</Response>"""


def make_call(to_number: str, twiml: str, caller_id: str | None = None,
              status_callback: str | None = None) -> dict:
    sid, token, phone = creds()
    if not sid or not token:
        return {"error": "Twilio not configured"}
    if not phone and not caller_id:
        return {"error": "No caller ID configured"}
    data = {"To": to_number, "From": caller_id or phone, "Twiml": twiml}
    if status_callback:
        data["StatusCallback"] = status_callback
        data["StatusCallbackMethod"] = "POST"
    return _req("POST", "Calls.json", data)


def hangup(call_sid: str) -> dict:
    return _req("POST", f"Calls/{call_sid}.json", {"Status": "completed"})


def get_call(call_sid: str) -> dict:
    return _req("GET", f"Calls/{call_sid}.json")


def check_balance() -> dict:
    return _req("GET", "Balance.json")


# ── Webhook authenticity ─────────────────────────────────────────────

def validate_signature(signature: str, url: str, params: dict) -> bool:
    """Verify Twilio's X-Twilio-Signature header.

    /api/call-center/handle-response is unauthenticated (Twilio cannot send a
    bearer token), so without this check anyone could POST fake speech and burn
    OpenRouter credit. Fails OPEN when no auth token is configured, so local
    and dry-run testing still works.
    """
    _, token, _ = creds()
    if not token:
        return True
    if not signature:
        return False
    payload = url + "".join(f"{k}{params[k]}" for k in sorted(params))
    digest = hmac.new(token.encode(), payload.encode(), hashlib.sha1).digest()
    return hmac.compare_digest(base64.b64encode(digest).decode(), signature)
