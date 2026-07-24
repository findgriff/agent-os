"""Import-time smoke: the whole server package must import, the route table
must be well-formed, and every handler must be callable. Catches the failure
mode where a module imports fine alone but the ROUTES table references a
handler that was renamed or deleted."""
import glob
import importlib
import os

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_VALID_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}

_SUBMODULES = sorted(
    os.path.basename(p)[:-3]
    for p in glob.glob(os.path.join(REPO_ROOT, "server", "*.py"))
    if os.path.basename(p) != "__init__.py")


def test_app_imports():
    from server import app
    assert isinstance(app.ROUTES, list)
    assert len(app.ROUTES) > 100, "route table looks truncated"


def test_routes_well_formed():
    from server import app
    for entry in app.ROUTES:
        method, pattern, fn = entry
        assert method in _VALID_METHODS, f"bad method {method}"
        assert hasattr(pattern, "match"), "pattern is not a compiled regex"
        assert callable(fn), f"{method} {pattern.pattern} → handler not callable"


def test_no_duplicate_routes():
    from server import app
    seen = set()
    dupes = []
    for method, pattern, _ in app.ROUTES:
        key = (method, pattern.pattern)
        if key in seen:
            dupes.append(key)
        seen.add(key)
    assert not dupes, f"duplicate route(s): {dupes}"


@pytest.mark.parametrize("mod", _SUBMODULES)
def test_submodule_imports(mod):
    importlib.import_module(f"server.{mod}")
