#!/usr/bin/env bash
# Start the AGENT OS server. Serves the built SPA from site/ and the API
# on port 8100. Override with AGENTOS_PORT / AGENTOS_DB / AGENTOS_SITE.
set -euo pipefail
cd "$(dirname "$0")"

export AGENTOS_PORT="${AGENTOS_PORT:-8100}"
export AGENTOS_DB="${AGENTOS_DB:-/var/lib/agent-os/data.db}"
export AGENTOS_SITE="${AGENTOS_SITE:-$(pwd)/site}"

echo "AGENT OS → http://0.0.0.0:${AGENTOS_PORT}  (db=${AGENTOS_DB})"
exec python3 -m server.app
