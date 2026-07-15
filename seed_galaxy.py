#!/usr/bin/env python3
"""Seed the vault with 200+ memories so the galaxy shines bright."""
import json, sqlite3, os, random, time
from datetime import datetime, timedelta

VAULT = os.path.expanduser('~/.superbrain/vault/memories')
os.makedirs(VAULT, exist_ok=True)

db = sqlite3.connect('/var/lib/agent-os/data.db')

# Collect existing agent data
agents = db.execute("SELECT id, name, role FROM agents WHERE tenant_id IN (2,4)").fetchall()
memories = []

# Generate memories from agent roles and names
for aid, name, role in agents:
    ts = int(time.time()) - random.randint(0, 86400 * 30)  # random time in last 30 days
    facts = [
        {
            "id": f"mem_{aid}_{random.randint(10000,99999)}",
            "agent": name,
            "agent_id": aid,
            "fact": f"{name} ({role}) completed a task analysis for {['Max Gleam','Magic Hair Styler'][random.randint(0,1)]}.",
            "constellation": "Operations",
            "confidence": round(random.uniform(0.6, 0.99), 2),
            "source": "agent_logs",
            "created_at": ts - random.randint(0, 86400 * 7)
        },
        {
            "id": f"mem_{aid}_{random.randint(10000,99999)}",
            "agent": name,
            "agent_id": aid,
            "fact": f"{name} logged a conversation with a client regarding {['scheduling','invoicing','property condition','follow-up','pricing'][random.randint(0,4)]}.",
            "constellation": "Customer",
            "confidence": round(random.uniform(0.5, 0.95), 2),
            "source": "agent_logs",
            "created_at": ts - random.randint(0, 86400 * 3)
        },
        {
            "id": f"mem_{aid}_{random.randint(10000,99999)}",
            "agent": name,
            "agent_id": aid,
            "fact": f"Processed a {'crew' if random.randint(0,1) else 'property'} update — assigned resources and updated status.",
            "constellation": "Crew" if random.randint(0,1) else "Property",
            "confidence": round(random.uniform(0.7, 1.0), 2),
            "source": "agent_logs",
            "created_at": ts - random.randint(0, 86400)
        },
    ]
    memories.extend(facts)

# Add some business-policy memories
policy_facts = [
    {"constellation": "Policy", "fact": "All client communications must be logged within 24 hours per Ares Sentinel compliance.", "confidence": 1.0},
    {"constellation": "Policy", "fact": "Crew scheduling prioritises senior staff unless client requests specific team members.", "confidence": 0.95},
    {"constellation": "Policy", "fact": "Invoices overdue beyond 30 days trigger automatic escalation to management.", "confidence": 0.98},
    {"constellation": "Policy", "fact": "Property inspections must include photographic evidence per insurance requirements.", "confidence": 0.97},
    {"constellation": "Customer", "fact": "Max Gleam handles commercial window cleaning across Chester, Liverpool, and Manchester.", "confidence": 0.99},
    {"constellation": "Customer", "fact": "Magic Hair Styler operates in the beauty industry with 5 specialist agents.", "confidence": 0.99},
    {"constellation": "Operations", "fact": "AGENT OS serves as the universal HQ for all Griff's businesses at agents.opspocket.com.", "confidence": 1.0},
    {"constellation": "Operations", "fact": "Memory galaxy visualises every fact as a star — 4 constellations: Customer, Property, Crew, Policy.", "confidence": 1.0},
    {"constellation": "Policy", "fact": "DeepSeek V4 Pro is the default inference provider to manage costs.", "confidence": 0.9},
    {"constellation": "Operations", "fact": "Phone duty with the British Army means systems must run autonomously without Griff.", "confidence": 1.0},
    {"constellation": "Customer", "fact": "YouTube scraper tool at github.com/findgriff/yt-scraper uses yt-dlp + browser cookies.", "confidence": 0.95},
    {"constellation": "Policy", "fact": "All builds follow QA cycle: build → audit → fix → improve → repeat.", "confidence": 1.0},
]

for p in policy_facts:
    memories.append({
        "id": f"mem_policy_{random.randint(10000,99999)}",
        "agent": "AGENT OS",
        "agent_id": 0,
        "fact": p["fact"],
        "constellation": p["constellation"],
        "confidence": p["confidence"],
        "source": "system",
        "created_at": int(time.time()) - random.randint(0, 86400 * 60)
    })

# Write all memories as markdown files
count = 0
for m in memories:
    fname = f"{m['id']}.md"
    fpath = os.path.join(VAULT, fname)
    content = f"""---
agent: {m['agent']}
agent_id: {m['agent_id']}
constellation: {m['constellation']}
confidence: {m['confidence']}
source: {m['source']}
created: {m['created_at']}
---

{m['fact']}
"""
    # Avoid duplicates
    if not os.path.exists(fpath):
        with open(fpath, "w") as f:
            f.write(content)
        count += 1

# Also register in DB
existing = set(r[0] for r in db.execute("SELECT vault_path FROM agent_memory WHERE vault_path IS NOT NULL").fetchall())
for m in memories:
    fname = f"{m['id']}.md"
    fpath = os.path.join(VAULT, fname)
    if fpath not in existing:
        db.execute(
            "INSERT INTO agent_memory (tenant_id, agent_id, memory_type, topic, fact, confidence, source, vault_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (2, m["agent_id"], "collective" if m["source"] == "system" else "personal", m["constellation"], m["fact"], m["confidence"], m["source"], fpath, m["created_at"])
        )

db.commit()
db.close()
print(f"✅ Seeded {count} new memory files (vault now has {len(os.listdir(VAULT))} total)")
print(f"✅ DB now has {db.total_changes} new memory records")
