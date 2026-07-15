#!/usr/bin/env python3
"""Clean up AGENT OS database and seed Magic Hair Styler agents."""
import sqlite3, json, time

db = sqlite3.connect('/var/lib/agent-os/data.db')
now = int(time.time())

# 1. Delete duplicate agents (IDs 73-109 — generic names, tenant 3)
count = 0
for aid in range(73, 110):
    a = db.execute("SELECT id, name FROM agents WHERE id=?", (aid,)).fetchone()
    if a and a[1] not in ('Hermes',):
        db.execute("DELETE FROM agent_logs WHERE agent_id=?", (aid,))
        db.execute("DELETE FROM agent_inbox WHERE to_agent_id=? OR from_agent_id=?", (aid, aid))
        db.execute("DELETE FROM agent_memory WHERE agent_id=?", (aid,))
        db.execute("DELETE FROM agents WHERE id=?", (aid,))
        count += 1
print(f"Deleted {count} duplicate agents")

# 2. Create Magic Hair Styler tenant if not exists
t = db.execute("SELECT id FROM tenants WHERE slug='magic-hair-styler'").fetchone()
if t:
    tid = t[0]
else:
    db.execute("INSERT INTO tenants (name, slug, brand_colour) VALUES ('Magic Hair Styler', 'magic-hair-styler', '#A78BFA')")
    tid = db.execute("SELECT last_insert_rowid()").fetchone()[0]

# 3. Delete generic agents from tenant 4 and add proper ones
db.execute("DELETE FROM agents WHERE tenant_id=?", (tid,))

hair_agents = [
    ("Poppy Lane", "social-media-agent", "Social Media & Content", "#EC4899", "PL"),
    ("Felix Voss", "email-marketing-agent", "Email Marketing", "#FB923C", "FV"),
    ("Luna Chen", "image-gen-agent", "Image Creation", "#C084FC", "LC"),
    ("Dex Hart", "seo-agent", "SEO & Analytics", "#06B6D4", "DH"),
    ("Vero Nash", "sales-script-agent", "Sales & Outreach", "#F43F5E", "VN"),
]

for name, slug, role, colour, initials in hair_agents:
    cert = json.dumps({"avatar_colour": colour, "avatar_initials": initials, "team": "marketing", "generates": True})
    soul = f"You are {name}, the {role} agent for Magic Hair Styler — a premium hair styling brand. You create compelling content that resonates with consumers who care about their hair. You write with energy and style, speaking directly to people who want great hair days."
    db.execute("INSERT INTO agents (tenant_id, slug, name, role, enabled, certificate_json, soul_text, created_at, last_status) VALUES (?,?,?,?,1,?,?,?,'idle')",
               (tid, slug, name, role, cert, soul, now))
    print(f"  Created {name}")

# 4. Seed collective memories about Magic Hair Styler
mhs_memories = [
    ("policy", "Magic Hair Styler sells premium hair styling tools direct-to-consumer through magichairstyler.com."),
    ("customer", "MHS customers are style-conscious consumers aged 18-45, primarily female, interested in heatless styling."),
    ("policy", "The signature product is the Magic Hair Styler — a heatless airstyler that curls, volumises, and smooths."),
    ("crew", "Social media content is managed by Poppy Lane, focusing on TikTok and Instagram for brand awareness."),
    ("property", "The MHS website uses Stripe for payments and Resend for transactional emails."),
    ("customer", "Customer support handles queries about product usage, shipping, and returns via email."),
    ("policy", "MHS runs seasonal promotions around holidays — Valentine's, Mother's Day, Black Friday."),
    ("crew", "Luna Chen creates product imagery and lifestyle photography for the website and ads."),
    ("crew", "Dex Hart manages SEO for magichairstyler.com targeting 'heatless curlers', 'airstyler', and 'hair tools'."),
    ("customer", "Vero Nash handles influencer outreach and partnership deals for MHS."),
]

for topic, fact in mhs_memories:
    db.execute("INSERT INTO agent_memory (tenant_id, agent_id, memory_type, topic, fact, confidence, source, created_at) VALUES (?,NULL,'collective',?,?,0.8,'seed',?)",
               (tid, topic, fact, now))

db.commit()
print(f"Seeded {len(mhs_memories)} MHS collective memories")

# 5. Verify final state
total_agents = db.execute("SELECT COUNT(*) FROM agents").fetchone()[0]
total_memories = db.execute("SELECT COUNT(*) FROM agent_memory").fetchone()[0]
print(f"\nFinal state: {total_agents} agents, {total_memories} memories")
print("Done")
db.close()
