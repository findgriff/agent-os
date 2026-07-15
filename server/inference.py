"""Provider-agnostic LLM wrapper for AGENT OS.

Supports DeepSeek, Claude (Anthropic), and Kimi (Moonshot). `generate()`
dispatches on the model name and always soft-fails to None so a missing
key or a provider outage records an error rather than 500ing.

Key resolution (each provider, in priority order):
  DeepSeek: DEEPSEEK_API_KEY env → /etc/agent-os/deepseek-api-key → vault
  Claude:   ANTHROPIC_API_KEY env → /etc/agent-os/anthropic-api-key → vault
  Kimi:     MOONSHOT_API_KEY  env → /etc/agent-os/moonshot-api-key  → vault
Callers may also pass an explicit `api_key` (e.g. from a bridge's
connection config) which takes precedence over all of the above.
"""
from __future__ import annotations
import json
import logging
import os
import urllib.request

log = logging.getLogger("agentos.inference")

DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions"
DEEPSEEK_MODEL = "deepseek-chat"
CLAUDE_MODEL = "claude-opus-4-8"
KIMI_URL = "https://api.moonshot.ai/v1/chat/completions"
KIMI_MODEL = "moonshot-v1-8k"

_VAULT_FILES = (
    "/opt/hermes-superbrain/.credentials.decrypted",
    "/root/.hermes/.env",
)

# USD per million tokens (input, output) — drives the cost dashboard.
PRICING_PER_MTOK = {
    "deepseek": (0.27, 1.10),
    "claude": (5.00, 25.00),
    "kimi": (0.15, 2.50),
}

_last_usage: dict | None = None


def pop_usage() -> dict | None:
    """Return {"prompt_tokens","completion_tokens"} from the most recent
    generate() call and clear it. None when the provider didn't report it."""
    global _last_usage
    u, _last_usage = _last_usage, None
    return u


def estimate_tokens(text: str) -> int:
    return max(1, len(text or "") // 4)


def _set_usage(prompt_tokens, completion_tokens) -> None:
    global _last_usage
    try:
        _last_usage = {"prompt_tokens": int(prompt_tokens),
                       "completion_tokens": int(completion_tokens)}
    except (TypeError, ValueError):
        _last_usage = None


def _key(env_name: str, secret_file: str) -> str:
    val = os.environ.get(env_name, "").strip()
    if val:
        return val
    try:
        with open(secret_file) as f:
            val = f.read().strip()
        if val:
            return val
    except OSError:
        pass
    for path in _VAULT_FILES:
        try:
            with open(path) as f:
                for line in f:
                    if line.startswith(env_name):
                        v = line.split("=", 1)[1].strip().strip("'").strip('"')
                        if v:
                            return v
        except OSError:
            continue
    return ""


def normalise_model(model: str) -> str:
    """Map a UI model choice to a provider key."""
    return (model or "deepseek").strip().lower()


def generate(system: str, prompt: str, *, model: str = "deepseek",
             max_tokens: int = 400, temperature: float = 0.8,
             api_key: str | None = None) -> str | None:
    """Return a completion from the chosen provider, or None on any failure.
    `model` is one of deepseek | claude | kimi (unknown → deepseek)."""
    global _last_usage
    _last_usage = None
    model = normalise_model(model)
    if model == "claude":
        return _generate_claude(system, prompt, max_tokens, api_key)
    if model == "kimi":
        return _generate_openai_compatible(
            system, prompt, max_tokens, temperature,
            url=KIMI_URL, model_name=KIMI_MODEL,
            key=api_key or _key("MOONSHOT_API_KEY", "/etc/agent-os/moonshot-api-key"),
            label="Kimi")
    return _generate_openai_compatible(
        system, prompt, max_tokens, temperature,
        url=DEEPSEEK_URL, model_name=DEEPSEEK_MODEL,
        key=api_key or _key("DEEPSEEK_API_KEY", "/etc/agent-os/deepseek-api-key"),
        label="DeepSeek")


def _generate_openai_compatible(system, prompt, max_tokens, temperature, *,
                                url, model_name, key, label) -> str | None:
    """DeepSeek and Kimi both speak the OpenAI chat-completions dialect."""
    if not key:
        log.warning("%s key unavailable — model unavailable", label)
        return None
    body = json.dumps({
        "model": model_name,
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": temperature,
    }).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            data = json.loads(r.read())
        usage = data.get("usage") or {}
        if usage:
            _set_usage(usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0))
        return (data["choices"][0]["message"]["content"] or "").strip() or None
    except Exception as e:
        log.error("%s request failed: %s", label, e)
        return None


def _generate_claude(system, prompt, max_tokens, api_key) -> str | None:
    key = api_key or _key("ANTHROPIC_API_KEY", "/etc/agent-os/anthropic-api-key")
    if not key:
        log.warning("ANTHROPIC_API_KEY not configured — Claude unavailable")
        return None
    try:
        import anthropic
    except ImportError:
        log.error("anthropic package not installed — Claude unavailable")
        return None
    try:
        client = anthropic.Anthropic(api_key=key)
        resp = client.messages.create(
            model=CLAUDE_MODEL, max_tokens=max_tokens,
            system=system, messages=[{"role": "user", "content": prompt}])
        if resp.stop_reason == "refusal":
            log.warning("Claude declined the request (refusal)")
            return None
        if getattr(resp, "usage", None):
            _set_usage(resp.usage.input_tokens, resp.usage.output_tokens)
        text = "".join(b.text for b in resp.content if b.type == "text").strip()
        return text or None
    except Exception as e:
        log.error("Anthropic request failed: %s", e)
        return None
