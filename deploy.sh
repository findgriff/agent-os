#!/usr/bin/env bash
# AGENT OS deploy — gated on the smoke suite.
#
# Order:  smoke tests → build → restart → health check.
# A single test failure aborts BEFORE anything is built or restarted, so a
# syntax error or a broken route can never reach the running service.
#
# Usage:
#   ./deploy.sh                 # test → build → restart → verify
#   ./deploy.sh --skip-tests    # emergency escape hatch (discouraged)
set -euo pipefail
cd "$(dirname "$0")"

SKIP_TESTS=0
[ "${1:-}" = "--skip-tests" ] && SKIP_TESTS=1

if [ "$SKIP_TESTS" -eq 1 ]; then
  echo "▶ 1/4  smoke suite — SKIPPED (--skip-tests)"
else
  echo "▶ 1/4  smoke suite"
  if ! ./run_tests.sh; then
    echo "✖ smoke tests failed — deploy aborted. Nothing was built or restarted." >&2
    exit 1
  fi
fi

echo "▶ 2/4  build (vite)"
npm run build

echo "▶ 3/4  restart agent-os"
sudo systemctl restart agent-os

echo "▶ 4/4  health check"
for _ in $(seq 1 20); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8100/healthz || true)" = "200" ]; then
    echo "✓ healthy (200) — deploy complete."
    exit 0
  fi
  sleep 0.5
done
echo "✖ service did not report healthy after restart." >&2
echo "  inspect: journalctl -u agent-os -n 50 --no-pager" >&2
exit 1
