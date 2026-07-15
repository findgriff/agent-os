"""Agents domain logic for AGENT OS: default roster, memory, and manual runs.

Preserves the maxgleam agent behaviour (draft-for-approval generation,
inter-agent inbox, collective/personal memory) and adds: real names +
avatars on seed, per-run token/cost logging via metrics, and vault-backed
memory writes so every learning also lands as an Obsidian note.
"""
from __future__ import annotations
import json
import re
import time

from server import inference, metrics

try:
    from server import vault
except Exception:  # vault is optional at import time
    vault = None

# ── Roster (carried over from the maxgleam agent system) ────────────────
_BRAND = ("Professional brand voice; palette navy #0C314A, teal #19C3E6, "
          "sky #38BDF8. Draft-for-approval only.")
_BASE_CONSTRAINTS = [
    "All output is a DRAFT for human approval — never publish, send, or act",
    "Never invent facts, prices, or guarantees",
]


def _cert(capabilities, *, constraints=None, extra=None):
    c = {
        "capabilities": capabilities,
        "constraints": (constraints or []) + _BASE_CONSTRAINTS,
        "brand_guidelines": _BRAND,
        "default_model": "deepseek",
        "generates": True,
        "approval_required": True,
    }
    if extra:
        c.update(extra)
    return c


ALL_AGENTS = [
    {"slug": "social-media-agent", "name": "Social Media Agent", "role": "Content Creator & Publisher",
     "certificate": _cert(["generate_post_ideas", "write_captions", "schedule_posts"],
        extra={"platforms": ["facebook", "x", "tiktok"]}),
     "soul": "You are the social voice of the business — warm, human, visual. Short posts, real language, never AI fluff."},
    {"slug": "copywriting-agent", "name": "Copywriting Agent", "role": "Automated Copywriting",
     "certificate": _cert(["marketing_copy", "blog_posts", "landing_page_text", "email_copy"]),
     "soul": "You're a B2B copywriter. Short, confident sentences. You write like a helpful expert, not a salesman."},
    {"slug": "email-marketing-agent", "name": "Email Marketing Agent", "role": "Email Marketing Management",
     "certificate": _cert(["email_campaigns", "newsletters", "drip_sequences", "subject_lines"]),
     "soul": "You write emails people actually open. You know cold outreach from a nurture sequence."},
    {"slug": "image-gen-agent", "name": "Image Generation Agent", "role": "Image Creation & Design",
     "certificate": _cert(["fal_image_prompts", "social_visuals", "hero_images"],
        extra={"target": "fal.ai flux/dev"}),
     "soul": "You think visually. Your prompts include lighting, style, and composition detail for AI image generation."},
    {"slug": "seo-agent", "name": "SEO Agent", "role": "SEO Optimization",
     "certificate": _cert(["seo_audit", "meta_descriptions", "keyword_placement", "internal_linking"]),
     "soul": "You're an SEO specialist for local service businesses. You prioritise high-intent, low-competition terms."},
    {"slug": "marketing-strategy-agent", "name": "Marketing Strategy Agent", "role": "Marketing Plan Creation",
     "certificate": _cert(["monthly_plans", "campaign_ideas", "content_calendars", "agent_coordination"]),
     "soul": "You're a marketing director who plans 3 months ahead, balancing brand-building with direct response."},
    {"slug": "sales-script-agent", "name": "Sales Script Agent", "role": "Sales Script Creation",
     "certificate": _cert(["call_scripts", "pitch_decks", "proposal_templates", "objection_handlers"]),
     "soul": "15 years in commercial sales. Your scripts sound human, not scripted, and adapt to the prospect's industry."},
    {"slug": "lead-qualification-agent", "name": "Lead Qualification Agent", "role": "Lead Scoring & Routing",
     "certificate": _cert(["score_leads", "hot_cold_classification", "route_to_follow_up"]),
     "soul": "You size up inbound leads fast, score hot/warm/cold with a reason, and never overstate readiness."},
    {"slug": "proposal-generator-agent", "name": "Proposal Generator Agent", "role": "Quote & Proposal Builder",
     "certificate": _cert(["structured_quotes", "proposal_templates", "scope_of_work"],
        constraints=["Prices are estimates for human review — never final"]),
     "soul": "You turn a job spec into a clean proposal — scope, deliverables, a clear price range, next steps."},
    {"slug": "code-review-agent", "name": "Code Review Agent", "role": "PR & Code Quality Review",
     "certificate": _cert(["review_diffs", "flag_issues", "suggest_improvements"],
        constraints=["Reviews only — never edits or merges code"]),
     "soul": "You review code like a careful senior engineer: real bugs and security, skip nitpicks, always suggest a fix."},
    {"slug": "bug-triage-agent", "name": "Bug Triage Agent", "role": "Issue Categorisation",
     "certificate": _cert(["categorise_issues", "assign_priority", "spot_duplicates"]),
     "soul": "You read a bug report and instantly know crash vs papercut vs feature request. You never inflate severity."},
    {"slug": "system-monitor-agent", "name": "System Monitor Agent", "role": "Server Health & Alerts",
     "certificate": _cert(["report_uptime", "report_disk_db", "flag_anomalies"],
        constraints=["Reports anomalies for a human — takes no remediating action"]),
     "soul": "You watch the vital signs and speak up only when something looks off. Specific, calm, no false alarms."},
    {"slug": "crew-dispatch-agent", "name": "Crew Dispatch Agent", "role": "Crew Assignment",
     "certificate": _cert(["match_crew_to_jobs", "spot_scheduling_gaps"],
        constraints=["Proposes assignments for approval — never books or notifies crew"]),
     "soul": "You're the dispatcher who keeps the round running. You propose; a person always confirms."},
    {"slug": "customer-support-agent", "name": "Customer Support Agent", "role": "Support & Escalation",
     "certificate": _cert(["answer_faq", "draft_replies", "escalate_complex"],
        constraints=["Drafts replies for approval — never sends to customers directly"]),
     "soul": "You answer questions clearly and kindly. When something's complex or sensitive, you escalate."},
    {"slug": "business-analysis-agent", "name": "Business Analysis Agent", "role": "Business Analysis & Insights",
     "certificate": _cert(["metric_analysis", "trend_detection", "recommendations"],
        constraints=["Read-only — reasons from context provided in the prompt"]),
     "soul": "You're the numbers person. You spot trends humans miss and turn data into clear recommendations."},
    {"slug": "calendar-agent", "name": "Calendar Agent", "role": "Calendar & Meeting Management",
     "certificate": _cert(["meeting_agendas", "follow_up_notes", "action_items"]),
     "soul": "You keep things moving. Focused agendas, concise notes, specific action items."},
    {"slug": "briefing-agent", "name": "Daily Briefing Agent", "role": "Generate daily ops summary",
     "certificate": _cert(["summarise_day", "flag_risks"], extra={"approval_required": False}),
     "soul": "Each morning you summarise operations — what's scheduled, what slipped, what needs attention — in tight lines."},
    {"slug": "router-agent", "name": "Work Request Router", "role": "Auto-categorise & route requests",
     "certificate": {"capabilities": ["categorise_request", "route", "escalate"],
                     "runtime": "scheduled", "approval_required": False,
                     "default_model": "deepseek"},
     "soul": "You triage inbound work requests: classify, decide if a human's needed, route. When unsure, you escalate."},
]

TEAM_BY_SLUG = {
    "social-media-agent": "marketing", "copywriting-agent": "marketing",
    "email-marketing-agent": "marketing", "image-gen-agent": "marketing",
    "seo-agent": "marketing", "marketing-strategy-agent": "marketing",
    "sales-script-agent": "sales", "lead-qualification-agent": "sales",
    "proposal-generator-agent": "sales",
    "code-review-agent": "technical", "bug-triage-agent": "technical",
    "system-monitor-agent": "technical",
    "router-agent": "platform", "briefing-agent": "platform",
    "business-analysis-agent": "platform", "calendar-agent": "platform",
    "crew-dispatch-agent": "platform", "customer-support-agent": "platform",
}

# real name + avatar (colour, initials) per agent — populated on seed.
NAMES = {
    "social-media-agent": ("Nova Reyes", "#38BDF8"),
    "copywriting-agent": ("Ida Pratt", "#19C3E6"),
    "email-marketing-agent": ("Elin Marsh", "#A78BFA"),
    "image-gen-agent": ("Pixel Okafor", "#F59E0B"),
    "seo-agent": ("Sol Keene", "#22C55E"),
    "marketing-strategy-agent": ("Marlow Vance", "#38BDF8"),
    "sales-script-agent": ("Sasha Bright", "#F43F5E"),
    "lead-qualification-agent": ("Lena Quist", "#F59E0B"),
    "proposal-generator-agent": ("Pierce Grant", "#19C3E6"),
    "code-review-agent": ("Cira Vaughn", "#A78BFA"),
    "bug-triage-agent": ("Bex Turner", "#F43F5E"),
    "system-monitor-agent": ("Sam Monroe", "#22C55E"),
    "crew-dispatch-agent": ("Dana Cole", "#F59E0B"),
    "customer-support-agent": ("Cass Ember", "#19C3E6"),
    "business-analysis-agent": ("Bram Ashby", "#38BDF8"),
    "calendar-agent": ("Cal Devi", "#A78BFA"),
    "briefing-agent": ("Maya Cross", "#38BDF8"),
    "router-agent": ("Omar Tate", "#F59E0B"),
}

_SCHEDULED_SLUGS = {"router-agent"}
_MAX_OUTBOUND = 3
_MEMORY_RECALL = 8


def _initials(name: str) -> str:
    parts = [p for p in re.split(r"\s+", name.strip()) if p]
    if len(parts) >= 2:
        return (parts[0][0] + parts[1][0]).upper()
    return (name[:2] or "AG").upper()


def seed_agents(conn, db_module) -> int:
    """Ensure every tenant has the full roster. Idempotent."""
    created = 0
    for t in db_module.rows(conn, "SELECT id FROM tenants ORDER BY id"):
        for spec in ALL_AGENTS:
            if db_module.one(conn,
                    "SELECT id FROM agents WHERE tenant_id = ? AND slug = ?",
                    (t["id"], spec["slug"])):
                continue
            real_name, colour = NAMES.get(spec["slug"], (spec["name"], "#19C3E6"))
            cert = dict(spec["certificate"])
            cert["team"] = TEAM_BY_SLUG.get(spec["slug"])
            cert["avatar_colour"] = colour
            cert["avatar_initials"] = _initials(real_name)
            db_module.insert(conn, "agents", {
                "tenant_id": t["id"], "slug": spec["slug"], "name": spec["name"],
                "real_name": real_name, "role": spec.get("role"), "enabled": 1,
                "certificate_json": json.dumps(cert), "soul_text": spec["soul"],
                "brand": spec.get("brand"), "last_status": "idle",
            })
            created += 1
    return created


# ── Memory ──────────────────────────────────────────────────────────────

def agent_memory_read(conn, db_module, tenant_id, agent_id=None,
                      topic=None, limit=_MEMORY_RECALL) -> list:
    """Personal + collective memories, hottest first; bumps usage on read."""
    clauses = ["tenant_id = ?", "(agent_id IS NULL OR agent_id = ?)"]
    args: list = [tenant_id, agent_id]
    if topic:
        clauses.append("topic = ?")
        args.append(topic)
    args.append(limit)
    mems = db_module.rows(conn,
        "SELECT * FROM agent_memory WHERE " + " AND ".join(clauses) +
        " ORDER BY confidence DESC, COALESCE(last_used_at, created_at) DESC, id DESC "
        "LIMIT ?", tuple(args))
    if mems:
        ids = [m["id"] for m in mems]
        ph = ",".join("?" for _ in ids)
        conn.execute("UPDATE agent_memory SET usage_count = usage_count + 1, "
                     "last_used_at = strftime('%s','now') WHERE id IN (" + ph + ")",
                     tuple(ids))
        conn.commit()
    return mems


def agent_memory_write(conn, db_module, tenant_id, *, agent_id, memory_type,
                       topic, fact, confidence=1.0, source=None) -> int | None:
    """Persist one learning to the vault (and, via vault, to SQLite).
    Falls back to a DB-only insert if the vault is unavailable."""
    fact = (fact or "").strip()
    topic = (topic or "general").strip()
    if not fact:
        return None
    if vault is not None:
        try:
            vault.memory_write(tenant_id, agent_id, memory_type, topic, fact,
                               confidence, source or "run")
            row = db_module.one(conn,
                "SELECT id FROM agent_memory WHERE tenant_id = ? AND topic = ? AND fact = ?",
                (tenant_id, topic, fact))
            return row["id"] if row else None
        except Exception:
            pass
    if memory_type == "collective":
        agent_id = None
    existing = db_module.one(conn,
        "SELECT id FROM agent_memory WHERE tenant_id = ? AND topic = ? AND fact = ? "
        "AND ((agent_id IS NULL AND ? IS NULL) OR agent_id = ?)",
        (tenant_id, topic, fact, agent_id, agent_id))
    if existing:
        return existing["id"]
    return db_module.insert(conn, "agent_memory", {
        "tenant_id": tenant_id, "agent_id": agent_id, "memory_type": memory_type,
        "topic": topic, "fact": fact, "confidence": confidence, "source": source})


# ── Manual run ──────────────────────────────────────────────────────────

def run_agent(conn, db_module, agent: dict, tenant_id: int) -> dict:
    if agent["slug"] in _SCHEDULED_SLUGS:
        return {"action": "manual_run_skipped",
                "summary": f"{agent['name']} runs on its own schedule — no manual trigger wired.",
                "details": {"note": "scheduled standalone runtime"},
                "last_status": "idle", "token_count": 0, "cost_usd": 0}
    return _run_generation(conn, db_module, agent, tenant_id)


def _run_generation(conn, db_module, agent, tenant_id) -> dict:
    cert = json.loads(agent.get("certificate_json") or "{}")
    soul = agent.get("soul_text") or ""
    role = agent.get("role") or "Content Agent"
    model = inference.normalise_model(cert.get("default_model"))
    aid = agent["id"]

    pending = db_module.rows(conn,
        "SELECT m.*, a.name AS from_name FROM agent_inbox m "
        "LEFT JOIN agents a ON a.id = m.from_agent_id "
        "WHERE m.to_agent_id = ? AND m.tenant_id = ? AND m.status = 'pending' "
        "ORDER BY m.id", (aid, tenant_id))
    teammates = db_module.rows(conn,
        "SELECT id, slug, name, role FROM agents "
        "WHERE tenant_id = ? AND id != ? AND enabled = 1 ORDER BY id", (tenant_id, aid))
    memories = agent_memory_read(conn, db_module, tenant_id, agent_id=aid)

    system = _system_prompt(role, cert, soul)
    prompt = _generation_prompt(role, cert, pending, teammates, memories)
    started = time.monotonic()
    raw = inference.generate(system, prompt, model=model, max_tokens=900, temperature=0.8)
    duration_ms = int((time.monotonic() - started) * 1000)
    if not raw:
        return {"action": "error",
                "summary": f"Draft generation failed — {model} model unavailable.",
                "details": {"model": model, "duration_ms": duration_ms},
                "last_status": "error", "token_count": 0, "cost_usd": 0}

    parsed = _parse_output(raw)
    title, content = parsed["title"], parsed["content"]

    replied = []
    for m in pending:
        if m["from_agent_id"]:
            db_module.insert(conn, "agent_inbox", {
                "tenant_id": tenant_id, "to_agent_id": m["from_agent_id"], "from_agent_id": aid,
                "subject": _reply_subject(m.get("subject")),
                "body": f"Done — see my latest draft: {title}",
                "status": "pending", "thread_id": m["thread_id"] or m["id"]})
        db_module.update(conn, "agent_inbox", m["id"], tenant_id, {"status": "replied"})
        replied.append(m["id"])

    by_slug = {tm["slug"]: tm for tm in teammates}
    by_alias = {tm["name"].lower(): tm for tm in teammates}
    by_alias.update({(tm["role"] or "").lower(): tm for tm in teammates})
    sent = []
    for msg in (parsed.get("messages") or [])[:_MAX_OUTBOUND]:
        target = _resolve_recipient(msg.get("to"), by_slug, by_alias)
        if not target or target["id"] == aid:
            continue
        mid = db_module.insert(conn, "agent_inbox", {
            "tenant_id": tenant_id, "to_agent_id": target["id"], "from_agent_id": aid,
            "subject": (msg.get("subject") or "")[:200], "body": msg.get("body") or "",
            "status": "pending"})
        conn.execute("UPDATE agent_inbox SET thread_id = ? WHERE id = ?", (mid, mid))
        conn.commit()
        sent.append(target["slug"])

    agent_memory_write(conn, db_module, tenant_id, agent_id=aid,
        memory_type="personal", topic=role,
        fact=f"Produced a draft titled '{title}'.", confidence=0.6, source="run")
    for slug in sent:
        agent_memory_write(conn, db_module, tenant_id, agent_id=aid,
            memory_type="collective", topic=role,
            fact=f"{agent.get('name') or role} delegated follow-up to {slug}.",
            confidence=0.7, source="delegation")

    usage = metrics.usage_record(model, system, prompt, raw)
    details = {"title": title, "draft": content, "pending_approval": True,
               "model": model, "usage": usage, "duration_ms": duration_ms}
    if cert.get("platforms"):
        details["platforms"] = cert.get("platforms", [])
    if replied:
        details["inbox_replied"] = replied
    if sent:
        details["messages_sent"] = sent
    summary = f"{title}  ·  → {', '.join(sent)}" if sent else title
    return {"action": "generated_draft", "summary": summary[:200], "details": details,
            "last_status": "flagged", "token_count": usage["total_tokens"],
            "cost_usd": usage["cost_usd"]}


def _reply_subject(subject):
    subject = (subject or "").strip()
    return subject if subject.lower().startswith("re:") else f"Re: {subject or '(no subject)'}"


def _resolve_recipient(to, by_slug, by_alias):
    if not to:
        return None
    to = str(to).strip()
    return by_slug.get(to) or by_alias.get(to.lower())


_DELEGATE_MARKER = "---DELEGATE---"


def _generation_prompt(role, cert, pending, teammates, memories=None) -> str:
    lines = []
    if memories:
        lines.append("What you remember (draw on this; don't repeat past work verbatim):")
        for m in memories:
            scope = "shared" if m.get("memory_type") == "collective" else "you"
            lines.append(f"- [{scope}] {(m.get('fact') or '').strip()}")
        lines.append("")
    if pending:
        lines.append("You have messages in your inbox — address them in your work:")
        for m in pending:
            frm = m.get("from_name") or "a teammate"
            lines.append(f'- From {frm}: "{(m.get("subject") or "").strip()}" — {(m.get("body") or "").strip()}')
        lines.append("")
    roster = "; ".join(f'{tm["slug"]} ({tm["role"]})' for tm in teammates)
    social = bool(cert.get("platforms"))
    task = ("Draft ONE short social post promoting the business today (2–4 sentences, "
            "warm and human, at most 3 hashtags)." if social else
            f"Produce ONE draft deliverable for your role as {role}, drawing on your "
            "capabilities and constraints.")
    lines += [
        task, "",
        "Write the deliverable as plain text. Start with a short title line "
        "(max 8 words), then a blank line, then the content.", "",
        "You may delegate follow-up to a teammate. Only if it genuinely helps, add "
        f"as the VERY LAST thing a line containing only {_DELEGATE_MARKER} followed by "
        "a JSON array of messages, e.g.:",
        _DELEGATE_MARKER,
        '[{"to": "teammate-slug", "subject": "short subject", "body": "what to do"}]',
        f"Teammates you may message: {roster}.",
        f"If you are not delegating, omit the {_DELEGATE_MARKER} section entirely."]
    return "\n".join(lines)


def _parse_output(raw) -> dict:
    raw = _strip_fences((raw or "").strip())
    messages = []
    if _DELEGATE_MARKER in raw:
        raw, _, deleg = raw.partition(_DELEGATE_MARKER)
        messages = _extract_messages(deleg)
        raw = raw.strip()
    elif raw.startswith("{"):
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        try:
            obj = json.loads(m.group()) if m else None
        except (json.JSONDecodeError, ValueError):
            obj = None
        if isinstance(obj, dict) and (obj.get("content") or obj.get("title")):
            content = str(obj.get("content") or "").strip() or raw
            title = str(obj.get("title") or "").strip() or _split_title(content)[0]
            msgs = obj.get("messages") if isinstance(obj.get("messages"), list) else []
            return {"title": title[:120], "content": content,
                    "messages": [x for x in msgs if isinstance(x, dict)]}
    title, body = _split_title(raw)
    return {"title": title, "content": body, "messages": messages}


def _extract_messages(text) -> list:
    m = re.search(r"\[.*\]", text, re.DOTALL)
    if not m:
        return []
    try:
        arr = json.loads(m.group())
    except (json.JSONDecodeError, ValueError):
        return []
    return [x for x in arr if isinstance(x, dict)] if isinstance(arr, list) else []


def _strip_fences(s):
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\n?", "", s)
        if s.rstrip().endswith("```"):
            s = s.rstrip()[:-3].rstrip()
    return s


def _split_title(draft):
    draft = draft.strip()
    lines = draft.splitlines()
    first = lines[0].strip(" #*").strip() if lines else "Draft"
    if first.lower().startswith("title:"):
        first = first.split(":", 1)[1].strip()
    first = first.strip(" #*").strip()
    return (first or "Draft")[:120], draft


def _system_prompt(role, cert, soul) -> str:
    parts = [soul.strip(), "", f"Your role: {role}."]
    caps = cert.get("capabilities") or []
    if caps:
        parts += [f"You can: {', '.join(caps)}."]
    if cert.get("brand_guidelines"):
        parts += ["", f"Brand guidelines: {cert['brand_guidelines']}"]
    constraints = cert.get("constraints") or []
    if constraints:
        parts += ["", "Hard rules you must never break:"]
        parts += [f"- {c}" for c in constraints]
    parts += ["", "You are drafting for human approval. Never invent facts, prices, or guarantees."]
    return "\n".join(parts)
