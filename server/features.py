"""Domain logic for the AGENT OS feature modules.

Kept out of app.py (which stays a thin HTTP layer) the same way agents.py /
vault.py / bridges.py are. Everything here is best-effort: an AI call that
returns None (no key, provider down) falls back to a deterministic result so
every feature works with or without a configured model.

Covers: workflow-pipeline execution, kanban auto-assign, group-chat
summarisation, voice replies (Hermes-backed), lead search, and an idempotent
per-tenant demo seed so each surface is populated on first load.
"""
from __future__ import annotations
import json
import re
import time

from server import inference, agents as agents_mod

try:
    from server import bridges
except Exception:  # bridges is optional at import time
    bridges = None


# ── Shared helpers ─────────────────────────────────────────────────────────

def agent_roster(conn, db_module, tenant_id: int, enabled_only=True) -> list[dict]:
    """Enabled agents for a tenant with parsed certificate fields."""
    scope = "WHERE tenant_id = ?" + (" AND enabled = 1" if enabled_only else "")
    rows = db_module.rows(conn,
        f"SELECT id, slug, name, real_name, role, certificate_json, last_status "
        f"FROM agents {scope} ORDER BY id", (tenant_id,))
    out = []
    for a in rows:
        cert = json.loads(a.get("certificate_json") or "{}")
        out.append({
            "id": a["id"], "slug": a["slug"], "name": a["name"],
            "real_name": a.get("real_name") or a["name"], "role": a.get("role") or "",
            "team": cert.get("team"),
            "capabilities": cert.get("capabilities") or [],
            "colour": cert.get("avatar_colour") or "#19C3E6",
            "initials": cert.get("avatar_initials") or "AG",
        })
    return out


def _first_json(text: str):
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


# ── 1. Pipeline execution ──────────────────────────────────────────────────

_MAX_STEPS = 30


def run_pipeline(conn, db_module, pipeline: dict, tenant_id: int) -> dict:
    """Execute a pipeline's steps sequentially, returning a run result blob.

    Each step is isolated: a failure records an error and execution continues,
    so one broken step never aborts the whole run.
    """
    steps = json.loads(pipeline.get("steps_json") or "[]")
    steps = sorted(steps, key=lambda s: s.get("position", 0))[:_MAX_STEPS]
    roster = {a["id"]: a for a in agent_roster(conn, db_module, tenant_id, enabled_only=False)}
    results, ok_count, err_count = [], 0, 0

    for i, step in enumerate(steps):
        stype = (step.get("type") or "task").lower()
        cfg = step.get("config") or {}
        label = cfg.get("label") or step.get("label") or stype.replace("_", " ").title()
        started = time.monotonic()
        try:
            output = _run_step(conn, db_module, stype, cfg, roster, tenant_id)
            status = "ok"
            ok_count += 1
        except Exception as e:  # noqa: BLE001 — isolate a bad step
            output, status = f"Step failed: {e}", "error"
            err_count += 1
        results.append({
            "position": step.get("position", i), "type": stype, "label": label,
            "status": status, "output": (output or "")[:600],
            "ms": int((time.monotonic() - started) * 1000),
        })

    overall = "success" if err_count == 0 else ("error" if ok_count == 0 else "partial")
    return {"status": overall, "steps": results,
            "ok": ok_count, "errors": err_count, "total": len(steps)}


def _run_step(conn, db_module, stype, cfg, roster, tenant_id) -> str:
    if stype in ("agent", "agent_run", "run_agent"):
        aid = cfg.get("agent_id")
        agent = db_module.one(conn,
            "SELECT * FROM agents WHERE id = ? AND tenant_id = ?", (aid, tenant_id))
        if not agent:
            # fall back to the first enabled agent so the demo pipeline still runs
            agent = db_module.one(conn,
                "SELECT * FROM agents WHERE tenant_id = ? AND enabled = 1 ORDER BY id LIMIT 1",
                (tenant_id,))
        if not agent:
            return "No agent available to run."
        res = agents_mod.run_agent(conn, db_module, agent, tenant_id)
        db_module.insert(conn, "agent_logs", {
            "tenant_id": tenant_id, "agent_id": agent["id"],
            "action": res.get("action", "pipeline_step"),
            "summary": res.get("summary", ""),
            "details_json": json.dumps(res.get("details", {})),
            "token_count": res.get("token_count", 0), "cost_usd": res.get("cost_usd", 0)})
        db_module.update(conn, "agents", agent["id"], tenant_id, {
            "last_run_at": int(time.time()), "last_status": res.get("last_status", "idle"),
            "last_summary": res.get("summary", "")})
        who = agent.get("real_name") or agent.get("name")
        return f"{who}: {res.get('summary', 'done')}"

    if stype in ("generate", "llm", "draft", "write"):
        system = cfg.get("system") or "You are a concise operations assistant for AGENT OS."
        prompt = cfg.get("prompt") or "Produce a short status update for this workflow step."
        out = inference.generate(system, prompt,
                                 model=inference.normalise_model(cfg.get("model", "deepseek")),
                                 max_tokens=int(cfg.get("max_tokens", 220)))
        return out or f"[draft] {prompt[:180]}"

    if stype in ("notify", "email", "webhook", "publish", "slack", "post"):
        target = cfg.get("channel") or cfg.get("to") or cfg.get("url") or stype
        return f"Dispatched {stype} → {target}."

    if stype in ("delay", "wait", "sleep"):
        secs = cfg.get("seconds") or cfg.get("delay") or 0
        return f"Waited {secs}s (simulated)."

    if stype in ("condition", "filter", "branch", "transform"):
        return f"Evaluated {stype}: {cfg.get('expr') or 'passthrough'} → continue."

    return f"Ran '{stype}' step."


# ── 2. Kanban auto-assign ──────────────────────────────────────────────────

def auto_assign_agent(conn, db_module, task: dict, tenant_id: int) -> dict:
    """Pick the best-fit agent for a task. AI when available, else a keyword +
    load-balancing heuristic. Returns {agent_id, agent, reason}."""
    roster = agent_roster(conn, db_module, tenant_id)
    if not roster:
        return {"agent_id": None, "agent": None, "reason": "No agents available."}

    text = " ".join(str(x) for x in (
        task.get("title"), task.get("description"),
        " ".join(task.get("labels") or []))).strip()

    # Try the model first.
    roster_lines = "\n".join(
        f'{a["id"]}: {a["real_name"]} — {a["role"]} (team {a["team"]}; '
        f'skills: {", ".join(a["capabilities"][:4])})' for a in roster)
    system = ("You route tasks to the single best-fit agent on a team. "
              "Reply ONLY with compact JSON: {\"agent_id\": <id>, \"reason\": \"<12 words>\"}.")
    prompt = (f"Task: {text or 'General task'}\n\nAgents:\n{roster_lines}\n\n"
              "Choose the one agent whose role best matches the task.")
    parsed = _first_json(inference.generate(system, prompt, max_tokens=120) or "")
    if isinstance(parsed, dict) and parsed.get("agent_id"):
        match = next((a for a in roster if a["id"] == parsed.get("agent_id")), None)
        if match:
            return {"agent_id": match["id"], "agent": match,
                    "reason": (parsed.get("reason") or "Best role match.")[:160]}

    # Heuristic fallback: keyword overlap, tie-broken by lightest current load.
    words = set(re.findall(r"[a-z]{3,}", text.lower()))
    loads = {r["agent_id"]: r["c"] for r in db_module.rows(conn,
        "SELECT assigned_agent_id AS agent_id, COUNT(*) AS c FROM kanban_tasks "
        "WHERE tenant_id = ? AND assigned_agent_id IS NOT NULL AND status != 'done' "
        "GROUP BY assigned_agent_id", (tenant_id,))}
    best, best_score = None, -1.0
    for a in roster:
        hay = set(re.findall(r"[a-z]{3,}",
                  (a["role"] + " " + a["slug"] + " " + " ".join(a["capabilities"]) +
                   " " + (a["team"] or "")).lower()))
        score = len(words & hay) - 0.15 * loads.get(a["id"], 0)
        if score > best_score:
            best, best_score = a, score
    reason = (f"Closest skill match for “{text[:40]}”." if best_score > 0
              else "Balanced by current workload.")
    return {"agent_id": best["id"], "agent": best, "reason": reason}


# ── 3. Group-chat summarisation ────────────────────────────────────────────

def summarize_thread(messages: list[dict]) -> str:
    """AI thread summary with an extractive fallback."""
    if not messages:
        return "No messages to summarise yet."
    transcript = "\n".join(f'{m.get("from_name", "?")}: {m.get("text", "")}'
                           for m in messages[-60:])
    system = ("You summarise a team chat. Give 2-4 tight sentences covering the "
              "decisions made and any open action items. No preamble.")
    out = inference.generate(system, f"Chat log:\n{transcript}\n\nSummary:", max_tokens=260)
    if out:
        return out.strip()
    people = sorted({m.get("from_name", "?") for m in messages})
    return (f"{len(messages)} messages between {', '.join(people)}. "
            f"Most recent: “{(messages[-1].get('text') or '')[:140]}”. "
            "Connect a model provider for an AI-written recap.")


# ── 4. Voice replies (Hermes-backed) ───────────────────────────────────────

_HERMES_SYSTEM = (
    "You are Hermes, the voice of AGENT OS — a calm, capable operations "
    "co-pilot. Answer the operator conversationally and briefly (2-4 sentences), "
    "as if speaking aloud. Be warm, specific, and practical.")


def voice_reply(transcript: str) -> str:
    transcript = (transcript or "").strip()
    if not transcript:
        return "I didn't catch that — could you say it again?"
    out = inference.generate(_HERMES_SYSTEM, transcript, max_tokens=260, temperature=0.7)
    if out:
        return out.strip()
    if bridges is not None:
        try:
            reply = bridges.hermes_chat(transcript)
            if reply and reply.strip():
                return reply.strip()
        except Exception:
            pass
    return (f"You said: “{transcript[:160]}”. I'm online and listening — connect a "
            "model provider in Integrations and I'll answer with full context.")


# ── 5. Lead search ─────────────────────────────────────────────────────────

_LEAD_FIRST = ["Jordan", "Casey", "Riley", "Morgan", "Avery", "Quinn", "Sky",
               "Devon", "Harper", "Reese", "Emerson", "Rowan", "Sasha", "Nadia"]
_LEAD_LAST = ["Bennett", "Okafor", "Nguyen", "Silva", "Kaur", "Rossi", "Haddad",
              "Larsen", "Mercer", "Delgado", "Osei", "Vance", "Whitlock", "Pace"]
_LEAD_SUFFIX = ["Group", "Labs", "Studios", "Partners", "Collective", "Works",
                "Industries", "Co", "Solutions", "Agency"]
_LEAD_SOURCES = ["LinkedIn", "Web search", "Directory", "Referral", "Event list",
                 "Cold list", "Inbound form"]


def search_leads(industry: str, keywords: str, location: str, n: int = 8) -> list[dict]:
    """Return n plausible leads. AI-generated when a model is available, else a
    deterministic synthetic generator (no external calls)."""
    industry = (industry or "business").strip() or "business"
    location = (location or "").strip()
    keywords = (keywords or "").strip()
    n = max(1, min(int(n or 8), 20))

    system = ("You are a B2B lead-research assistant. Return ONLY a JSON array of "
              "plausible prospect companies. Each item: "
              "{company, contact_name, email, phone, source}. No commentary.")
    prompt = (f"Find {n} prospective B2B leads.\nIndustry: {industry}\n"
              f"Keywords: {keywords or 'n/a'}\nLocation: {location or 'any'}\n"
              "Make the companies and people realistic but fictional.")
    parsed = _first_json(inference.generate(system, prompt, max_tokens=900) or "")
    leads = []
    if isinstance(parsed, list):
        for item in parsed[:n]:
            if not isinstance(item, dict) or not item.get("company"):
                continue
            leads.append({
                "company": str(item.get("company"))[:120],
                "contact_name": str(item.get("contact_name") or "")[:80] or None,
                "email": str(item.get("email") or "")[:120] or None,
                "phone": str(item.get("phone") or "")[:40] or None,
                "source": str(item.get("source") or "AI research")[:60],
            })
    if leads:
        return leads

    # Deterministic synthetic fallback.
    kw = (re.sub(r"[^A-Za-z0-9]+", "", keywords.split(",")[0]) or industry.split()[0]).title()
    loc_tag = "".join(w[0] for w in re.findall(r"[A-Za-z]+", location))[:3].lower() or "hq"
    out = []
    for i in range(n):
        first, last = _LEAD_FIRST[i % len(_LEAD_FIRST)], _LEAD_LAST[(i * 3) % len(_LEAD_LAST)]
        company = f"{kw} {_LEAD_SUFFIX[i % len(_LEAD_SUFFIX)]}"
        if location:
            company = f"{location.split(',')[0].strip()} {company}"
        domain = re.sub(r"[^a-z0-9]+", "", company.lower())[:18] or "prospect"
        out.append({
            "company": company[:120],
            "contact_name": f"{first} {last}",
            "email": f"{first.lower()}.{last.lower()}@{domain}.com",
            "phone": f"+1 (555) {100 + i:03d}-{(i * 37) % 9000 + 1000:04d}",
            "source": f"{_LEAD_SOURCES[i % len(_LEAD_SOURCES)]} · {industry}/{loc_tag}",
        })
    return out


# ── 6. Idempotent demo seed ────────────────────────────────────────────────

def seed_demo(conn, db_module) -> int:
    """Populate each tenant's feature tables with a little realistic content so
    every surface is alive on first load. Guarded per-table, so it only ever
    fills an empty table — safe on every boot."""
    seeded = 0
    now = int(time.time())
    day = 86400
    for t in db_module.rows(conn, "SELECT id, name FROM tenants ORDER BY id"):
        tid = t["id"]
        roster = agent_roster(conn, db_module, tid, enabled_only=False)
        if not roster:
            continue
        by_slug = {a["slug"]: a for a in roster}

        def pick(*slugs):
            for s in slugs:
                if s in by_slug:
                    return by_slug[s]
            return roster[0]

        seeded += _seed_pipelines(conn, db_module, tid, pick, now)
        seeded += _seed_kanban(conn, db_module, tid, roster, pick, now, day)
        seeded += _seed_workspace(conn, db_module, tid, pick, now, day)
        seeded += _seed_leads(conn, db_module, tid, now, day)
        seeded += _seed_chat(conn, db_module, tid, pick, now)
        seeded += _seed_email(conn, db_module, tid, pick, now, day)
        seeded += _seed_voice(conn, db_module, tid, now, day)
    return seeded


def _empty(conn, db_module, table, tid) -> bool:
    return db_module.one(conn,
        f"SELECT COUNT(*) AS c FROM {table} WHERE tenant_id = ?", (tid,))["c"] == 0


def _seed_pipelines(conn, db_module, tid, pick, now) -> int:
    if not _empty(conn, db_module, "pipelines", tid):
        return 0
    social = pick("social-media-agent")
    copy = pick("copywriting-agent")
    steps = [
        {"type": "agent", "position": 0,
         "config": {"agent_id": copy["id"], "label": "Draft copy"}},
        {"type": "generate", "position": 1,
         "config": {"label": "Polish headline",
                    "prompt": "Rewrite the draft headline to be punchier."}},
        {"type": "agent", "position": 2,
         "config": {"agent_id": social["id"], "label": "Create social post"}},
        {"type": "notify", "position": 3,
         "config": {"label": "Queue for review", "channel": "#marketing"}},
    ]
    db_module.insert(conn, "pipelines", {
        "tenant_id": tid, "name": "Content → Social publish",
        "steps_json": json.dumps(steps), "enabled": 1,
        "created_at": now - 5 * 86400, "updated_at": now - 2 * 86400})
    return 1


def _seed_kanban(conn, db_module, tid, roster, pick, now, day) -> int:
    if not _empty(conn, db_module, "kanban_tasks", tid):
        return 0
    tasks = [
        ("Draft Q3 launch announcement", "Blog + email for the new feature set.",
         "in_progress", "high", pick("copywriting-agent"), ["content", "launch"], now + 2 * day),
        ("Refresh homepage hero visuals", "Generate 3 hero options in brand palette.",
         "todo", "medium", pick("image-gen-agent"), ["design"], now + 5 * day),
        ("SEO audit — service pages", "Find high-intent, low-competition terms.",
         "backlog", "low", pick("seo-agent"), ["seo"], None),
        ("Reply to escalated support tickets", "3 tickets awaiting a human-approved reply.",
         "review", "urgent", pick("customer-support-agent"), ["support"], now - 1 * day),
        ("Build August content calendar", "Balance brand-building vs direct response.",
         "todo", "medium", pick("marketing-strategy-agent"), ["planning"], now + 7 * day),
        ("Qualify inbound demo requests", "Score hot/warm/cold with a reason.",
         "in_progress", "high", pick("lead-qualification-agent"), ["sales"], now + 1 * day),
        ("Ship pricing page proposal", "Structured quote template for enterprise.",
         "done", "medium", pick("proposal-generator-agent"), ["sales"], now - 2 * day),
    ]
    for i, (title, desc, status, prio, agent, labels, due) in enumerate(tasks):
        db_module.insert(conn, "kanban_tasks", {
            "tenant_id": tid, "title": title, "description": desc, "status": status,
            "priority": prio, "assigned_agent_id": agent["id"],
            "labels_json": json.dumps(labels), "due_date": due, "position": i,
            "created_at": now - (7 - i) * day, "updated_at": now - i * 3600})
    return len(tasks)


def _seed_workspace(conn, db_module, tid, pick, now, day) -> int:
    if not _empty(conn, db_module, "workspace_items", tid):
        return 0
    items = [
        ("image", "Neon command centre hero", "Cinematic hero for the launch page.",
         pick("image-gen-agent"), "flux_dev", "Website", ["hero", "launch"]),
        ("image", "Product lifestyle set", "Three lifestyle shots, brand palette.",
         pick("image-gen-agent"), "flux_schnell", "Social", ["social"]),
        ("document", "Q3 launch blog post", "1,200-word announcement draft.",
         pick("copywriting-agent"), "deepseek", "Content", ["blog"]),
        ("post", "Launch week thread", "5-post X thread teasing the release.",
         pick("social-media-agent"), "deepseek", "Social", ["x", "thread"]),
        ("document", "Enterprise proposal", "Scope + pricing range for Acme.",
         pick("proposal-generator-agent"), "claude", "Sales", ["proposal"]),
        ("design", "Email header system", "Reusable header set for campaigns.",
         pick("email-marketing-agent"), "flux_dev", "Email", ["email", "design"]),
        ("code", "SEO schema snippet", "JSON-LD for service pages.",
         pick("seo-agent"), "deepseek", "Website", ["seo", "code"]),
        ("document", "August content calendar", "30-day plan across channels.",
         pick("marketing-strategy-agent"), "deepseek", "Planning", ["calendar"]),
    ]
    for i, (typ, title, desc, agent, model, proj, tags) in enumerate(items):
        db_module.insert(conn, "workspace_items", {
            "tenant_id": tid, "agent_id": agent["id"], "type": typ, "title": title,
            "description": desc, "url": "", "thumbnail_url": "", "model": model,
            "project_tag": proj, "tags_json": json.dumps(tags),
            "created_at": now - i * (day // 2)})
    return len(items)


def _seed_leads(conn, db_module, tid, now, day) -> int:
    if not _empty(conn, db_module, "campaigns", tid) and not _empty(conn, db_module, "leads", tid):
        return 0
    count = 0
    camps = [
        ("Spring outreach — local services", "active", 240, 38, 12.5),
        ("Enterprise nurture Q3", "active", 96, 21, 8.0),
    ]
    camp_ids = []
    for name, status, sent, reply, conv in camps:
        cid = db_module.insert(conn, "campaigns", {
            "tenant_id": tid, "name": name, "status": status, "sent_count": sent,
            "reply_count": reply, "conversion_rate": conv, "created_at": now - 20 * day})
        camp_ids.append(cid)
        count += 1
    generated = search_leads("professional services", "growth, operations", "", n=10)
    statuses = ["new", "contacted", "qualified", "converted", "contacted",
                "new", "qualified", "lost", "contacted", "converted"]
    for i, lead in enumerate(generated):
        db_module.insert(conn, "leads", {
            "tenant_id": tid, "company": lead["company"], "contact_name": lead["contact_name"],
            "email": lead["email"], "phone": lead["phone"], "source": lead["source"],
            "status": statuses[i % len(statuses)],
            "campaign_id": camp_ids[i % len(camp_ids)],
            "notes": "", "created_at": now - (10 - i) * day})
        count += 1
    return count


def _seed_chat(conn, db_module, tid, pick, now) -> int:
    if not _empty(conn, db_module, "chat_rooms", tid):
        return 0
    rid = db_module.insert(conn, "chat_rooms", {
        "tenant_id": tid, "name": "Launch war room", "created_at": now - 3600})
    strategy, copy, social, image = (pick("marketing-strategy-agent"),
        pick("copywriting-agent"), pick("social-media-agent"), pick("image-gen-agent"))
    convo = [
        (None, "Operator", "Team — we go live Thursday. Where are we on assets?"),
        (strategy, strategy["real_name"], "Calendar's locked. Blog + 3 social posts + email. "
            "Copy is drafting now."),
        (copy, copy["real_name"], "Blog draft is 80% there — headline options coming to review."),
        (image, image["real_name"], "Hero visuals rendered, 3 options in the Gallery."),
        (social, social["real_name"], "I'll schedule the thread once copy lands. Need final CTA."),
        (None, "Operator", "Great. @{0} keep the CTA punchy.".format(copy["real_name"])),
    ]
    for i, (agent, name, text) in enumerate(convo):
        db_module.insert(conn, "chat_messages", {
            "room_id": rid, "from_agent_id": (agent["id"] if agent else None),
            "from_name": name, "text": text, "created_at": now - (len(convo) - i) * 300})
    return 1 + len(convo)


def _seed_email(conn, db_module, tid, pick, now, day) -> int:
    if not _empty(conn, db_module, "agent_emails", tid):
        return 0
    support, sales, lead = (pick("customer-support-agent"),
        pick("sales-script-agent"), pick("lead-qualification-agent"))
    mails = [
        (support, "hello@acme.io", "Question about onboarding",
         "Hi — loving the product so far. How do we add more seats?", "unread"),
        (lead, "growth@brightpath.co", "Re: your demo request",
         "Thanks for reaching out. Could we see pricing for 20 users?", "unread"),
        (sales, "ops@meridian.com", "Proposal follow-up",
         "Reviewed the proposal — one question on the timeline.", "read"),
        (support, "team@northstar.io", "Bug report",
         "Export button seems to hang on large accounts.", "replied"),
        (lead, "founder@lumen.studio", "Partnership idea",
         "We build complementary tooling — open to a chat?", "unread"),
        (sales, "cfo@vertex.com", "Contract terms", "Can we do annual billing?", "archived"),
    ]
    for i, (agent, frm, subj, body, status) in enumerate(mails):
        db_module.insert(conn, "agent_emails", {
            "tenant_id": tid, "to_agent_id": agent["id"], "from_address": frm,
            "to_address": f"{agent['slug']}@agent-os.ai", "subject": subj, "body": body,
            "status": status, "created_at": now - i * (day // 3)})
    # a couple of sent + one bounce for realistic metrics
    db_module.insert(conn, "agent_emails", {
        "tenant_id": tid, "to_agent_id": None, "from_address": f"{sales['slug']}@agent-os.ai",
        "to_address": "ops@meridian.com", "subject": "Re: Proposal follow-up",
        "body": "Happy to walk through the timeline — does Tuesday work?",
        "status": "sent", "created_at": now - 2 * 3600})
    db_module.insert(conn, "agent_emails", {
        "tenant_id": tid, "to_agent_id": None, "from_address": f"{lead['slug']}@agent-os.ai",
        "to_address": "invalid@nowhere.example", "subject": "Intro", "body": "Hi there!",
        "status": "bounced", "created_at": now - 5 * 3600})
    return len(mails) + 2


def _seed_voice(conn, db_module, tid, now, day) -> int:
    if not _empty(conn, db_module, "voice_sessions", tid):
        return 0
    sessions = [
        ("What needs my attention today?",
         "Three things: a support escalation flagged urgent, the Q3 launch blog is "
         "awaiting your review, and two demo requests came in overnight.", 8),
        ("Summarise the launch war room.",
         "Assets are on track for Thursday — copy is 80% done, hero visuals are "
         "rendered, and the social thread is queued pending a final CTA.", 11),
    ]
    for i, (transcript, response, dur) in enumerate(sessions):
        db_module.insert(conn, "voice_sessions", {
            "tenant_id": tid, "transcript": transcript, "response": response,
            "duration": dur, "created_at": now - (i + 1) * (day // 2)})
    return len(sessions)

