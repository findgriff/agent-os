# AGENT OS

Standalone autonomous AI command centre — one HQ serving every business
(tenant) from a single database. Replaces the agent system that was
embedded inside the Max Gleam SPA.

## Run

```bash
cd /opt/agent-os
./run.sh                 # API + SPA on http://0.0.0.0:8100
```

Dev (hot-reload SPA against the API):

```bash
npm install
npm run dev              # Vite on :5273, proxies /api → :8100
python3 -m server.app    # API on :8100 (separate terminal)
```

Build the SPA into `site/`:

```bash
npm run build            # outputs to site/ (served by the Python server)
```

## Environment

| var | default | purpose |
|-----|---------|---------|
| `AGENTOS_PORT` | `8100` | HTTP port |
| `AGENTOS_DB` | `/var/lib/agent-os/data.db` | SQLite database |
| `AGENTOS_SITE` | `./site` | built SPA directory |
| `MAXGLEAM_DB` | `/var/lib/maxgleam/app.db` | source for copied owner users |

LLM keys (env → `/etc/agent-os/<provider>-api-key` → hermes vault):
`DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, `MOONSHOT_API_KEY`.
Bridge keys may also be stored per-connection in the Integrations UI.

## Architecture

- **server/** — stdlib `http.server` (`ThreadingHTTPServer`), no web framework.
  - `app.py` routes/auth/CORS/static + first-boot bootstrap (seeds tenants,
    copies maxgleam owner users, seeds the 18-agent roster per tenant).
  - `agents.py` roster + manual-run generation + inter-agent inbox + memory.
  - `inference.py` DeepSeek / Claude / Kimi wrapper (soft-fails to None).
  - `vault.py` Obsidian vault ⇄ SQLite memory sync + galaxy graph (wikilinks).
  - `bridges.py` Hermes / ChatGPT / Fal.ai / Claude SDK / Kimi connectors.
  - `metrics.py` token + cost aggregation. `db.py` / `schema.sql` storage.
- **SPA** — Vite + React + TS + Tailwind. Three.js is loaded from CDN
  (`window.THREE`) for the Memory Galaxy — no npm 3D dependency.
- The Obsidian vault lives at `~/.superbrain/vault/memories/`; every agent
  learning is written both as a `.md` note and an `agent_memory` row.

## Verified

`npx tsc --noEmit` clean · `npm run build` clean · server serves SPA +
client-route fallback + assets + CORS · every page endpoint returns 200 ·
real DeepSeek generation + token/cost tracking · memory → vault → galaxy
pipeline · bridge connection test. A live browser render was not exercised
(no headless browser in the build environment); the galaxy and web fonts
require the browser to reach their CDNs at runtime.
