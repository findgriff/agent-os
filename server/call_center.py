"""Call Center campaigns, analytics and compliance reporting.

Reads the append-only files the calling engine already writes (see
tools/call_agent.py) and owns one new store, call-center.json, for campaigns.

    call-log.jsonl        one line per make_call() — business, phone, timestamp,
                          result, call_sid, dry_run, reason, recording_notice
    call-state.jsonl      one record per call_sid — the conversation transcript
    lead-scores.jsonl     one line per scored call — score, tag, hot
    dnd-list.json         do-not-call numbers (list of strings, no timestamps)
    compliance-log.jsonl  timestamped compliance events
    call-center.json      campaigns (owned here)

What the derived metrics actually mean — these are inferences from the data we
keep, not carrier facts, and the dashboard labels them as such:

    answered    the lead spoke at least once. Twilio's "queued" only means the
                API accepted the dial, so it cannot stand in for a pickup.
    duration    span of the handled conversation (last turn − first turn). NOT
                Twilio's billed duration — nothing records that today, because
                the StatusCallback is not wired up.
    conversion  a scored call that came out hot, i.e. the same bar that opens
                an Ops Board follow-up ticket.

Campaign attribution: calls carry no campaign id, so a call belongs to a
campaign when its business matches and its timestamp falls inside the
campaign's date range. Overlapping campaigns on one business will therefore
both count the same call.
"""
import json
import os
import time
from pathlib import Path

DATA_DIR = Path("/var/lib/agent-os")
LOG_FILE = DATA_DIR / "call-log.jsonl"
STATE_FILE = DATA_DIR / "call-state.jsonl"
SCORES_FILE = DATA_DIR / "lead-scores.jsonl"
DND_FILE = DATA_DIR / "dnd-list.json"
COMPLIANCE_FILE = DATA_DIR / "compliance-log.jsonl"
CAMPAIGN_FILE = DATA_DIR / "call-center.json"

# Twilio UK outbound is charged per minute; 2p per call is the working estimate
# the dashboard shows. It is an estimate, not a billed figure.
COST_PER_CALL_PENCE = 2

# Results that mean "we never dialled" — compliance refusals, not attempts.
BLOCKED_RESULTS = ("blocked", "exhausted")

VALID_CAMPAIGN_STATUS = ("draft", "active", "paused", "complete")


# ── File helpers ────────────────────────────────────────────────────

def _read_jsonl(path: Path) -> list[dict]:
    """Read a .jsonl file, skipping unparseable lines rather than failing the
    whole dashboard because one write was interrupted."""
    if not path.exists():
        return []
    out = []
    try:
        raw = path.read_text()
    except OSError:
        return []
    for line in raw.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(entry, dict):
            out.append(entry)
    return out


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return default


def _normalize_phone(phone: str) -> str:
    """Mirror of tools.call_agent.normalize_phone — imported lazily so this
    module stays usable if the CLI tool is unavailable."""
    try:
        from tools.call_agent import normalize_phone
        return normalize_phone(phone)
    except Exception:
        return (phone or "").strip()


# ── Joined call records ─────────────────────────────────────────────

def _duration(state: dict) -> float:
    """Conversation span in seconds, or 0 when we have nothing to measure."""
    started = state.get("started_at")
    updated = state.get("updated_at")
    if not started or not updated:
        return 0.0
    return max(0.0, float(updated) - float(started))


def calls() -> list[dict]:
    """Every logged call, joined to its conversation state and lead score."""
    states, scores = {}, {}
    for e in _read_jsonl(STATE_FILE):
        if e.get("call_sid"):
            states[e["call_sid"]] = e
    for e in _read_jsonl(SCORES_FILE):
        if e.get("call_sid"):
            scores[e["call_sid"]] = e  # last score for a sid wins

    out = []
    for entry in _read_jsonl(LOG_FILE):
        sid = entry.get("call_sid") or ""
        state = states.get(sid, {})
        score = scores.get(sid, {})
        lead_turns = [m for m in state.get("conversation", [])
                      if m.get("role") == "lead"]
        result = entry.get("result", "")
        blocked = result in BLOCKED_RESULTS
        dry_run = bool(entry.get("dry_run"))
        # A real dial always comes back with a Twilio SID. No SID means the API
        # rejected it (bad creds, bad number) — nothing was dialled and nothing
        # is charged, so it must not count toward rates or cost.
        errored = not dry_run and not blocked and not sid
        placed = not dry_run and not blocked and bool(sid)

        out.append({
            "call_sid": sid,
            "business": entry.get("business", ""),
            "phone": entry.get("phone", ""),
            "timestamp": float(entry.get("timestamp") or 0),
            "result": result,
            "reason": entry.get("reason"),
            "dry_run": dry_run,
            "blocked": blocked,
            "placed": placed,
            "errored": errored,
            # Someone picked up and spoke. No lead turn ⇒ we cannot claim it.
            "answered": placed and bool(lead_turns),
            "lead_turns": len(lead_turns),
            "duration": _duration(state) if lead_turns else 0.0,
            "call_status": state.get("status"),
            "score": score.get("score"),
            "tag": score.get("tag"),
            "converted": placed and bool(score.get("hot")),
            # Older log lines predate the flag; None means "not recorded",
            # which is not the same as "no notice played".
            "recording_notice": entry.get("recording_notice"),
        })
    out.sort(key=lambda c: c["timestamp"])
    return out


# ── Analytics ───────────────────────────────────────────────────────

def _pct(part: int, whole: int) -> float:
    return round(part / whole * 100, 1) if whole else 0.0


def _day_key(ts: float) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(ts))


def daily_activity(all_calls: list[dict], days: int = 7) -> list[dict]:
    """Per-day counts for the last `days` days, oldest first. Days with no
    activity are included as zeroes so the bar chart keeps a stable width."""
    buckets: dict[str, dict] = {}
    now = time.time()
    for i in range(days - 1, -1, -1):
        # Step by whole days from local midnight so DST shifts don't drop a day.
        key = _day_key(now - i * 86400)
        buckets[key] = {"date": key, "calls": 0, "answered": 0,
                        "converted": 0, "blocked": 0}
    for c in all_calls:
        key = _day_key(c["timestamp"])
        b = buckets.get(key)
        if not b:
            continue
        if c["blocked"]:
            b["blocked"] += 1
            continue
        if not c["placed"]:        # dry runs and API errors aren't activity
            continue
        b["calls"] += 1
        if c["answered"]:
            b["answered"] += 1
        if c["converted"]:
            b["converted"] += 1
    for key, b in buckets.items():
        b["label"] = time.strftime("%a", time.strptime(key, "%Y-%m-%d"))
    return list(buckets.values())


def analytics(days: int = 7) -> dict:
    all_calls = calls()
    placed = [c for c in all_calls if c["placed"]]
    answered = [c for c in placed if c["answered"]]
    converted = [c for c in placed if c["converted"]]
    durations = [c["duration"] for c in answered if c["duration"] > 0]
    scored = [c["score"] for c in all_calls
              if isinstance(c["score"], (int, float))]

    return {
        "total_logged": len(all_calls),
        "calls_placed": len(placed),
        "dry_runs": sum(1 for c in all_calls if c["dry_run"]),
        "blocked": sum(1 for c in all_calls if c["blocked"]),
        # Rejected by Twilio before dialling — excluded from rates and cost.
        "errors": sum(1 for c in all_calls if c["errored"]),
        "answered": len(answered),
        # % of placed calls where the lead actually spoke.
        "answer_rate": _pct(len(answered), len(placed)),
        "converted": len(converted),
        # % of ANSWERED calls that scored hot — conversations we won, not
        # dials we made. Rate over placed calls would flatter us.
        "conversion_rate": _pct(len(converted), len(answered)),
        "avg_duration_seconds": round(sum(durations) / len(durations), 1) if durations else 0.0,
        "duration_sample": len(durations),
        "avg_score": round(sum(scored) / len(scored), 1) if scored else None,
        "cost_per_call_pence": COST_PER_CALL_PENCE,
        "total_cost_pence": len(placed) * COST_PER_CALL_PENCE,
        "cost_per_conversion_pence": (round(len(placed) * COST_PER_CALL_PENCE / len(converted), 1)
                                      if converted else None),
        "daily": daily_activity(all_calls, days),
        "days": days,
        # Tell the UI what these numbers are, so it can label them honestly.
        "notes": {
            "answered": "Lead spoke at least once (Twilio pickup is not recorded).",
            "duration": "Span of the handled conversation, not Twilio billed time.",
            "cost": f"Estimate at {COST_PER_CALL_PENCE}p per placed call.",
        },
    }


# ── Compliance ──────────────────────────────────────────────────────

def compliance(limit: int = 100) -> dict:
    """DND opt-outs, blocked calls, and recording notices played."""
    all_calls = calls()
    events = _read_jsonl(COMPLIANCE_FILE)

    # Latest timestamped opt-out event per number.
    opt_out_at: dict[str, dict] = {}
    for e in events:
        if e.get("event") != "dnd_added":
            continue
        key = _normalize_phone(e.get("phone", ""))
        if key and e.get("timestamp", 0) >= opt_out_at.get(key, {}).get("timestamp", 0):
            opt_out_at[key] = e

    raw_dnd = _read_json(DND_FILE, [])
    if isinstance(raw_dnd, dict):
        raw_dnd = raw_dnd.get("numbers", [])
    dnd = []
    for phone in raw_dnd:
        if not isinstance(phone, str):
            continue
        ev = opt_out_at.get(_normalize_phone(phone), {})
        dnd.append({
            "phone": phone,
            # None = on the list from before event logging existed. The UI
            # shows "unknown" rather than inventing a date.
            "timestamp": ev.get("timestamp"),
            "source": ev.get("source", "unknown"),
            "business": ev.get("business", ""),
            "call_sid": ev.get("call_sid", ""),
        })
    dnd.sort(key=lambda d: d["timestamp"] or 0, reverse=True)

    blocked = [{
        "phone": c["phone"], "business": c["business"],
        "timestamp": c["timestamp"],
        "reason": c["reason"] or c["result"],
        "result": c["result"],
    } for c in all_calls if c["blocked"]]
    blocked.reverse()

    # Notices are only provable for calls logged after the flag shipped.
    placed = [c for c in all_calls if c["placed"]]
    notices = [{
        "phone": c["phone"], "business": c["business"],
        "timestamp": c["timestamp"], "call_sid": c["call_sid"],
    } for c in placed if c["recording_notice"]]
    notices.reverse()
    unverified = sum(1 for c in placed if c["recording_notice"] is None)

    return {
        "dnd": dnd[:limit],
        "dnd_total": len(dnd),
        "blocked": blocked[:limit],
        "blocked_total": len(blocked),
        "blocked_dnd": sum(1 for b in blocked if b["reason"] == "dnd"),
        "blocked_max_attempts": sum(1 for b in blocked if b["reason"] == "max_attempts"),
        "recording_notices": notices[:limit],
        "recording_notices_total": len(notices),
        # Calls placed before notice logging existed — reported, not hidden.
        "recording_notices_unverified": unverified,
        "opt_outs_this_call": sum(1 for c in all_calls
                                  if c["call_status"] == "opted_out"),
        "events": sorted(events, key=lambda e: e.get("timestamp", 0),
                         reverse=True)[:limit],
    }


# ── Campaigns ───────────────────────────────────────────────────────

def load_campaigns() -> list[dict]:
    data = _read_json(CAMPAIGN_FILE, {})
    if isinstance(data, list):        # tolerate a bare list
        return [c for c in data if isinstance(c, dict)]
    campaigns = data.get("campaigns", []) if isinstance(data, dict) else []
    return [c for c in campaigns if isinstance(c, dict)]


def save_campaigns(campaigns: list[dict]) -> None:
    """Write call-center.json, preserving any other keys already in the file."""
    data = _read_json(CAMPAIGN_FILE, {})
    if not isinstance(data, dict):
        data = {}
    data["campaigns"] = campaigns
    data["updated_at"] = int(time.time())
    os.makedirs(CAMPAIGN_FILE.parent, exist_ok=True)
    tmp = CAMPAIGN_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(CAMPAIGN_FILE)        # atomic — never leave a half-written file


def _parse_date(value: str) -> float | None:
    """YYYY-MM-DD (as the date input emits) → local epoch seconds."""
    if not value:
        return None
    try:
        return time.mktime(time.strptime(value[:10], "%Y-%m-%d"))
    except (ValueError, OverflowError):
        return None


def _new_id(campaigns: list[dict]) -> str:
    """A fresh campaign id. Two campaigns created in the same millisecond would
    otherwise share an id, and deleting one would delete both."""
    taken = {c.get("id") for c in campaigns}
    base = f"camp_{int(time.time() * 1000)}"
    if base not in taken:
        return base
    n = 2
    while f"{base}_{n}" in taken:
        n += 1
    return f"{base}_{n}"


def campaign_stats(campaign: dict, all_calls: list[dict] | None = None) -> dict:
    """Calls attributed to a campaign: same business, inside the date range."""
    if all_calls is None:
        all_calls = calls()
    business = campaign.get("business", "")
    start = _parse_date(campaign.get("start_date", ""))
    end = _parse_date(campaign.get("end_date", ""))
    if end is not None:
        end += 86400 - 1              # end date is inclusive

    matched = [
        c for c in all_calls
        if c["business"] == business
        and (start is None or c["timestamp"] >= start)
        and (end is None or c["timestamp"] <= end)
    ]
    placed = [c for c in matched if c["placed"]]
    answered = [c for c in placed if c["answered"]]
    converted = [c for c in placed if c["converted"]]
    return {
        "calls": len(placed),
        "answered": len(answered),
        "conversions": len(converted),
        "blocked": sum(1 for c in matched if c["blocked"]),
        "answer_rate": _pct(len(answered), len(placed)),
        "conversion_rate": _pct(len(converted), len(answered)),
        "cost_pence": len(placed) * COST_PER_CALL_PENCE,
    }


def list_campaigns() -> list[dict]:
    all_calls = calls()
    out = []
    for c in load_campaigns():
        out.append({**c, "stats": campaign_stats(c, all_calls)})
    out.sort(key=lambda c: c.get("created_at", 0), reverse=True)
    return out


def create_campaign(body: dict, businesses: list[str] | None = None) -> tuple[bool, dict]:
    """Validate and persist a campaign. Returns (ok, campaign_or_error)."""
    name = str(body.get("name", "")).strip()
    business = str(body.get("business", "")).strip()
    if not name:
        return False, {"error": "name is required"}
    if not business:
        return False, {"error": "business is required"}
    if businesses and business not in businesses:
        return False, {"error": f"unknown business: {business}"}

    start_date = str(body.get("start_date", "")).strip()
    end_date = str(body.get("end_date", "")).strip()
    start, end = _parse_date(start_date), _parse_date(end_date)
    if start_date and start is None:
        return False, {"error": "start_date must be YYYY-MM-DD"}
    if end_date and end is None:
        return False, {"error": "end_date must be YYYY-MM-DD"}
    if start is not None and end is not None and end < start:
        return False, {"error": "end_date is before start_date"}

    status = str(body.get("status", "active")).strip() or "active"
    if status not in VALID_CAMPAIGN_STATUS:
        return False, {"error": f"status must be one of {', '.join(VALID_CAMPAIGN_STATUS)}"}

    campaigns = load_campaigns()
    cid = str(body.get("id") or "").strip()
    entry = {
        "id": cid or _new_id(campaigns),
        "name": name[:120],
        "business": business,
        "lead_source": str(body.get("lead_source", "")).strip()[:120],
        "start_date": start_date,
        "end_date": end_date,
        "status": status,
        "notes": str(body.get("notes", "")).strip()[:500],
        "created_at": int(time.time()),
    }
    if cid and any(c.get("id") == cid for c in campaigns):
        entry["created_at"] = next(c.get("created_at", entry["created_at"])
                                   for c in campaigns if c.get("id") == cid)
        campaigns = [entry if c.get("id") == cid else c for c in campaigns]
    else:
        campaigns.append(entry)
    save_campaigns(campaigns)
    return True, {**entry, "stats": campaign_stats(entry)}


def delete_campaign(cid: str) -> bool:
    campaigns = load_campaigns()
    remaining = [c for c in campaigns if c.get("id") != cid]
    if len(remaining) == len(campaigns):
        return False
    save_campaigns(remaining)
    return True
