"""Self-checking factory — builder-judge quality loop for AGENT OS."""
import json, time, logging
from server import inference

log = logging.getLogger(__name__)

# ── Default judge rubric ──────────────────────────────────────────────────
RUBRIC = """
Score each criterion 0-20:
- Completeness: Are all required elements present?
- Quality: Is the output well-crafted and professional?
- Instructions: Does it follow the brief exactly?
- Polish: Is it refined, not raw or draft-like?
- Value: Does it deliver genuine utility?

Total /100. Pass = 80+.
"""


def run_loop(goal: str, builder_agent: dict, judge_agent: dict,
             *, max_rounds: int = 5, pass_threshold: int = 80,
             conn=None, db_module=None, tenant_id: int = 1) -> dict:
    """Run a builder-judge quality loop. Returns the final result."""
    rounds = []
    feedback = ""
    current_work = ""

    for rnd in range(1, max_rounds + 1):
        log.info("Loop round %d/%d", rnd, max_rounds)

        # ── BUILD ─────────────────────────────────────────────────────
        build_prompt = (
            f"You are {builder_agent['real_name']}, {builder_agent['role']}.\n"
            f"Your task: {goal}\n"
            f"Previous feedback: {feedback or 'None yet'}\n"
            f"{'Improve based on the feedback above.' if feedback else 'Produce your best work.'}"
        )
        work = inference.generate(
            build_prompt, f"Execute: {goal}",
            max_tokens=2000, temperature=0.7
        ) or "Failed to generate output."
        current_work = work
        log.info("  Build complete (%d chars)", len(work))

        # ── JUDGE ─────────────────────────────────────────────────────
        judge_prompt = (
            f"You are {judge_agent['real_name']}, {judge_agent['role']} — a strict but fair quality judge.\n"
            f"Goal: {goal}\n"
            f"Work to evaluate:\n{work[:2000]}\n\n"
            f"{RUBRIC}\n"
            "Respond with JSON only: {\"score\": <0-100>, \"feedback\": \"<what to fix>\", \"pass\": <true|false>}"
        )
        verdict = inference.generate(
            judge_prompt, "Score the work objectively.",
            max_tokens=500, temperature=0.3
        )

        # Parse score
        score = 0
        passed = False
        try:
            # Try to extract JSON from the response
            import re
            j = re.search(r'\{.*\}', verdict or '', re.DOTALL)
            if j:
                data = json.loads(j.group())
                score = int(data.get("score", 0))
                passed = data.get("pass", False)
                feedback = data.get("feedback", "")
        except (json.JSONDecodeError, ValueError, TypeError):
            score = 0
            passed = False
            feedback = verdict or "No structured feedback"

        log.info("  Judge score: %d/100 (pass=%s)", score, passed)

        rounds.append({
            "round": rnd,
            "score": score,
            "feedback": feedback,
            "work_preview": work[:300],
            "passed": passed,
        })

        if passed or score >= pass_threshold:
            log.info("  PASSED on round %d!", rnd)
            # Save to workspace
            if conn and db_module:
                try:
                    db_module.insert(conn, "workspace_items", {
                        "tenant_id": tenant_id,
                        "type": "document",
                        "title": f"Factory: {goal[:80]}",
                        "description": f"Built by {builder_agent['real_name']}, judged by {judge_agent['real_name']}. Score: {score}/100 after {rnd} round(s).",
                        "url": "",
                        "created_at": int(time.time()),
                    })
                    log.info("  Saved to workspace")
                except Exception as e:
                    log.warning("  Could not save to workspace: %s", e)
            return {
                "status": "passed",
                "rounds": rounds,
                "total_rounds": rnd,
                "final_score": score,
                "final_work": work,
                "feedback": feedback,
            }

        if rnd < max_rounds:
            feedback = f"Round {rnd} score: {score}/100. {feedback}"

    # Max rounds reached without passing
    return {
        "status": "max_rounds",
        "rounds": rounds,
        "total_rounds": max_rounds,
        "final_score": rounds[-1]["score"] if rounds else 0,
        "final_work": current_work,
        "feedback": feedback,
    }
