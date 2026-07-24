#!/usr/bin/env bash
# AGENT OS smoke test suite.
#
# pytest is kept OUT of the stdlib-only runtime: it lives in an isolated
# .venv-test created on first run. The tests boot the app in-process against a
# throwaway SQLite DB in /tmp — the live database and the :8100 service are
# never touched.
#
# Usage:  ./run_tests.sh              # run everything
#         ./run_tests.sh -k endpoint  # pass any pytest args through
set -euo pipefail
cd "$(dirname "$0")"

VENV=".venv-test"
if [ ! -x "$VENV/bin/pytest" ]; then
  echo "→ first run: creating $VENV with pytest (runtime stays stdlib-only)…"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q pytest
fi

exec "$VENV/bin/pytest" "$@"
