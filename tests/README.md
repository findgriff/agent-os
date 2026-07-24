# AGENT OS smoke suite

Fast, hermetic sanity checks. **Not** exhaustive unit tests — the goal is to
catch the breakage that actually ships: a syntax error, a route pointing at a
deleted handler, or an endpoint that 500s on an empty database.

## Run

```bash
./run_tests.sh                 # everything
./run_tests.sh -k endpoint     # just the endpoint smoke tests
./run_tests.sh -v              # verbose
```

`run_tests.sh` creates an isolated `.venv-test/` with pytest on first run. The
production runtime stays stdlib-only — pytest never enters it.

## What runs

| File | Checks |
|------|--------|
| `test_compile.py` | every `server/*.py` byte-compiles |
| `test_imports.py` | `server.app` imports, route table well-formed, no duplicate routes, every submodule imports |
| `test_endpoints.py` | in-process server: `/healthz`, 404 routing, auth gate (401), core endpoints return 200, wider sweep returns no 5xx, Hermes chat validation |

## Isolation

`conftest.py` points `AGENTOS_DB` at a throwaway file in a temp dir **before**
importing `server.app`, and starts a `ThreadingHTTPServer` on an ephemeral
port. The live DB (`/var/lib/agent-os/data.db`) and the running service on
`:8100` are never touched. `MAXGLEAM_DB` is pointed at a nonexistent path so
boot stays self-contained.

The Hermes `/api/hermes/chat` endpoint is only exercised on its validation
path (empty message → 400), so the suite never shells out to the real Hermes
CLI.

## Adding tests

Add a new endpoint to `CORE_200` (must be 200) or `NO_5XX` (must not fault) in
`test_endpoints.py`. Use the `client` fixture — `client.get(path)` is
authenticated; pass `token=None` to test the auth gate.
