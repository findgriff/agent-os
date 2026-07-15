#!/usr/bin/env python3
"""Seed memores from Max Gleam agent_logs into AGENT OS vault."""
import json, sqlite3, os
from datetime import datetime

VAULT_DIR = os.path.expanduser('~/.superbrain/vault/memories')
os.makedirs(VAULT_DIR, exist_ok=True)

# Also write to AGENT OS DB
aos_db = sqlite3.connect('/var/lib/agent-os/data.db')
mg_db = sqlite3.connect('/var/lib/maxgleam/app.db')
mg_db.row_factory = sqlite3.Row

# Get agent_logs from maxgleam
logs = mg_db.execute('''
    SELECT l.*, a.name as agent_name, a.slug as agent_slug, a.tenant_id
    FROM agent_logs l 
    JOIN agents a ON a.id = l.agent_id 
    WHERE l.action = 'generated_draft' AND l.summary IS NOT NULL
    ORDER BY l.created_at DESC
    LIMIT 30
''').fetchall()

print(f'Found {len(logs)} logs from Max Gleam')

count = 0
for log in logs:
    fact = (log['summary'] or '')[:250]
    if not fact or len(fact) < 10:
        continue
    
    topic = 'general'
    fl = fact.lower()
    if any(w in fl for w in ['crew','dispatch','sub']):
        topic = 'crew'
    elif any(w in fl for w in ['customer','client','partner','lead','sales']):
        topic = 'customer'
    elif any(w in fl for w in ['property','site','facility','access']):
        topic = 'property'
    elif any(w in fl for w in ['policy','brand','seo','market','content','email']):
        topic = 'policy'
    
    ts = datetime.fromtimestamp(log['created_at'])
    slug = ''.join(c if c.isalnum() else '-' for c in fact.lower())[:40].strip('-')
    if not slug:
        slug = f'memory-{log["id"]}'
    filename = f"{ts.strftime('%Y-%m-%d_%H%M')}_{slug}.md"
    
    path = os.path.join(VAULT_DIR, filename)
    if os.path.exists(path):
        continue
    
    # Get the stored agent name from certificate if available
    agent_row = mg_db.execute("SELECT certificate_json FROM agents WHERE id=?", (log['agent_id'],)).fetchone()
    agent_name = log['agent_name']
    if agent_row and agent_row['certificate_json']:
        try:
            cert = json.loads(agent_row['certificate_json'])
            init = cert.get('avatar_initials', '')
        except:
            init = ''
    
    content = f'''---
tenant_id: {log['tenant_id']}
agent_id: {log['agent_id']}
agent: "{agent_name}"
type: personal
topic: {topic}
confidence: 0.7
source: agent_log
created_at: {log['created_at']}
---

# {agent_name} — {ts.strftime('%Y-%m-%d')}

{fact}

_From agent run at {ts.strftime('%H:%M')} UTC_
'''
    
    with open(path, 'w') as f:
        f.write(content)
    
    # Also write to agent_memory in AGENT OS DB
    aos_db.execute('''INSERT OR IGNORE INTO agent_memory 
        (tenant_id, agent_id, memory_type, topic, fact, confidence, source, created_at)
        VALUES (?, ?, 'personal', ?, ?, 0.7, 'seed', ?)''',
        (1, log['agent_id'], topic, fact, log['created_at']))
    count += 1

aos_db.commit()
aos_db.close()
mg_db.close()
print(f'Created {count} new memory files + DB rows')
print(f'Total vault memores: {len(os.listdir(VAULT_DIR))}')
