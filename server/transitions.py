"""Transitions — FFmpeg xfade/fade transitions for the AGENT OS video editor.

Adds transitions between clips (xfade) and fade-in/out on a single clip
(fade filter). Outputs live under /var/lib/agent-os/videos/<session>/ and are
served at /generated/videos/. Everything soft-fails to an {error} dict rather
than raising, matching video_editor.py's contract, and every path is validated
against the session folder before it reaches FFmpeg.
"""
from __future__ import annotations
import json
import logging
import subprocess
import uuid
from pathlib import Path

log = logging.getLogger("agentos.transitions")

VIDEOS_DIR = Path("/var/lib/agent-os/videos")

# Security: strict session/filename allowlists (mirror video_editor.py).
import re
_SAFE_SESSION = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
_SAFE_NAME = re.compile(r"^[a-zA-Z0-9_.-]{1,255}$")

DEFAULT_DURATION = 0.5

# ui transition name → native FFmpeg xfade transition. 'crossfade' has no native
# xfade equivalent, so it maps to the plain alpha 'fade'.
_XFADE_MAP = {
    "fade": "fade",
    "crossfade": "fade",
    "dissolve": "dissolve",
    "slideleft": "slideleft",
    "slideright": "slideright",
    "slideup": "slideup",
    "slidedown": "slidedown",
    "wipeleft": "wipeleft",
    "wiperight": "wiperight",
    "fadeblack": "fadeblack",
    "fadewhite": "fadewhite",
}

_VALID_FADE_COLORS = {"black", "white"}


# ── Path safety ──────────────────────────────────────────────────────────────

def _safe_session(sid: str) -> str:
    if not _SAFE_SESSION.match(sid or ""):
        raise ValueError(f"invalid session_id: {sid!r}")
    return sid


def _safe_name(name: str) -> str:
    if not _SAFE_NAME.match(name or ""):
        raise ValueError(f"invalid filename: {name!r}")
    return name


def _ensure_session(session_id: str) -> Path:
    sid = _safe_session(session_id)
    folder = (VIDEOS_DIR / sid).resolve()
    if not str(folder).startswith(str(VIDEOS_DIR.resolve())):
        raise ValueError("path traversal")
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _video_path(session_id: str, filename: str) -> Path:
    """Resolve <videos>/<session>/<filename>, rejecting traversal."""
    folder = _ensure_session(session_id)
    safe = _safe_name(filename)
    path = (folder / safe).resolve()
    if not str(path).startswith(str(folder)):
        raise ValueError("path traversal")
    return path


def _served_path(session_id: str, filename: str) -> str:
    return f"/generated/videos/{_safe_session(session_id)}/{_safe_name(filename)}"


# ── FFmpeg / ffprobe helpers ─────────────────────────────────────────────────

def _run(cmd: list[str], timeout: int = 300) -> subprocess.CompletedProcess:
    log.info("ffmpeg: %s", " ".join(str(c) for c in cmd[:8]))
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or "ffmpeg failed").strip()[-500:])
    return r


def _probe_info(path: Path) -> dict:
    """Return {duration, width, height, has_audio} via ffprobe (empty on fail)."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_format", "-show_streams", str(path)],
            capture_output=True, text=True, timeout=30,
        )
        data = json.loads(r.stdout)
    except Exception:
        return {}
    fmt = data.get("format", {})
    try:
        dur = float(fmt.get("duration", 0))
    except (TypeError, ValueError):
        dur = 0.0
    width = height = 0
    has_audio = False
    for s in data.get("streams", []):
        kind = s.get("codec_type")
        if kind == "video" and not width:
            width = s.get("width", 0)
            height = s.get("height", 0)
        elif kind == "audio":
            has_audio = True
    return {"duration": dur, "width": width, "height": height,
            "has_audio": has_audio}


def _probe_duration(path: Path) -> float:
    return _probe_info(path).get("duration", 0.0)


def _resolve_source(session_id: str, source: str) -> Path:
    """Accept either a bare filename or a /generated/videos/... path."""
    src_name = str(source).split("/")[-1]
    return _video_path(session_id, src_name)


def _prepare_clip(session_id: str, clip_spec: dict, tmp: list[Path]) -> Path:
    """Return a path to the clip, trimmed to [start, end] if requested.

    Trimmed clips are written to a temp file (tracked in `tmp` for cleanup)
    and re-encoded so downstream xfade sees uniform timestamps.
    """
    src = clip_spec.get("source", "")
    src_path = _resolve_source(session_id, src)
    if not src_path.exists():
        raise FileNotFoundError(f"source not found: {src_path.name}")

    start = clip_spec.get("start")
    end = clip_spec.get("end")
    if start is None and end is None:
        return src_path

    part = _video_path(session_id, f"xfpart_{uuid.uuid4().hex[:8]}.mp4")
    tmp.append(part)
    cmd = ["ffmpeg", "-y", "-i", str(src_path)]
    if start is not None:
        cmd += ["-ss", str(float(start))]
    if end is not None:
        cmd += ["-to", str(float(end))]
    cmd += ["-c:v", "libx264", "-preset", "fast", "-crf", "20",
            "-c:a", "aac", "-b:a", "128k", str(part)]
    _run(cmd, timeout=120)
    return part


def _xfade_pair(a: Path, b: Path, out: Path, transition: str,
                duration: float) -> None:
    """xfade clip `a` into clip `b`, writing `out`.

    offset = duration(a) - transition duration, clamped so the transition
    always fits inside the first clip.
    """
    dur_a = _probe_duration(a)
    offset = max(0.0, dur_a - duration)
    info_a = _probe_info(a)
    info_b = _probe_info(b)
    both_audio = info_a.get("has_audio") and info_b.get("has_audio")

    if both_audio:
        fc = (f"[0:v][1:v]xfade=transition={transition}:duration={duration}"
              f":offset={offset}[v];"
              f"[0:a][1:a]acrossfade=d={duration}[a]")
        maps = ["-map", "[v]", "-map", "[a]"]
    else:
        fc = (f"[0:v][1:v]xfade=transition={transition}:duration={duration}"
              f":offset={offset}[v]")
        maps = ["-map", "[v]"]

    cmd = ["ffmpeg", "-y", "-i", str(a), "-i", str(b),
           "-filter_complex", fc, *maps,
           "-c:v", "libx264", "-preset", "fast", "-crf", "20"]
    if both_audio:
        cmd += ["-c:a", "aac", "-b:a", "128k"]
    cmd += [str(out)]
    _run(cmd, timeout=300)


# ── API functions ────────────────────────────────────────────────────────────

def apply_transition(config: dict) -> dict:
    """Apply a transition between two (or more) clips using FFmpeg xfade.

    Config keys: session_id, clips (list of {source, start?, end?}),
    transition, duration (default 0.5). For >2 clips the transition is
    chained pairwise across the sequence.
    """
    tmp: list[Path] = []
    try:
        session_id = config.get("session_id", "default")
        _safe_session(session_id)
        clips = config.get("clips") or []
        if len(clips) < 2:
            return {"error": "at least two clips are required"}

        name = str(config.get("transition", "fade"))
        transition = _XFADE_MAP.get(name)
        if transition is None:
            return {"error": f"unknown transition: {name!r}"}

        try:
            duration = float(config.get("duration", DEFAULT_DURATION))
        except (TypeError, ValueError):
            duration = DEFAULT_DURATION
        if duration <= 0:
            duration = DEFAULT_DURATION

        # Prepare (optionally trim) every clip up front.
        prepared = [_prepare_clip(session_id, c, tmp) for c in clips]

        # Chain xfade pairwise: acc = xfade(acc, next).
        acc = prepared[0]
        for nxt in prepared[1:]:
            step = _video_path(session_id, f"xfstep_{uuid.uuid4().hex[:8]}.mp4")
            _xfade_pair(acc, nxt, step, transition, duration)
            tmp.append(step)
            acc = step

        # Promote the final step to a stable output name.
        out_name = f"transition_{uuid.uuid4().hex[:8]}.mp4"
        out_path = _video_path(session_id, out_name)
        acc.replace(out_path)
        if acc in tmp:
            tmp.remove(acc)

        return {
            "ok": True,
            "path": _served_path(session_id, out_name),
            "duration": _probe_duration(out_path),
        }
    except (ValueError, FileNotFoundError) as e:
        return {"error": str(e)}
    except subprocess.TimeoutExpired:
        return {"error": "transition timed out"}
    except Exception as e:
        log.error("apply_transition failed: %s", e)
        return {"error": str(e)}
    finally:
        for p in tmp:
            try:
                p.unlink()
            except OSError:
                pass


def apply_fade(config: dict) -> dict:
    """Apply fade-in and/or fade-out to a single clip using FFmpeg fade.

    Config keys: session_id, source, fade_in (s, default 0),
    fade_out (s, default 0), color ('black'|'white', default 'black').
    """
    out_path: Path | None = None
    try:
        session_id = config.get("session_id", "default")
        _safe_session(session_id)
        source = config.get("source", "")
        src_path = _resolve_source(session_id, source)
        if not src_path.exists():
            return {"error": f"source not found: {src_path.name}"}

        try:
            fade_in = max(0.0, float(config.get("fade_in", 0) or 0))
            fade_out = max(0.0, float(config.get("fade_out", 0) or 0))
        except (TypeError, ValueError):
            return {"error": "fade_in/fade_out must be numbers"}
        if fade_in == 0 and fade_out == 0:
            return {"error": "nothing to do: set fade_in and/or fade_out"}

        color = str(config.get("color", "black")).lower()
        if color not in _VALID_FADE_COLORS:
            color = "black"

        info = _probe_info(src_path)
        total = info.get("duration", 0.0)
        has_audio = info.get("has_audio", False)

        parts: list[str] = []
        if fade_in > 0:
            parts.append(f"fade=t=in:st=0:d={fade_in}:color={color}")
        if fade_out > 0:
            # Fade-out starts `fade_out` seconds before the end.
            st = max(0.0, total - fade_out) if total else 0.0
            parts.append(f"fade=t=out:st={st}:d={fade_out}:color={color}")
        vf = ",".join(parts)

        out_name = f"fade_{uuid.uuid4().hex[:8]}.mp4"
        out_path = _video_path(session_id, out_name)

        cmd = ["ffmpeg", "-y", "-i", str(src_path), "-vf", vf,
               "-c:v", "libx264", "-preset", "fast", "-crf", "20"]
        cmd += ["-c:a", "aac", "-b:a", "128k"] if has_audio else ["-an"]
        cmd += [str(out_path)]
        _run(cmd, timeout=300)

        return {
            "ok": True,
            "path": _served_path(session_id, out_name),
            "duration": _probe_duration(out_path),
        }
    except (ValueError, FileNotFoundError) as e:
        return {"error": str(e)}
    except subprocess.TimeoutExpired:
        # Drop a half-written output on timeout.
        if out_path is not None:
            try:
                out_path.unlink()
            except OSError:
                pass
        return {"error": "fade timed out"}
    except Exception as e:
        log.error("apply_fade failed: %s", e)
        return {"error": str(e)}
