"""Minimal, dependency-free PDF writer.

The platform runs on the Python standard library only (no reportlab, no
wkhtmltopdf), so this builds a single-page PDF by hand: a content stream of
text and line operators wrapped in the handful of objects a valid PDF needs
(catalog, pages, page, contents, two fonts). Enough for an invoice — text in
Helvetica / Helvetica-Bold, horizontal rules and flat colour — and no more.

Coordinates are given from the TOP-left in points (1/72"), which is how a
document is naturally laid out; they are flipped to PDF's bottom-left origin
on the way out. A4 is 595.28 x 841.89 pt.
"""
from __future__ import annotations

A4 = (595.28, 841.89)

# Adobe Helvetica glyph widths in 1/1000 em, for the printable Latin-1 range
# an invoice actually uses. Exact widths matter because currency columns are
# right-aligned — a flat average would visibly stagger the pounds column.
_W: dict[int, int] = {}


def _wset(chars: str, w: int) -> None:
    for c in chars:
        _W[ord(c)] = w


_wset(" !I|.,:;'ijl", 278)                      # narrow
_W[ord("'")] = 191
_W[ord("i")] = 222; _W[ord("j")] = 222; _W[ord("l")] = 222
_W[ord("|")] = 260
_wset("ftr()[]{}/\\", 300)
_W[ord("f")] = 278; _W[ord("t")] = 278; _W[ord("r")] = 333
_W[ord("(")] = 333; _W[ord(")")] = 333; _W[ord("/")] = 278; _W[ord("\\")] = 278
_wset("0123456789$#?LceghknopqsuvxyzabdEFTZ", 556)   # digits, £, most lower
_W[ord("c")] = 500; _W[ord("e")] = 556; _W[ord("g")] = 556; _W[ord("k")] = 500
_W[ord("s")] = 500; _W[ord("v")] = 500; _W[ord("x")] = 500; _W[ord("y")] = 500
_W[ord("z")] = 500; _W[ord("a")] = 556; _W[ord("L")] = 556
_W[0xA3] = 556                                   # £
_wset("ABEKPSVXY", 667)
_W[ord("C")] = 722; _W[ord("D")] = 722; _W[ord("H")] = 722; _W[ord("N")] = 722
_W[ord("R")] = 722; _W[ord("U")] = 722
_W[ord("G")] = 778; _W[ord("O")] = 778; _W[ord("Q")] = 778
_W[ord("F")] = 611; _W[ord("T")] = 611; _W[ord("Z")] = 611; _W[ord("J")] = 500
_W[ord("M")] = 833; _W[ord("W")] = 944; _W[ord("m")] = 833; _W[ord("w")] = 722
_W[ord("-")] = 333; _W[ord("+")] = 584; _W[ord("=")] = 584
_W[ord("@")] = 1015; _W[ord("%")] = 889; _W[ord("&")] = 667
_W[ord("d")] = 556; _W[ord("h")] = 556; _W[ord("n")] = 556; _W[ord("o")] = 556
_W[ord("p")] = 556; _W[ord("q")] = 556; _W[ord("b")] = 556; _W[ord("u")] = 556


def _esc(s: str) -> bytes:
    # Map to WinAnsi/Latin-1; anything outside it (smart quotes, em dash…)
    # degrades to '?' rather than corrupting the byte stream.
    out = s.encode("latin-1", "replace")
    return out.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


class Pdf:
    """A single-page PDF. Draw with top-left coordinates, then call build()."""

    def __init__(self, size: tuple[float, float] = A4):
        self.w, self.h = size
        self._ops: list[bytes] = []

    # -- measurement --
    def text_width(self, s: str, size: float = 10.0) -> float:
        return sum(_W.get(ord(c), 556) for c in s) / 1000.0 * size

    # -- drawing (all coordinates from the top-left) --
    def _color(self, gray, rgb, fill: bool) -> bytes:
        if rgb is not None:
            r, g, b = rgb
            return f"{r:.3f} {g:.3f} {b:.3f} {'rg' if fill else 'RG'}".encode()
        g = 0.0 if gray is None else gray
        return f"{g:.3f} {'g' if fill else 'G'}".encode()

    def text(self, x, y, s, size=10.0, bold=False, gray=None, rgb=None):
        s = "" if s is None else str(s)
        self._ops += [
            b"BT",
            self._color(gray, rgb, fill=True),
            f"/{'F2' if bold else 'F1'} {size:.2f} Tf".encode(),
            f"1 0 0 1 {x:.2f} {self.h - y:.2f} Tm".encode(),
            b"(" + _esc(s) + b") Tj",
            b"ET",
        ]

    def text_right(self, x_right, y, s, size=10.0, bold=False, gray=None, rgb=None):
        s = "" if s is None else str(s)
        self.text(x_right - self.text_width(s, size), y, s, size, bold, gray, rgb)

    def line(self, x1, y1, x2, y2, width=0.75, gray=None, rgb=None):
        self._ops += [
            self._color(gray, rgb, fill=False),
            f"{width:.2f} w".encode(),
            f"{x1:.2f} {self.h - y1:.2f} m {x2:.2f} {self.h - y2:.2f} l S".encode(),
        ]

    # -- output --
    def build(self) -> bytes:
        # The EOL between the data and `endstream` is a separator, per the PDF
        # spec, and is not counted in /Length — so join without a trailing one.
        stream = b"\n".join(self._ops)
        objs = [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {self.w:.2f} {self.h:.2f}] "
             f"/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>").encode(),
            b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
        ]
        out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets: list[int] = []
        for i, o in enumerate(objs, start=1):
            offsets.append(len(out))
            out += f"{i} 0 obj\n".encode() + o + b"\nendobj\n"
        xref_pos = len(out)
        n = len(objs) + 1
        out += f"xref\n0 {n}\n".encode()
        out += b"0000000000 65535 f \n"
        for off in offsets:
            out += f"{off:010d} 00000 n \n".encode()
        out += (f"trailer\n<< /Size {n} /Root 1 0 R >>\n"
                f"startxref\n{xref_pos}\n%%EOF\n").encode()
        return bytes(out)
