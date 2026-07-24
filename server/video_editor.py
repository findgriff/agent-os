"""Video Editor — FFmpeg-powered video processing for AGENT OS.

Upload, trim, merge, caption burn-in, and export videos. All outputs
live under /var/lib/agent-os/videos/ and are served at /generated/videos/.
"""
from __future__ import annotations
import json
import logging
import re
import subprocess
import time
import uuid
from pathlib import Path

log = logging.getLogger("agentos.video")

VIDEOS_DIR = Path("/var/lib/agent-os/videos")

# Security: strict session/filename allowlists
_SAFE_SESSION = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
_SAFE_NAME = re.compile(r"^[a-zA-Z0-9_.-]{1,255}$")
# Time format: seconds (float) or HH:MM:SS
_TIME_PAT = re.compile(r"^\d+(\.\d+)?$|^\d{1,2}:\d{2}:\d{2}$")
# Caption position allowlist
_VALID_POSITIONS = {"top", "middle", "bottom"}
_VALID_COLORS = re.compile(r"^#[0-9a-fA-F]{6}$")


def _safe_session(sid: str) -> str:
    if not _SAFE_SESSION.match(sid):
        raise ValueError(f"invalid session_id: {sid!r}")
    return sid


def _safe_name(name: str) -> str:
    if not _SAFE_NAME.match(name):
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
    folder = _ensure_session(session_id)
    safe = _safe_name(filename)
    path = (folder / safe).resolve()
    if not str(path).startswith(str(folder)):
        raise ValueError("path traversal")
    return path


def _served_path(session_id: str, filename: str) -> str:
    return f"/generated/videos/{_safe_session(session_id)}/{_safe_name(filename)}"


def _run(cmd: list[str], timeout: int = 120) -> subprocess.CompletedProcess:
    log.info("ffmpeg: %s", " ".join(str(c) for c in cmd[:8]))
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def _escape_drawtext(text: str) -> str:
    """Escape text for FFmpeg's drawtext filter (text=...)."""
    return (text.replace("\\", "\\\\").replace("%", "%%")
            .replace(":", "\\:").replace("'", "\\\\'").replace("\n", "\\n"))


def _validate_time(t: str | float) -> str:
    """Return a string FFmpeg can parse as a time duration."""
    if isinstance(t, (int, float)):
        return str(float(t))
    s = str(t).strip()
    if _TIME_PAT.match(s):
        return s
    raise ValueError(f"invalid time: {t!r}")


# ── API functions ───────────────────────────────────────────────────────────

def upload(config: dict) -> dict:
    """Upload a video file via base64 data in config.

    Config keys: session_id, data (base64), filename, name
    """
    session_id = config.get("session_id") or f"s{int(time.time())}"
    data = config.get("data") or config.get("body", b"")
    name = config.get("filename") or config.get("name", f"clip_{int(time.time())}.mp4")
    if isinstance(data, str):
        import base64
        data = base64.b64decode(data)
    path = _video_path(session_id, name)
    path.write_bytes(data)
    # Probe for duration / dimensions
    info_result = info({"session_id": session_id, "source": name})
    dur = info_result.get("duration", 5.0)
    w = info_result.get("width", 0)
    h = info_result.get("height", 0)
    return {
        "ok": True,
        "path": _served_path(session_id, name),
        "filename": name,
        "session_id": session_id,
        "duration": dur,
        "width": w,
        "height": h,
    }


def trim(config: dict) -> dict:
    """Trim a video clip.

    Config keys: session_id, source (filename), start (seconds), end (seconds)
    """
    session_id = config.get("session_id", "default")
    source = config.get("source", "")
    start = _validate_time(config.get("start", 0))
    end = _validate_time(config.get("end", 0))

    # source may be a full /generated/videos/... path or just a filename
    src_name = source.split("/")[-1]
    src_path = _video_path(session_id, src_name)
    if not src_path.exists():
        return {"error": f"source not found: {src_path}"}

    out_name = f"trim_{uuid.uuid4().hex[:8]}_{src_name}"
    out_path = _video_path(session_id, out_name)

    try:
        _run([
            "ffmpeg", "-y", "-i", str(src_path),
            "-ss", str(start), "-to", str(end),
            "-c", "copy", str(out_path),
        ], timeout=60)
    except subprocess.TimeoutExpired:
        return {"error": "trim timed out"}
    except Exception as e:
        log.error("trim failed: %s", e)
        return {"error": str(e)}

    # Get duration of trimmed clip
    d = _probe_duration(out_path)
    return {
        "ok": True,
        "path": _served_path(session_id, out_name),
        "duration": d,
    }


def merge(config: dict) -> dict:
    """Merge multiple video clips.

    Config keys: session_id, clips (list of {source, start?, end?})
    """
    session_id = config.get("session_id", "default")
    clips = config.get("clips", [])
    if not clips:
        return {"error": "no clips provided"}

    out_name = f"merge_{uuid.uuid4().hex[:8]}.mp4"
    out_path = _video_path(session_id, out_name)

    # Prepare individual trimmed clips
    part_paths: list[Path] = []
    concat_lines: list[str] = []
    try:
        for i, clip_spec in enumerate(clips):
            src = clip_spec.get("source", "")
            src_name = src.split("/")[-1]
            src_path = _video_path(session_id, src_name)
            if not src_path.exists():
                return {"error": f"source not found: {src_path}"}

            part_name = f"part_{i}_{uuid.uuid4().hex[:8]}_{src_name}"
            part_path = _video_path(session_id, part_name)

            start = clip_spec.get("start")
            end = clip_spec.get("end")
            if start is not None or end is not None:
                cmd = ["ffmpeg", "-y", "-i", str(src_path)]
                if start is not None:
                    cmd.extend(["-ss", _validate_time(start)])
                if end is not None:
                    cmd.extend(["-to", _validate_time(end)])
                cmd.extend(["-c", "copy", str(part_path)])
                try:
                    _run(cmd, timeout=60)
                except subprocess.TimeoutExpired:
                    return {"error": f"trim of clip {i} timed out"}
                part_paths.append(part_path)
                # Escape single quotes for concat demuxer
                escaped = str(part_path).replace("'", "'\\''")
                concat_lines.append(f"file '{escaped}'")
            else:
                escaped = str(src_path).replace("'", "'\\''")
                concat_lines.append(f"file '{escaped}'")

        if not concat_lines:
            return {"error": "no valid clips to merge"}

        # Write concat file
        concat_file = _video_path(session_id, f"concat_{uuid.uuid4().hex[:8]}.txt")
        concat_file.write_text("\n".join(concat_lines) + "\n")

        # Run concat
        try:
            _run([
                "ffmpeg", "-y", "-f", "concat", "-safe", "0",
                "-i", str(concat_file), "-c", "copy", str(out_path),
            ], timeout=300)
        except subprocess.TimeoutExpired:
            return {"error": "merge timed out"}

        # Cleanup concat file
        try:
            concat_file.unlink()
        except OSError:
            pass

    except Exception as e:
        log.error("merge failed: %s", e)
        return {"error": str(e)}
    finally:
        # Cleanup temp parts
        for p in part_paths:
            try:
                p.unlink()
            except OSError:
                pass

    d = _probe_duration(out_path)
    return {
        "ok": True,
        "path": _served_path(session_id, out_name),
        "duration": d,
    }


def render_captions(config: dict) -> dict:
    """Burn captions into a video using FFmpeg drawtext.

    Config keys: session_id, source (filename), captions (list of
    {start, end, text, position, fontSize, color})
    """
    session_id = config.get("session_id", "default")
    source = config.get("source", "")
    captions = config.get("captions", [])
    if not captions:
        return {"error": "no captions provided"}

    src_name = source.split("/")[-1]
    src_path = _video_path(session_id, src_name)
    if not src_path.exists():
        return {"error": f"source not found: {src_path}"}

    out_name = f"captioned_{uuid.uuid4().hex[:8]}_{src_name}"
    out_path = _video_path(session_id, out_name)

    # Build drawtext filters for each caption
    filter_parts: list[str] = []
    for cap in captions:
        text = _escape_drawtext(str(cap.get("text", "")))
        start = float(cap.get("start", 0))
        end = float(cap.get("end", 2))
        pos = str(cap.get("position", "bottom"))
        if pos not in _VALID_POSITIONS:
            pos = "bottom"
        fs = max(12, min(72, int(cap.get("fontSize", 24))))
        colour = str(cap.get("color", "#FFFFFF"))
        if not _VALID_COLORS.match(colour):
            colour = "#FFFFFF"

        # Position logic
        y_expr = {
            "top": "h-th-50",
            "middle": "(h-th)/2",
            "bottom": "h-th-50",
        }[pos]

        filter_parts.append(
            f"drawtext=text='{text}':fontsize={fs}:fontcolor={colour}"
            f":x=(w-text_w)/2:y={y_expr}"
            f":enable='between(t,{start},{end})'"
        )

    if not filter_parts:
        return {"error": "no valid caption filters"}

    # Combine filters with comma (applied sequentially)
    vf = ",".join(filter_parts)
    try:
        _run([
            "ffmpeg", "-y", "-i", str(src_path),
            "-vf", vf, "-c:a", "aac", "-b:a", "128k",
            "-c:v", "libx264", "-preset", "fast", "-crf", "22",
            str(out_path),
        ], timeout=300)
    except subprocess.TimeoutExpired:
        return {"error": "render timed out"}
    except Exception as e:
        log.error("render failed: %s", e)
        return {"error": str(e)}

    d = _probe_duration(out_path)
    return {
        "ok": True,
        "path": _served_path(session_id, out_name),
        "duration": d,
    }


def info(config: dict) -> dict:
    """Get video metadata via ffprobe.

    Config keys: session_id, source (filename)
    """
    session_id = config.get("session_id", "default")
    source = config.get("source", "")
    src_name = source.split("/")[-1]
    src_path = _video_path(session_id, src_name)
    if not src_path.exists():
        return {"error": f"source not found: {src_path}"}

    return _probe_info(src_path)


def export(config: dict) -> dict:
    """Export video in requested format.

    Config keys: session_id, source, format ('mp4' default)
    """
    session_id = config.get("session_id", "default")
    source = config.get("source", "")
    fmt = config.get("format", "mp4")
    src_name = source.split("/")[-1]
    src_path = _video_path(session_id, src_name)
    if not src_path.exists():
        return {"error": f"source not found: {src_path}"}

    out_name = f"export_{uuid.uuid4().hex[:8]}.{fmt}"
    out_path = _video_path(session_id, out_name)

    try:
        _run([
            "ffmpeg", "-y", "-i", str(src_path),
            "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-c:a", "aac", "-b:a", "128k",
            str(out_path),
        ], timeout=300)
    except subprocess.TimeoutExpired:
        return {"error": "export timed out"}
    except Exception as e:
        log.error("export failed: %s", e)
        return {"error": str(e)}

    d = _probe_duration(out_path)
    return {
        "ok": True,
        "path": _served_path(session_id, out_name),
        "duration": d,
    }


# ── FFprobe helpers ─────────────────────────────────────────────────────────

def _probe_duration(path: Path) -> float:
    """Return duration in seconds, or 0 on failure."""
    info = _probe_info(path)
    return info.get("duration", 0.0)


def _probe_info(path: Path) -> dict:
    """Return dict with duration, width, height, codec from ffprobe."""
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
    dur = float(fmt.get("duration", 0))
    width = height = 0
    for s in data.get("streams", []):
        if s.get("codec_type") == "video":
            width = s.get("width", 0)
            height = s.get("height", 0)
            break
    return {"duration": dur, "width": width, "height": height,
            "format": fmt.get("format_name", ""),
            "size": int(fmt.get("size", 0))}
