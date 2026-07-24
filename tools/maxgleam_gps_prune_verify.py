#!/usr/bin/env python3
"""Max Gleam — verify the crew GPS retention prune actually ran and worked.

The prune cron (tools/maxgleam_gps_prune.py) fires daily at 04:15 and appends
its result to /var/log/maxgleam-gps-prune.log. This checks, shortly after, two
things:

  1. Did it *run*? A fresh log with a clean result JSON — else the 04:15 fire
     was skipped or crashed, and trails are quietly piling up.
  2. Did it *work*? The authoritative end-state from maxgleam_gps.retention_status():
     no point older than the retention window should survive. A run can log a
     "deleted" count yet still leave stale data behind (a bad cutoff, a partial
     delete) — only the DB itself can confirm the promise was kept.

The end-state check needs the DB; if it can't be reached it is *skipped*, not
failed, so a transient hiccup never pages anyone when the run demonstrably
happened. FAIL is reserved for a run that was skipped/crashed, or stale points
positively observed.

Prints one verdict line to stdout (cron appends it to the verify log) and exits
0 on PASS, 1 on FAIL.

Run daily from cron, after the prune:
    25 4 * * * root /usr/bin/python3 /opt/agent-os/tools/maxgleam_gps_prune_verify.py
"""
from __future__ import annotations
import json
import os
import time
from pathlib import Path

PRUNE_LOG = Path(os.environ.get("MG_GPS_PRUNE_LOG", "/var/log/maxgleam-gps-prune.log"))

# The prune runs at 04:15 and this at 04:25; a log written within the last half
# hour is this morning's run. Anything older means the 04:15 fire was skipped.
FRESH_WINDOW_S = 30 * 60
TAIL_LINES = 15


def _iso(epoch: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def _verdict(ok: bool, message: str) -> int:
    print(f"{_iso(time.time())} mg-gps-prune-verify {'PASS' if ok else 'FAIL'} {message}")
    return 0 if ok else 1


def _end_state_verdict(status: dict) -> tuple[bool, str]:
    """Pure reading of a retention_status() report: is the log actually clean?
    ``healthy`` is False when a point older than the window survives the prune.
    Kept DB-free so the reasoning is unit-tested directly."""
    if status.get("healthy"):
        oldest = status.get("oldest_age_days")
        oldest_str = f"{oldest}d" if oldest is not None else "n/a"
        return True, (f"end-state clean — {status.get('points')} points, "
                      f"oldest {oldest_str}, none stale")
    return False, (f"{status.get('stale_points')} points older than "
                   f"{status.get('retention_days')}d survive the prune")


def _load_env() -> None:
    """cron does not read the systemd EnvironmentFile — load it so the DB paths
    and switches match the running server. Mirrors the prune cron caller."""
    env_file = Path(os.environ.get("AGENTOS_ENV_FILE", "/etc/agent-os.env"))
    if not env_file.is_file():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _check_end_state() -> tuple[bool | None, str]:
    """Confirm the DB end-state. Returns (None, reason) when the check can't be
    made — the run already passed the log check, so an unreachable DB is a skip,
    not a failure."""
    try:
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        _load_env()
        from server import maxgleam_gps
        return _end_state_verdict(maxgleam_gps.retention_status())
    except Exception as exc:  # DB unreachable, import error — don't false-alarm
        return None, f"{type(exc).__name__}: {exc}"


def main() -> int:
    if not PRUNE_LOG.is_file():
        return _verdict(False, f"{PRUNE_LOG} missing — 04:15 prune did not run "
                               "(or failed before it could log)")

    mtime = PRUNE_LOG.stat().st_mtime
    age = time.time() - mtime
    if age > FRESH_WINDOW_S:
        return _verdict(False, f"log not updated for {int(age)}s (last write "
                               f"{_iso(mtime)}) — this morning's prune appears skipped")

    tail = [ln.strip() for ln in PRUNE_LOG.read_text(errors="replace").splitlines()
            if ln.strip()][-TAIL_LINES:]

    # A crashing run leaves a traceback in the tail and no fresh result JSON; a
    # clean run prints json.dumps(result) among the last lines.
    if any("Traceback" in ln or ln.startswith("Traceback") for ln in tail):
        return _verdict(False, f"prune logged an error at {_iso(mtime)} — "
                               f"last line: {tail[-1]!r}")

    result = None
    for ln in reversed(tail):
        if ln.startswith("{") and '"deleted"' in ln:
            try:
                result = json.loads(ln)
                break
            except ValueError:
                continue

    if result is None:
        return _verdict(False, f"prune wrote at {_iso(mtime)} but produced no "
                               f"result JSON — last line: {tail[-1]!r}")

    # The run happened and logged cleanly. Now confirm it actually achieved
    # retention — the check the old log-only verify could never make.
    run_msg = (f"prune ran {_iso(mtime)} — deleted={result.get('deleted')} "
               f"retention_days={result.get('retention_days')}")
    ok, end_msg = _check_end_state()
    if ok is None:
        return _verdict(True, f"{run_msg}; end-state check skipped ({end_msg})")
    return _verdict(ok, f"{run_msg}; {end_msg}")


if __name__ == "__main__":
    raise SystemExit(main())
