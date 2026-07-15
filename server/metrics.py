"""Token counting + cost tracking for AGENT OS.

usage_record() turns one generation into a token/cost blob (stored in
agent_logs.details_json and denormalised into token_count/cost_usd).
summary()/trends() aggregate those for the metrics dashboard.
"""
from __future__ import annotations

from server import inference
from server import db as db_module

PRICING = inference.PRICING_PER_MTOK


def usage_record(model: str, system: str, prompt: str, raw: str) -> dict:
    """Token/cost record for one generation. Prefers provider-reported
    usage; falls back to a length estimate (e.g. under test)."""
    u = inference.pop_usage() or {
        "prompt_tokens": inference.estimate_tokens(system + prompt),
        "completion_tokens": inference.estimate_tokens(raw),
    }
    pin, pout = PRICING.get(model, PRICING["deepseek"])
    cost = (u["prompt_tokens"] * pin + u["completion_tokens"] * pout) / 1_000_000
    total = u["prompt_tokens"] + u["completion_tokens"]
    return {"model": model, "prompt_tokens": u["prompt_tokens"],
            "completion_tokens": u["completion_tokens"], "total_tokens": total,
            "cost_usd": round(cost, 6)}


def summary(conn, tenant_id: int) -> dict:
    """Token + cost totals: today, this week, all-time, and per-model split."""
    now_row = db_module.one(conn, "SELECT strftime('%s','now') AS n")
    now = int(now_row["n"])
    day_start = now - (now % 86400)
    week_start = now - 7 * 86400

    def agg(since):
        r = db_module.one(conn,
            "SELECT COALESCE(SUM(token_count),0) AS tok, COALESCE(SUM(cost_usd),0) AS cost, "
            "COUNT(*) AS runs FROM agent_logs WHERE tenant_id = ? AND created_at >= ?",
            (tenant_id, since))
        return {"tokens": r["tok"], "cost_usd": round(r["cost"], 4), "runs": r["runs"]}

    by_model = {}
    for r in db_module.rows(conn,
            "SELECT json_extract(details_json,'$.usage.model') AS model, "
            "COALESCE(SUM(token_count),0) AS tok, COALESCE(SUM(cost_usd),0) AS cost "
            "FROM agent_logs WHERE tenant_id = ? AND token_count > 0 GROUP BY model",
            (tenant_id,)):
        by_model[r["model"] or "unknown"] = {
            "tokens": r["tok"], "cost_usd": round(r["cost"], 4)}

    return {
        "today": agg(day_start),
        "week": agg(week_start),
        "all_time": agg(0),
        "by_model": by_model,
        "trends": trends(conn, tenant_id),
        "generated_at": now,
    }


def trends(conn, tenant_id: int, days: int = 14) -> dict:
    """Per-day token + cost series for sparklines (oldest → newest)."""
    rows = db_module.rows(conn,
        "SELECT strftime('%Y-%m-%d', created_at, 'unixepoch') AS day, "
        "COALESCE(SUM(token_count),0) AS tok, COALESCE(SUM(cost_usd),0) AS cost, "
        "COUNT(*) AS runs FROM agent_logs "
        "WHERE tenant_id = ? AND created_at >= strftime('%s','now') - ? "
        "GROUP BY day ORDER BY day", (tenant_id, days * 86400))
    by_day = {r["day"]: r for r in rows}
    # dense series so sparklines don't skip empty days
    from datetime import datetime, timedelta, timezone
    today = datetime.now(timezone.utc).date()
    labels, tokens, cost, runs = [], [], [], []
    for i in range(days - 1, -1, -1):
        d = (today - timedelta(days=i)).isoformat()
        labels.append(d)
        row = by_day.get(d)
        tokens.append(row["tok"] if row else 0)
        cost.append(round(row["cost"], 4) if row else 0)
        runs.append(row["runs"] if row else 0)
    return {"labels": labels, "tokens": tokens, "cost_usd": cost, "runs": runs}
