"""Every backend module must byte-compile. This is the cheapest guard against
a syntax error or a stray merge marker slipping into a deploy — the exact
class of breakage a vite build can hide on the frontend but which would take
the whole Python server down."""
import glob
import os
import py_compile

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_MODULES = sorted(glob.glob(os.path.join(REPO_ROOT, "server", "*.py")))


@pytest.mark.parametrize("path", _MODULES,
                         ids=[os.path.basename(p) for p in _MODULES])
def test_module_compiles(path):
    py_compile.compile(path, doraise=True)


def test_found_modules():
    # Guard against the glob silently matching nothing (which would make the
    # parametrized test vacuously pass).
    assert len(_MODULES) > 10, f"expected many server modules, found {_MODULES}"
