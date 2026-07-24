#!/usr/bin/env python3
"""Max Gleam — verify the crew GPS retention prune actually ran.

The prune cron (tools/maxgleam_gps_prune.py) fires daily at 04:15 and appends
its result to /var/log/maxgleam-gps-prune.log. This checks, shortly after, that
the run really happened and succeeded — so a silently skipped or crashing prune
surfaces as a FAIL line instead of going unnoticed while trails pile up.

Prints one verdict line to stdout (cron appends it to the verify log) and exits
0 on PASS, 1 on FAIL. It reads only the log file, never the DB, so it needs no
special privileges beyond reading /var/log.

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

    return _verdict(True, f"prune ran {_iso(mtime)} — deleted={result.get('deleted')} "
                          f"retention_days={result.get('retention_days')}")


if __name__ == "__main__":
    raise SystemExit(main())
