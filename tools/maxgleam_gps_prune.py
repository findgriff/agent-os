#!/usr/bin/env python3
"""Max Gleam — crew GPS retention prune.

Drops location points past RETENTION_DAYS, keeping the module's "a dispatch
tool, not surveillance" promise. This is the cron caller for the same prune()
the HQ POST /api/maxgleam/gps/prune route exposes; either path is safe and
idempotent — a repeat run with nothing stale deletes nothing.

Run daily from cron:
    15 4 * * * root /usr/bin/python3 /opt/agent-os/tools/maxgleam_gps_prune.py
"""
from __future__ import annotations
import json
import logging
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# cron does not read the systemd EnvironmentFile — load it so this sweep
# sees the same DB paths and switches as the running server.
ENV_FILE = Path(os.environ.get("AGENTOS_ENV_FILE", "/etc/agent-os.env"))
if ENV_FILE.is_file():
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))

from server import maxgleam_gps  # noqa: E402

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s mg-gps-prune %(levelname)s %(message)s")


def main() -> int:
    result = maxgleam_gps.prune()
    logging.info("result %s", result)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
