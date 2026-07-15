"""Omi (Based Hardware wearable) → AGENT OS memory bridge.

Omi captures real-world conversations and POSTs a summary to a webhook when a
conversation ends. We turn that payload into durable memory: each salient
point becomes a row in `agent_memory` (source='omi') AND a markdown note in the
superbrain vault, plus one consolidated conversation note under vault/capture/.

Everything is best-effort — a malformed payload yields a 200 with a note of
what was (or wasn't) captured, never a 500.
"""
from __future__ import annotations
import logging
import os
import re
from datetime import datetime, timezone

from server import vault

log = logging.getLogger("agentos.omi")

CAPTURE_DIR = os.path.join(vault.VAULT_DIR, "capture")

# Lightweight topic detection — first match wins, else 'general'.
_TOPIC_HINTS = [
    ("customer", ("customer", "client", "lead", "prospect", "sale", "deal", "invoice")),
    ("property", ("property", "site", "facility", "building", "location", "address")),
    ("crew", ("crew", "staff", "team", "hire", "employee", "shift", "dispatch")),
    ("policy", ("policy", "rule", "compliance", "legal", "contract", "brand", "guideline")),
    ("product", ("product", "feature", "roadmap", "launch", "release", "bug")),
    ("finance", ("budget", "revenue", "cost", "price", "payment", "money", "expense")),
]


def detect_topic(text: str) -> str:
    t = (text or "").lower()
    for topic, hints in _TOPIC_HINTS:
        if any(h in t for h in hints):
            return topic
    return "general"


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip()


def _split_points(text: str) -> list[str]:
    """Break a summary into individual salient points (bullets or sentences)."""
    text = (text or "").strip()
    if not text:
        return []
    # Prefer explicit bullet/newline structure.
    parts = [p.strip(" \t-•*") for p in re.split(r"[\n\r]+", text) if p.strip(" \t-•*")]
    if len(parts) > 1:
        return parts
    # Fall back to sentence splitting for a single blob.
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if len(s.strip()) > 8]


def process_webhook(payload: dict, tenant_id: int) -> dict:
    """Turn an Omi webhook payload into vault + agent_memory records.

    Returns a small receipt: {captured, action_items, topic, note, conversation_id}.
    """
    payload = payload or {}
    conv_id = str(payload.get("conversation_id") or payload.get("id") or "unknown")
    summary = _clean(payload.get("summary") or "")
    transcript = _clean(payload.get("transcript") or "")
    action_items = payload.get("action_items") or []
    if isinstance(action_items, str):
        action_items = [action_items]
    # Some Omi payloads wrap items as {description: "..."} objects.
    action_items = [
        (a.get("description") or a.get("content") or "") if isinstance(a, dict) else str(a)
        for a in action_items]
    action_items = [_clean(a) for a in action_items if _clean(a)]

    base_text = summary or transcript
    topic = detect_topic(base_text + " " + " ".join(action_items))
    captured = 0

    # 1) Each salient point from the summary → a collective memory.
    for point in _split_points(summary)[:12]:
        if len(point) < 8:
            continue
        vault.memory_write(
            tenant_id=tenant_id, agent_id=None, memory_type="collective",
            topic=detect_topic(point), fact=point,
            confidence=0.85, source="omi")
        captured += 1

    # 2) Action items → higher-confidence 'action' memories.
    for item in action_items[:12]:
        vault.memory_write(
            tenant_id=tenant_id, agent_id=None, memory_type="collective",
            topic="action", fact=f"Action: {item}",
            confidence=0.95, source="omi")
        captured += 1

    # 3) If nothing structured, keep at least the transcript gist.
    if captured == 0 and transcript:
        vault.memory_write(
            tenant_id=tenant_id, agent_id=None, memory_type="collective",
            topic=topic, fact=transcript[:600], confidence=0.7, source="omi")
        captured += 1

    # 4) Consolidated conversation note under vault/capture/ (Obsidian-linkable).
    note_path = _write_capture_note(conv_id, topic, summary, transcript,
                                    action_items, payload)

    log.info("omi capture %s → %d memories (topic=%s)", conv_id, captured, topic)
    return {"captured": captured, "action_items": len(action_items),
            "topic": topic, "note": note_path, "conversation_id": conv_id}


def _write_capture_note(conv_id, topic, summary, transcript, action_items, payload) -> str:
    os.makedirs(CAPTURE_DIR, exist_ok=True)
    now = datetime.now(timezone.utc)
    stamp = now.strftime("%Y-%m-%d_%H%M")
    slug = vault._slugify(summary or conv_id)
    path = os.path.join(CAPTURE_DIR, f"{stamp}_omi_{slug}.md")
    meta = {
        "source": "omi", "type": "conversation", "topic": topic,
        "conversation_id": conv_id,
        "started_at": payload.get("started_at", ""),
        "ended_at": payload.get("ended_at", ""),
        "created_at": now.isoformat(),
    }
    lines = [vault._frontmatter(meta), "", f"# Omi conversation — {topic}", ""]
    if summary:
        lines += ["## Summary", summary, ""]
    if action_items:
        lines += ["## Action items", *[f"- [ ] {a}" for a in action_items], ""]
    if transcript:
        lines += ["## Transcript", transcript, ""]
    lines += [f"Linked topic: [[memories/{topic}]]"]
    try:
        with open(path, "w") as f:
            f.write("\n".join(lines))
    except OSError as e:
        log.warning("could not write omi capture note: %s", e)
        return ""
    return path
