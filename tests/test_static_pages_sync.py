"""The standalone static pages in `public/*.html` (mg-tracking, ops-board,
brand, the apollo mockups) are copied VERBATIM into `site/` by the vite build —
they are not React-rendered, so nothing regenerates them except that copy.

That makes them easy to get wrong: editing the built `site/<page>.html` directly
(instead of the `public/` source) looks fine until the next `npm run build`
silently reverts it. That is exactly how the mg-tracking iOS-zoom fix (16px vs
13px) regressed — the fix landed in `site/mg-tracking.html` but not in
`public/mg-tracking.html`, so a rebuild would have quietly undone it.

This test makes that divergence a red build instead of a silent revert: for every
`public/*.html`, the committed `site/` copy must be byte-identical. If it fails,
edit the `public/` source and rebuild — never hand-edit the `site/` copy."""
import glob
import os

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_PUBLIC_HTML = sorted(glob.glob(os.path.join(REPO_ROOT, "public", "*.html")))


@pytest.mark.parametrize("public_path", _PUBLIC_HTML,
                         ids=[os.path.basename(p) for p in _PUBLIC_HTML])
def test_built_copy_matches_source(public_path):
    name = os.path.basename(public_path)
    site_path = os.path.join(REPO_ROOT, "site", name)
    assert os.path.exists(site_path), (
        f"site/{name} is missing — run `npm run build` to copy it from public/"
    )
    with open(public_path, "rb") as f:
        source = f.read()
    with open(site_path, "rb") as f:
        built = f.read()
    assert source == built, (
        f"site/{name} differs from public/{name}. The built copy was edited "
        f"directly (or is stale); a rebuild would revert it. Fix the source in "
        f"public/{name} and run `npm run build`."
    )


def test_found_public_pages():
    # Guard against the glob silently matching nothing (which would make the
    # parametrized test vacuously pass if public/ moved or emptied).
    assert len(_PUBLIC_HTML) >= 3, (
        f"expected several public/*.html pages, found {_PUBLIC_HTML}"
    )
