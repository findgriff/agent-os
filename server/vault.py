"""Obsidian vault integration — the agent memory system.

Every memory lives twice: as a row in the `agent_memory` SQLite table
(fast querying) and as a markdown note under ~/.superbrain/vault/memories/
(human-browsable, Obsidian-linkable). memory_write() creates both;
memory_sync() reconciles them two-way.

Wikilinks ([[memory/topic]], [[session/id]], [[projects/name]]) inside a
note become edges in the galaxy graph.
"""
from __future__ import annotations
import logging
import os
import re
from datetime import datetime, timezone

from server import db as db_module

log = logging.getLogger("agentos.vault")

VAULT_DIR = os.path.expanduser("~/.superbrain/vault")
FOLDERS = ("memories", "sessions", "projects", "decisions",
           "people", "lessons", "daily")
MEM_DIR = os.path.join(VAULT_DIR, "memories")

_db_path: str | None = None

# topic → constellation (drives galaxy colour groups)
_CONSTELLATIONS = {
    "customer": "customer", "customers": "customer", "client": "customer",
    "lead": "customer", "sales": "customer",
    "property": "property", "site": "property", "facility": "property",
    "crew": "crew", "staff": "crew", "team": "crew", "dispatch": "crew",
    "policy": "policy", "compliance": "policy", "rule": "policy",
    "brand": "policy",
}


def configure(db_path: str) -> None:
    global _db_path
    _db_path = db_path
    ensure_folders()


def ensure_folders() -> None:
    for f in FOLDERS:
        os.makedirs(os.path.join(VAULT_DIR, f), exist_ok=True)


def _conn():
    return db_module.get_thread_conn(_db_path)


def _slugify(text: str, limit: int = 48) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return (s or "note")[:limit]


def constellation_for(topic: str) -> str:
    t = (topic or "general").lower()
    for key, group in _CONSTELLATIONS.items():
        if key in t:
            return group
    return "general"


# ── Frontmatter (tiny YAML, no external dep) ────────────────────────────

def _frontmatter(meta: dict) -> str:
    lines = ["---"]
    for k, v in meta.items():
        if v is None:
            v = ""
        lines.append(f"{k}: {v}")
    lines.append("---")
    return "\n".join(lines)


def _parse_note(text: str) -> tuple[dict, str]:
    """Return (frontmatter dict, body). Tolerates notes with no frontmatter."""
    meta: dict = {}
    body = text
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            for line in parts[1].strip().splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    meta[k.strip()] = v.strip()
            body = parts[2].lstrip("\n")
    return meta, body


def _wikilinks(text: str) -> list[str]:
    return re.findall(r"\[\[([^\]]+)\]\]", text or "")


# ── Public API ──────────────────────────────────────────────────────────

def memory_write(tenant_id: int, agent_id, memory_type: str, topic: str,
                 fact: str, confidence: float = 1.0,
                 source: str = "agent") -> str:
    """Create a vault note AND an agent_memory row. Returns the note path."""
    ensure_folders()
    fact = (fact or "").strip()
    topic = (topic or "general").strip()
    if memory_type == "collective":
        agent_id = None
    now = datetime.now(timezone.utc)
    stamp = now.strftime("%Y-%m-%d_%H%M")
    created_at = int(now.timestamp())
    fname = f"{stamp}_{_slugify(fact)}.md"
    path = os.path.join(MEM_DIR, fname)
    meta = {
        "tenant_id": tenant_id,
        "agent_id": agent_id if agent_id is not None else "",
        "type": memory_type,
        "topic": topic,
        "confidence": confidence,
        "source": source,
        "created_at": now.isoformat(),
    }
    with open(path, "w") as f:
        f.write(_frontmatter(meta) + "\n\n" + fact + "\n")

    conn = _conn()
    # de-dupe on (tenant, scope, topic, fact) — same rule as agents memory
    existing = db_module.one(conn,
        "SELECT id FROM agent_memory WHERE tenant_id = ? AND topic = ? AND fact = ? "
        "AND ((agent_id IS NULL AND ? IS NULL) OR agent_id = ?)",
        (tenant_id, topic, fact, agent_id, agent_id))
    if existing:
        db_module.update(conn, "agent_memory", existing["id"], tenant_id,
                         {"vault_path": path})
    else:
        db_module.insert(conn, "agent_memory", {
            "tenant_id": tenant_id, "agent_id": agent_id,
            "memory_type": memory_type, "topic": topic, "fact": fact,
            "confidence": confidence, "source": source, "vault_path": path,
            "created_at": created_at,
        })
    return path


def memory_read(topic=None, agent_id=None, tenant_id=None, limit: int = 20) -> list:
    """Read memories from the vault, filtered by frontmatter, sorted by
    confidence desc then date desc."""
    ensure_folders()
    out = []
    for fname in os.listdir(MEM_DIR):
        if not fname.endswith(".md"):
            continue
        try:
            with open(os.path.join(MEM_DIR, fname)) as f:
                meta, body = _parse_note(f.read())
        except OSError:
            continue
        if tenant_id is not None and str(meta.get("tenant_id")) != str(tenant_id):
            continue
        if agent_id is not None and str(meta.get("agent_id")) != str(agent_id):
            continue
        if topic and meta.get("topic") != topic:
            continue
        out.append({
            "file": fname,
            "topic": meta.get("topic", "general"),
            "fact": body.strip(),
            "confidence": float(meta.get("confidence") or 1.0),
            "type": meta.get("type", "personal"),
            "source": meta.get("source", ""),
            "created_at": meta.get("created_at", ""),
            "links": _wikilinks(body),
        })
    out.sort(key=lambda m: (m["confidence"], m["created_at"]), reverse=True)
    return out[:limit]


def memory_sync() -> int:
    """Two-way reconcile. Returns the number of rows/files created."""
    ensure_folders()
    conn = _conn()
    created = 0

    # 1) agent_memory rows without a vault file → write the file.
    for row in db_module.rows(conn,
            "SELECT * FROM agent_memory WHERE vault_path IS NULL OR vault_path = ''"):
        created_dt = datetime.fromtimestamp(row["created_at"] or 0, timezone.utc)
        stamp = created_dt.strftime("%Y-%m-%d_%H%M")
        fname = f"{stamp}_{_slugify(row['fact'])}.md"
        path = os.path.join(MEM_DIR, fname)
        meta = {
            "tenant_id": row["tenant_id"],
            "agent_id": row["agent_id"] if row["agent_id"] is not None else "",
            "type": row["memory_type"], "topic": row["topic"],
            "confidence": row["confidence"], "source": row["source"] or "sync",
            "created_at": created_dt.isoformat(),
        }
        with open(path, "w") as f:
            f.write(_frontmatter(meta) + "\n\n" + (row["fact"] or "") + "\n")
        db_module.update(conn, "agent_memory", row["id"], row["tenant_id"],
                         {"vault_path": path})
        created += 1

    # 2) vault files without a matching row → insert a row.
    known = {r["vault_path"] for r in db_module.rows(conn,
             "SELECT vault_path FROM agent_memory WHERE vault_path IS NOT NULL")}
    for fname in os.listdir(MEM_DIR):
        path = os.path.join(MEM_DIR, fname)
        if not fname.endswith(".md") or path in known:
            continue
        try:
            with open(path) as f:
                meta, body = _parse_note(f.read())
        except OSError:
            continue
        if not meta.get("tenant_id"):
            continue  # not an agent-os note
        agent_id = meta.get("agent_id")
        agent_id = int(agent_id) if agent_id not in (None, "", "None") else None
        db_module.insert(conn, "agent_memory", {
            "tenant_id": int(meta["tenant_id"]), "agent_id": agent_id,
            "memory_type": meta.get("type", "collective"),
            "topic": meta.get("topic", "general"), "fact": body.strip(),
            "confidence": float(meta.get("confidence") or 1.0),
            "source": meta.get("source", "vault"), "vault_path": path,
        })
        created += 1
    return created


def memory_galaxy(tenant_id=None) -> dict:
    """All memories formatted for the galaxy visual. Edges come from shared
    topics and from [[wikilink]] references between notes."""
    conn = _conn()
    clause = "WHERE m.tenant_id = ?" if tenant_id is not None else ""
    args = (tenant_id,) if tenant_id is not None else ()
    memrows = db_module.rows(conn,
        "SELECT m.*, a.real_name AS agent_real, a.name AS agent_name "
        "FROM agent_memory m LEFT JOIN agents a ON a.id = m.agent_id "
        + clause + " ORDER BY m.id", args)

    # index by topic and by slugified-fact for wikilink resolution
    by_topic: dict[str, list[int]] = {}
    slug_index: dict[str, int] = {}
    stars = []
    for r in memrows:
        cons = constellation_for(r["topic"])
        by_topic.setdefault(r["topic"], []).append(r["id"])
        slug_index[_slugify(r["topic"])] = r["id"]
        slug_index[_slugify(r["fact"])] = r["id"]
        links = []
        if r.get("vault_path") and os.path.exists(r["vault_path"]):
            try:
                with open(r["vault_path"]) as f:
                    links = _wikilinks(f.read())
            except OSError:
                pass
        stars.append({
            "id": r["id"], "topic": r["topic"], "fact": r["fact"],
            "confidence": float(r["confidence"] or 1.0),
            "usage_count": r["usage_count"] or 0,
            "agent_name": r.get("agent_real") or r.get("agent_name") or "Collective",
            "type": r["memory_type"], "constellation": cons,
            "source": r.get("source"), "created_at": r.get("created_at"),
            "_links": links, "connected_to": [],
        })

    star_by_id = {s["id"]: s for s in stars}
    for s in stars:
        connected = set()
        # topic siblings
        for other in by_topic.get(s["topic"], []):
            if other != s["id"]:
                connected.add(other)
        # explicit wikilinks
        for link in s.pop("_links"):
            target = link.split("/", 1)[-1] if "/" in link else link
            tid = slug_index.get(_slugify(target))
            if tid and tid != s["id"]:
                connected.add(tid)
        # cap fan-out so dense topics stay readable
        s["connected_to"] = sorted(connected)[:8]

    constellations = sorted({s["constellation"] for s in stars})
    return {"memories": stars, "constellations": constellations,
            "count": len(stars)}
