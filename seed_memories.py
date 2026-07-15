#!/usr/bin/env python3
"""Seed the Obsidian vault with real memories from agent_logs."""
import json, sqlite3, os
from datetime import datetime

VAULT_DIR = os.path.expanduser('~/.superbrain/vault/memories')
os.makedirs(VAULT_DIR, exist_ok=True)

conn = sqlite3.connect('/var/lib/agent-os/data.db')
conn.row_factory = sqlite3.Row

# Seed agent_memory table with memories from logs
logs = conn.execute('''
    SELECT l.*, a.name as agent_name, a.slug as agent_slug 
    FROM agent_logs l 
    JOIN agents a ON a.id = l.agent_id 
    WHERE l.action = 'generated_draft' AND l.summary IS NOT NULL
    ORDER BY l.created_at DESC
    LIMIT 20
''').fetchall()

print(f'Found {len(logs)} logs to convert to memories')

count = 0
for log in logs:
    fact = (log['summary'] or '')[:200]
    if not fact:
        continue
    
    topic = 'general'
    fl = fact.lower()
    if any(w in fl for w in ['crew','dispatch','subcontractor']):
        topic = 'crew'
    elif any(w in fl for w in ['customer','client','partner','lead']):
        topic = 'customer'
    elif any(w in fl for w in ['property','site','facility']):
        topic = 'property'
    elif any(w in fl for w in ['policy','brand','seo','marketing','content']):
        topic = 'policy'
    
    ts = datetime.fromtimestamp(log['created_at'])
    slug = fact.lower().replace(' ', '-')[:40].strip('-')
    if not slug:
        slug = f'memory-{log["id"]}'
    filename = f"{ts.strftime('%Y-%m-%d_%H%M')}_{slug}.md"
    
    content = f'''---
tenant_id: {log['tenant_id']}
agent_id: {log['agent_id']}
agent: "{log['agent_name']}"
type: personal
topic: {topic}
confidence: 0.7
source: agent_log
created_at: {log['created_at']}
---

# {log['agent_name']} — {ts.strftime('%Y-%m-%d')}

{fact}

_Seeded from agent log #{log['id']}_
'''
    
    path = os.path.join(VAULT_DIR, filename)
    with open(path, 'w') as f:
        f.write(content)
    
    conn.execute('''INSERT OR IGNORE INTO agent_memory 
        (tenant_id, agent_id, memory_type, topic, fact, confidence, source, created_at)
        VALUES (?, ?, 'personal', ?, ?, 0.7, 'seed', ?)''',
        (log['tenant_id'], log['agent_id'], topic, fact, log['created_at']))
    count += 1

conn.commit()
print(f'Created {count} memory files + DB rows')

# Add some collective memories about Max Gleam operations
collective = [
    ("policy", "Max Gleam handles commercial cleaning for restaurants, offices, and retail chains across the UK."),
    ("crew", "The crew dispatch system assigns subcontractors to cleaning rounds based on location and availability."),
    ("customer", "Partners submit work requests via the portal - these are auto-routed by the router agent."),
    ("property", "Each property has a frequency_weeks setting that determines cleaning schedule."),
    ("policy", "Invoices are generated from completed jobs and sent to customers via email."),
    ("crew", "Crew 3 is the strongest team for deep cleans and end-of-tenancy jobs."),
    ("customer", "Lee Hendry is the main partner contact at OpsPocket for Max Gleam operations."),
    ("property", "Property access notes are stored per-property and shared with assigned crew."),
]

for topic, fact in collective:
    conn.execute('''INSERT OR IGNORE INTO agent_memory 
        (tenant_id, agent_id, memory_type, topic, fact, confidence, source, created_at)
        VALUES (2, NULL, 'collective', ?, ?, 0.9, 'seed', 1784000000)''',
        (topic, fact))
    
    # Also write vault file
    slug = fact.lower().replace(' ', '-')[:40].strip('-')
    filename = f"2026-07-14_collective_{slug}.md"
    content = f'''---
tenant_id: 2
agent_id: null
type: collective
topic: {topic}
confidence: 0.9
source: seed
created_at: 1784000000
---

# Collective Knowledge: {topic.title()}

{fact}
'''
    path = os.path.join(VAULT_DIR, filename)
    with open(path, 'w') as f:
        f.write(content)
    print(f'  Collective: {fact[:60]}...')

conn.commit()
conn.close()

print(f'\n✅ Vault seeded. Run memory_sync() via API to reconcile.')
