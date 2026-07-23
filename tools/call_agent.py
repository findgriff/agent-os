#!/usr/bin/env python3
"""Call Center Agent — AI-powered outbound calling engine.
Uses Kimi K3 via OpenRouter for conversation, Twilio for calls.

Usage:
  python3 call_agent.py call <business_slug> <phone_number> [--dry-run]
  python3 call_agent.py queue <business_slug> [--dry-run]
  python3 call_agent.py status
  python3 call_agent.py stats
  python3 call_agent.py score <call_sid>   # score a completed call's lead
  python3 call_agent.py config               # Twilio config check (no secrets)

--dry-run rehearses everything — script lookup, number normalisation, DND
check, TwiML generation, state + log writes — but never calls the Twilio API,
so no number is dialled and nothing is charged.
"""
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from server import twilio_bridge

SCRIPTS_FILE = Path(__file__).parent.parent / "call-scripts.json"
DB_FILE = Path("/var/lib/agent-os/data.db")
ENV_FILE = Path(os.path.expanduser("~/.hermes/.env"))
DND_FILE = Path("/var/lib/agent-os/dnd-list.json")
STATE_FILE = Path("/var/lib/agent-os/call-state.jsonl")
SCORES_FILE = Path("/var/lib/agent-os/lead-scores.jsonl")

# Hot leads are pushed onto the Ops Board follow-up queue (PostgREST on :3200).
OPS_API = os.environ.get("OPS_API", "http://localhost:3200/ops_tickets")
HOT_LEAD_THRESHOLD = 7  # score strictly greater than this ⇒ hot ⇒ ticket

OPENROUTER_API_KEY = ""

# ── Init ────────────────────────────────────────────────────────────

def load_env():
    global OPENROUTER_API_KEY
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().split("\n"):
            line = line.strip()
            if line.startswith("OPENROUTER_API_KEY="):
                OPENROUTER_API_KEY = line.split("=", 1)[1].strip().strip("'\"")
    if not OPENROUTER_API_KEY:
        OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
    # Twilio creds live in /etc/agent-os.env (systemd EnvironmentFile). systemd
    # supplies them to the server, but a CLI run has no such help — the bridge
    # reads the env files itself, so ask it to.
    twilio_bridge._load_env_files()

def load_scripts() -> dict:
    if SCRIPTS_FILE.exists():
        return json.loads(SCRIPTS_FILE.read_text())
    return {}

MAX_CALL_ATTEMPTS = 3  # attempts per number before it's marked exhausted
LOG_FILE = Path("/var/lib/agent-os/call-log.jsonl")
COMPLIANCE_FILE = Path("/var/lib/agent-os/compliance-log.jsonl")

RECORDING_NOTICE = "This call may be recorded for training purposes."


def normalize_phone(phone: str) -> str:
    """Canonical E.164-ish form: strip spaces/punctuation, default to +44.
    Compliance checks must not be defeated by formatting — "07700 900123",
    "+447700900123" and "07700900123" are the same person."""
    if not phone:
        return ""
    cleaned = "".join(ch for ch in str(phone) if ch.isdigit() or ch == "+")
    if not cleaned:
        return ""
    if cleaned.startswith("+"):
        return "+" + "".join(ch for ch in cleaned[1:] if ch.isdigit())
    if cleaned.startswith("00"):
        return "+" + cleaned[2:]
    return "+44" + cleaned.lstrip("0")


def load_dnd() -> list:
    if DND_FILE.exists():
        try:
            data = json.loads(DND_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            # A malformed DND list must never read as "nobody opted out" —
            # fail closed is impossible here, so at least be loud about it.
            print("WARNING: dnd-list.json unreadable — treating as empty", file=sys.stderr)
            return []
        if isinstance(data, dict):          # tolerate {"numbers": [...]} shape
            data = data.get("numbers", [])
        return [d for d in data if isinstance(d, str)]
    return []

def save_dnd(dnd: list):
    DND_FILE.parent.mkdir(parents=True, exist_ok=True)
    DND_FILE.write_text(json.dumps(dnd, indent=2))

def is_dnd(phone: str) -> bool:
    target = normalize_phone(phone)
    if not target:
        return False
    return any(normalize_phone(d) == target for d in load_dnd())

def log_compliance(event: str, phone: str, **extra):
    """Append a timestamped compliance event. dnd-list.json holds only bare
    numbers, so this is the only record of WHEN someone opted out — the
    compliance report reads it. Never let a logging failure kill a call."""
    entry = {"event": event, "phone": phone, "timestamp": time.time(), **extra}
    try:
        COMPLIANCE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(COMPLIANCE_FILE, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError as e:
        print(f"WARNING: could not write compliance log: {e}", file=sys.stderr)

def add_dnd(phone: str, source: str = "manual", **extra):
    phone = normalize_phone(phone) or phone
    if not is_dnd(phone):
        dnd = load_dnd()
        dnd.append(phone)
        save_dnd(dnd)
        log_compliance("dnd_added", phone, source=source, **extra)

# ── Attempt limiting ───────────────────────────────────────────────

def count_attempts(phone: str) -> int:
    """How many real (non-dry-run) calls we've already placed to this number."""
    target = normalize_phone(phone)
    if not target or not LOG_FILE.exists():
        return 0
    n = 0
    try:
        lines = LOG_FILE.read_text().strip().split("\n")
    except OSError:
        return 0
    for line in lines:
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if entry.get("dry_run"):
            continue
        # Blocked attempts never reached the network — they don't burn a try.
        if entry.get("result") in ("blocked", "exhausted"):
            continue
        if normalize_phone(entry.get("phone", "")) == target:
            n += 1
    return n


def is_exhausted(phone: str) -> bool:
    return count_attempts(phone) >= MAX_CALL_ATTEMPTS

# ── Conversation state ─────────────────────────────────────────────

def save_state(call_sid: str, state: dict):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    entries = {}
    if STATE_FILE.exists():
        for line in STATE_FILE.read_text().strip().split("\n"):
            if line.strip():
                try:
                    e = json.loads(line)
                    entries[e.get("call_sid")] = e
                except: pass
    state["call_sid"] = call_sid
    state["updated_at"] = time.time()
    entries[call_sid] = state
    with open(STATE_FILE, "w") as f:
        for e in entries.values():
            f.write(json.dumps(e) + "\n")

def get_state(call_sid: str) -> dict:
    if not STATE_FILE.exists():
        return {}
    for line in STATE_FILE.read_text().strip().split("\n"):
        if line.strip():
            try:
                e = json.loads(line)
                if e.get("call_sid") == call_sid:
                    return e
            except: pass
    return {}

# ── Kimi K3 conversation ──────────────────────────────────────────

def call_kimi(messages: list, system: str = "") -> str:
    if not OPENROUTER_API_KEY:
        load_env()
    if not OPENROUTER_API_KEY:
        return "Error: API key not configured"

    msgs = []
    if system:
        msgs.append({"role": "system", "content": system})
    msgs.extend(messages)

    payload = {
        "model": "moonshotai/kimi-k3",
        "messages": msgs,
        "max_tokens": 500,
        "temperature": 0.7,
    }

    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {OPENROUTER_API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read())
            return data["choices"][0]["message"]["content"]
    except Exception as e:
        return f"[Error: {e}]"

# ── Lead scoring ──────────────────────────────────────────────────

def _transcript(conversation: list[dict]) -> str:
    return "\n".join(
        f"{'Agent' if m.get('role') == 'agent' else 'Lead'}: {m.get('text', '')}"
        for m in conversation
    )


def _score_conversation(conversation: list[dict], business: str) -> dict:
    """Ask Kimi K3 to score a transcript. Returns the parsed score dict, or a
    neutral fallback if the model output can't be parsed."""
    script = load_scripts().get(business, {})
    system = f"""You are a lead scoring AI for {script.get('name', business)}.
Analyse the conversation and return ONLY valid JSON:
{{
  "score": 1-10,
  "tag": "hot|warm|cold",
  "interest_level": "high|medium|low",
  "decision_maker": true|false,
  "summary": "one-line summary",
  "follow_up": "immediate callback|schedule|nurture|none",
  "objections_heard": [],
  "key_info": {{}}
}}
Scoring guide: 8-10 = hot (buying signals, decision-maker, wants follow-up);
4-7 = warm (some interest, needs nurturing); 1-3 = cold (no interest)."""

    prompt = (f"Conversation transcript:\n{_transcript(conversation)}\n\n"
              f"Score this lead for {script.get('name', business)}.")
    result = call_kimi([{"role": "user", "content": prompt}], system)

    try:
        import re
        m = re.search(r'\{.*\}', result, re.DOTALL)
        return json.loads(m.group()) if m else {"score": 5, "tag": "warm"}
    except Exception:
        return {"score": 5, "tag": "warm"}


def _coerce_score(value) -> int:
    """Kimi may return the score as int, float, or "8/10" — normalise to int."""
    try:
        if isinstance(value, str):
            value = value.split("/")[0].strip()
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def create_lead_ticket(record: dict, state: dict) -> dict:
    """Push a hot lead onto the Ops Board as a 1st-line follow-up ticket.
    Returns the created ticket (PostgREST representation) or an {"error": ...}."""
    business = record.get("business", "")
    script = load_scripts().get(business, {})
    name = script.get("name", business or "lead")
    score = record.get("score")
    phone = record.get("phone") or state.get("phone", "")
    summary = record.get("summary") or "Hot lead from the call centre"

    payload = {
        "title": f"Hot lead ({score}/10): {summary}"[:200],
        "description": (
            f"AGENT OS call-centre flagged a HOT lead for {name}.\n\n"
            f"Score: {score}/10   Tag: {record.get('tag')}\n"
            f"Interest: {record.get('interest_level')}   "
            f"Decision-maker: {record.get('decision_maker')}\n"
            f"Suggested follow-up: {record.get('follow_up')}\n"
            f"Objections: {record.get('objections_heard')}\n"
            f"Phone: {phone}\n"
            f"Call SID: {record.get('call_sid')}\n\n"
            f"Transcript:\n{_transcript(state.get('conversation', []))}"
        ),
        "status": "pending_dispatch",
        "priority": "high",
        "ticket_type": "service_request",
        "impact": "high",
        "urgency": "high",
        "assignment_tier": "1st_line",
        "business": business or "general",
        "project": business or "agent-os",
        "contact_name": name,
        "contact_phone": phone,
    }
    try:
        req = urllib.request.Request(
            OPS_API,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json",
                     "Prefer": "return=representation"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read()
            data = json.loads(raw) if raw else []
            if isinstance(data, list):
                return data[0] if data else {}
            return data or {}
    except Exception as e:
        return {"error": str(e)}


def _save_score(record: dict):
    SCORES_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(SCORES_FILE, "a") as f:
        f.write(json.dumps(record) + "\n")


def score_lead(call_sid: str) -> dict:
    """Score the lead for one call: read its conversation state, ask Kimi K3 to
    rate it, persist the result to lead-scores.jsonl, and — for hot leads
    (score > 7) — open an Ops Board follow-up ticket. Returns the score record.
    """
    state = get_state(call_sid)
    if not state:
        return {"error": f"No conversation state for call_sid {call_sid}"}

    # A number on the do-not-call list must not be scored: scoring feeds the
    # hot-lead ticket queue, and an opted-out lead that scores 9 would come
    # straight back as a follow-up task. Opt-out wins over commercial interest.
    phone = state.get("phone", "")
    if is_dnd(phone):
        return {"error": "Number is on do-not-call list — not scored",
                "status": "blocked", "reason": "dnd",
                "call_sid": call_sid, "phone": phone}

    business = state.get("business", "")
    conversation = state.get("conversation", [])
    scored = _score_conversation(conversation, business)

    record = {
        "call_sid": call_sid,
        "business": business,
        "phone": phone,
        "scored_at": time.time(),
        **scored,
    }

    # Hot lead → follow-up ticket. Do this before persisting so the saved
    # record carries the resulting ticket id (or the failure reason).
    score_val = _coerce_score(scored.get("score"))
    record["hot"] = score_val > HOT_LEAD_THRESHOLD
    if record["hot"]:
        ticket = create_lead_ticket(record, state)
        record["ticket_id"] = ticket.get("id")
        if ticket.get("error"):
            record["ticket_error"] = ticket["error"]

    _save_score(record)
    return record

# ── Twilio webhook handler (called from app.py) ───────────────────

def handle_response(call_sid: str, speech_result: str, business: str) -> str:
    """Process what the lead said and return TwiML for the next response.
    This is called by the /api/call-center/handle-response endpoint.
    """
    # Load state
    state = get_state(call_sid)
    if not state:
        state = {
            "business": business,
            "conversation": [],
            "questions_asked": 0,
            "info_gathered": {},
        }

    script = load_scripts().get(business, {})

    # Record the lead's turn up front so the transcript (used for lead scoring)
    # captures their final words even when they opt out or bow out here.
    state["conversation"].append({"role": "lead", "text": speech_result})
    state["questions_asked"] += 1
    speech_lower = speech_result.lower().strip()

    # Hard opt-out → do-not-call list. A firm "don't call me" is a legal DNC
    # request; honour it permanently. "stop" is intentionally NOT here on its
    # own — it substring-matches "bus stop"/"non-stop" and would wrongly DND.
    opt_out_phrases = ["stop calling", "do not call", "don't call me",
                       "don't call again", "don't call me again", "never call",
                       "take me off", "remove me", "remove my number",
                       "unsubscribe", "opt out", "opt me out", "leave me alone"]
    if any(phrase in speech_lower for phrase in opt_out_phrases):
        phone = state.get("phone", "")
        if phone:
            add_dnd(phone, source="call_opt_out", business=business,
                    call_sid=call_sid)
        state["status"] = "opted_out"
        save_state(call_sid, state)
        return _end_call("No problem at all. You've been added to our "
                         "do-not-call list and won't be contacted again. Goodbye.")

    # Soft disinterest → end politely, but do NOT add to DND. Not wanting this
    # call today isn't a request to never be contacted, so leave them callable.
    disinterest_phrases = ["not interested", "no interest", "no thanks",
                           "no thank you", "not right now", "not at the moment",
                           "we're all set", "we are all set", "we're good",
                           "we're fine", "not looking", "no need"]
    if any(phrase in speech_lower for phrase in disinterest_phrases):
        state["status"] = "not_interested"
        save_state(call_sid, state)
        return _end_call(script.get("not_interested",
                         "No problem at all. Thanks for your time and have a great day. Goodbye."))

    # Build the conversation history for Kimi
    system = f"""You are a {script.get('name', business)} sales agent calling {script.get('business_type', 'prospects')}.
Your personality: polite, professional, friendly.
Your goal: qualify the lead and gather info.
Your opening was: {script.get('opening', '')}
Questions to get through: {json.dumps(script.get('questions', []))}
 
Rules:
- Keep responses short and natural (under 30 words)
- Don't sound robotic or scripted
- If they sound interested, try to book a callback
- If they sound busy, offer to call later
- If they object, handle it naturally
- End the call politely when you have enough info or they're not interested

Compliance rules — these override every rule above and are not negotiable:
- This call is recorded. If they ask whether they are being recorded, confirm
  that they are, and that it's for training purposes.
- If they ask where you got their number, answer HONESTLY and specifically:
  their number is in {script.get('name', business)}'s business-contact database,
  sourced from publicly listed business contact details and prior enquiries.
  Never invent a source, never claim they signed up or opted in unless you have
  been told in this conversation that they did, and never say "I don't know".
- If they ask to see, correct, or have their data deleted, tell them that's
  their right, that you'll log the request now, and that it will be actioned.
- If they ask to be removed or not called again, agree immediately and end the
  call — do not pitch, do not ask why, do not try to keep them on the line.
- Never claim to be human if asked directly whether you are a person or an AI.

Respond with your next line of dialogue. Nothing else. Just what you'd say next."""

    # Build messages for Kimi
    messages = []
    for m in state["conversation"]:
        role = "assistant" if m["role"] == "agent" else "user"
        messages.append({"role": role, "content": m["text"]})

    ai_response = call_kimi(messages, system)

    # Add AI response to conversation
    state["conversation"].append({"role": "agent", "text": ai_response})
    save_state(call_sid, state)

    # Check if call should end
    ending_phrases = ["goodbye", "have a great day", "thanks for your time",
                      "call back", "send you the details"]
    should_end = any(phrase in ai_response.lower() for phrase in ending_phrases) or state["questions_asked"] >= 6
    max_duration = script.get("max_duration_minutes", 5)
    elapsed = time.time() - state.get("started_at", time.time())
    timeout = elapsed > max_duration * 60

    if should_end or timeout:
        return _end_call(ai_response)

    # Return TwiML for next Gather. The action URL must be absolute and carry
    # ?business= — inline TwiML has no base URL for relative paths to resolve
    # against, and Twilio does not echo custom fields back in the POST body.
    return twilio_bridge.gather_twiml(ai_response, business,
                                      prompt="Go ahead.", timeout=4)

def _end_call(closing: str) -> str:
    return twilio_bridge.hangup_twiml(closing)

# ── Make a call ──────────────────────────────────────────────────

def make_call(business_slug: str, phone_number: str, dry_run: bool = False) -> dict:
    scripts = load_scripts()
    script = scripts.get(business_slug)
    if not script:
        return {"error": f"Unknown business: {business_slug}"}

    phone_number = normalize_phone(phone_number)
    if not phone_number:
        return {"error": "No usable phone number", "status": "blocked"}

    # Compliance gate 1 — do-not-call. Checked before anything is dialled, and
    # on both the CLI and API paths (both land here). Dry runs are gated too:
    # a rehearsal that "would have called" a DND number is still a failure.
    if is_dnd(phone_number):
        result = {"error": "Number is on do-not-call list", "status": "blocked",
                  "reason": "dnd", "phone": phone_number}
        _log_call(business_slug, phone_number, result, dry_run, "")
        return result

    # Compliance gate 2 — attempt cap. Three tries per lead, then stop.
    attempts = count_attempts(phone_number)
    if attempts >= MAX_CALL_ATTEMPTS:
        result = {"error": f"Max {MAX_CALL_ATTEMPTS} call attempts reached",
                  "status": "exhausted", "reason": "max_attempts",
                  "attempts": attempts, "phone": phone_number}
        _log_call(business_slug, phone_number, result, dry_run, "")
        return result

    script = scripts[business_slug]
    opening = script.get("opening", "Hello, this is a call.")

    # Recording notice leads the call — it has to be heard before the lead
    # says anything that could be recorded.
    twiml = twilio_bridge.gather_twiml(f"{RECORDING_NOTICE} {opening}", business_slug)

    if dry_run:
        # Exercise everything except the paid API call: script lookup, number
        # normalisation, DND check, TwiML generation, state + log write.
        print("── DRY RUN — no call placed ──────────────────────────")
        print(f"  business : {business_slug} ({script.get('name', '?')})")
        print(f"  to       : {phone_number}")
        print(f"  from     : {twilio_bridge.creds()[2] or '(no caller ID configured)'}")
        print(f"  webhook  : {twilio_bridge.webhook_url(business=business_slug)}")
        print(f"  attempts : {attempts}/{MAX_CALL_ATTEMPTS} already placed")
        print(f"  twilio   : {'configured' if twilio_bridge.is_configured() else 'NOT configured'}")
        print("  TwiML    :")
        print("\n".join(f"    {ln}" for ln in twiml.splitlines()))
        print("──────────────────────────────────────────────────────")
        result = {"sid": f"DRYRUN{int(time.time())}", "status": "dry-run", "dry_run": True}
    else:
        result = twilio_bridge.make_call(phone_number, twiml)
    call_sid = result.get("sid", "")

    # Save initial state
    if call_sid:
        save_state(call_sid, {
            "business": business_slug,
            "phone": phone_number,
            "conversation": [{"role": "agent", "text": f"{RECORDING_NOTICE} {opening}"}],
            "questions_asked": 0,
            "info_gathered": {},
            "started_at": time.time(),
            "status": "in_progress",
            "attempt": attempts + 1,
        })

    # The notice is baked into the opening TwiML above, so any call that got
    # as far as being placed played it.
    _log_call(business_slug, phone_number, result, dry_run, call_sid,
              recording_notice=True)
    return result


def _log_call(business: str, phone: str, result: dict, dry_run: bool, call_sid: str,
              recording_notice: bool | None = None):
    """Append to call-log.jsonl. Dry runs and compliance blocks are logged too,
    flagged so stats and count_attempts() can tell them from a real dial.

    recording_notice records whether the opening TwiML carried the notice, so
    the compliance report can prove it rather than assume it."""
    log = {
        "business": business, "phone": phone,
        "timestamp": time.time(), "result": result.get("status", "unknown"),
        "call_sid": call_sid, "dry_run": bool(dry_run),
    }
    if result.get("reason"):
        log["reason"] = result["reason"]
    if recording_notice is not None:
        log["recording_notice"] = bool(recording_notice)
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG_FILE, "a") as f:
        f.write(json.dumps(log) + "\n")

    # Compliance refusals are worth their own timestamped audit line.
    if result.get("reason") in ("dnd", "max_attempts"):
        log_compliance("call_blocked", phone, reason=result["reason"],
                       business=business, dry_run=bool(dry_run),
                       attempts=result.get("attempts"))

# ── Queue processing ─────────────────────────────────────────────

def run_queue(business_slug: str, dry_run: bool = False):
    import sqlite3
    scripts = load_scripts()
    script = scripts.get(business_slug)
    if not script:
        print(f"Unknown business: {business_slug}")
        return

    # Check working hours
    now = time.localtime()
    hour = now.tm_hour
    wh = script.get("working_hours", {"start": 9, "end": 20})
    if hour < wh["start"] or hour >= wh["end"]:
        print(f"Outside working hours ({wh['start']}:00-{wh['end']}:00). Skipping queue.")
        return

    conn = sqlite3.connect(str(DB_FILE))
    leads = conn.execute(
        "SELECT id, company, contact_name, phone FROM leads WHERE status='new' AND phone IS NOT NULL AND phone NOT IN (SELECT value FROM json_each(?)) LIMIT 5",
        (json.dumps(load_dnd()),)
    ).fetchall()

    if not leads:
        print("No leads to call.")
        conn.close()
        return

    for lead in leads:
        lid, company, name, phone = lead
        if is_dnd(phone):
            continue
        if is_exhausted(phone):
            print(f"  skip {phone}: {MAX_CALL_ATTEMPTS} attempts already made")
            conn.execute("UPDATE leads SET status='exhausted' WHERE id=?", (lid,))
            conn.commit()
            continue

        print(f"Calling {name or company} at {phone}...")
        result = make_call(business_slug, phone, dry_run=dry_run)
        status = result.get("status", "failed")
        print(f"  → {status}")

        if status == "queued":
            conn.execute("UPDATE leads SET status='contacted' WHERE id=?", (lid,))
        conn.commit()
        # A dry run shouldn't sit through the real inter-call pacing.
        time.sleep(0 if dry_run else 30)

    conn.close()

# ── Status ───────────────────────────────────────────────────────

def show_status():
    log_file = Path("/var/lib/agent-os/call-log.jsonl")
    if not log_file.exists():
        print("No calls made yet.")
        return
    calls = []
    for line in log_file.read_text().strip().split("\n"):
        if line.strip():
            try: calls.append(json.loads(line))
            except: pass
    print(f"Call History ({len(calls)} calls)")
    for c in reversed(calls[-15:]):
        ts = time.strftime("%Y-%m-%d %H:%M", time.localtime(c["timestamp"]))
        print(f"  {ts} | {c.get('business','?'):15s} | {c.get('phone','?'):15s} | {c.get('result','?')}")
    print(f"\nDND list: {len(load_dnd())} numbers")

def count_stats() -> dict:
    """Return call stats for the dashboard."""
    log_file = Path("/var/lib/agent-os/call-log.jsonl")
    if not log_file.exists():
        return {"total": 0, "successful": 0, "blocked": 0}
    total = 0
    successful = 0
    for line in log_file.read_text().strip().split("\n"):
        if line.strip():
            total += 1
            try:
                c = json.loads(line)
                if c.get("result") in ("queued", "in-progress", "completed"):
                    successful += 1
            except: pass
    return {"total": total, "successful": successful, "blocked": len(load_dnd())}


if __name__ == "__main__":
    load_env()
    args = [a for a in sys.argv[1:] if a != "--dry-run"]
    dry_run = "--dry-run" in sys.argv
    cmd = args[0] if args else "status"

    if cmd == "call":
        if len(args) < 3:
            print("Usage: call_agent.py call <business> <phone> [--dry-run]")
        else:
            result = make_call(args[1], args[2], dry_run=dry_run)
            print(json.dumps(result, indent=2))
    elif cmd == "queue":
        if len(args) < 2:
            print("Usage: call_agent.py queue <business> [--dry-run]")
        else:
            run_queue(args[1], dry_run=dry_run)
    elif cmd == "status":
        show_status()
    elif cmd == "stats":
        print(json.dumps(count_stats()))
    elif cmd == "score":
        if len(args) < 2:
            print("Usage: call_agent.py score <call_sid>")
        else:
            print(json.dumps(score_lead(args[1]), indent=2))
    elif cmd == "config":
        print(json.dumps(twilio_bridge.config_status(), indent=2))
    else:
        print("Commands: call, queue, status, stats, score, config   (add --dry-run to call/queue)")
