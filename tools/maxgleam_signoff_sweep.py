#!/usr/bin/env python3
"""Max Gleam — sign-off auto-approval sweep.

Any completed job left unsigned for longer than the auto-approve window is
marked 'auto-approved', matching the promise made on the sign-off page.
Idempotent: only rows still NULL/'sent'/'pending' are touched.

Run hourly from cron:
    0 * * * * root /usr/bin/python3 /opt/agent-os/tools/maxgleam_signoff_sweep.py
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

from server import maxgleam_portal  # noqa: E402

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s mg-signoff-sweep %(levelname)s %(message)s")


def main() -> int:
    result = maxgleam_portal.auto_approve()
    logging.info("result %s", result)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
