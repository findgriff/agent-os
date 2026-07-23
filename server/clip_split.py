"""Clip Split — FFmpeg stream-copy split for the AGENT OS video editor.

Cut a video at a given timestamp into two independent clips (fast, no re-encode).
"""
from __future__ import annotations
import json
import logging
import re
import subprocess
import uuid
from pathlib import Path

log = logging.getLogger("agentos.video")

_SAFE_SESSION = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
_SAFE_NAME = re.compile(r"^[a-zA-Z0-9_.-]{1,255}$")
VIDEOS_DIR = Path("/var/lib/agent-os/videos")


def _safe_session(sid: str) -> str:
    if not _SAFE_SESSION.match(sid): raise ValueError(f"invalid session: {sid!r}")
    return sid


def _safe_name(name: str) -> str:
    if not _SAFE_NAME.match(name): raise ValueError(f"invalid name: {name!r}")
    return name


def _video_path(session_id: str, filename: str) -> Path:
    folder = (VIDEOS_DIR / _safe_session(session_id)).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    path = (folder / _safe_name(filename)).resolve()
    if not str(path).startswith(str(folder)):
        raise ValueError("path traversal")
    return path


def _served_path(session_id: str, filename: str) -> str:
    return f"/generated/videos/{_safe_session(session_id)}/{_safe_name(filename)}"


def _run(cmd: list[str], timeout: int = 120) -> subprocess.CompletedProcess:
    log.info("ffmpeg: %s", " ".join(str(c) for c in cmd[:8]))
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def _probe_info(path: Path) -> dict:
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_format", "-show_streams", str(path)],
            capture_output=True, text=True, timeout=30,
        )
        data = json.loads(r.stdout)
        dur = float(data.get("format", {}).get("duration", 0))
        return {"duration": dur}
    except Exception:
        return {"duration": 0.0}


def split_clip(config: dict) -> dict:
    """Split a video clip at a given timestamp into two separate clips.

    Config keys: session_id, source (filename), at (seconds to split at)
    """
    session_id = config.get("session_id", "default")
    source = config.get("source", "")
    at = float(config.get("at", 0))

    src_name = source.split("/")[-1]
    src_path = _video_path(session_id, src_name)
    if not src_path.exists():
        return {"error": f"source not found: {src_path}"}

    # Get duration
    info = _probe_info(src_path)
    duration = info.get("duration", 0)
    if duration <= 0:
        return {"error": "could not determine video duration"}

    if at <= 0 or at >= duration:
        return {"error": f"split point must be between 0 and {duration}s"}

    uid = uuid.uuid4().hex[:8]
    out_a_name = f"split_a_{uid}_{src_name}"
    out_b_name = f"split_b_{uid}_{src_name}"
    out_a_path = _video_path(session_id, out_a_name)
    out_b_path = _video_path(session_id, out_b_name)

    # Part A: 0 to at
    try:
        _run([
            "ffmpeg", "-y", "-i", str(src_path),
            "-c", "copy", "-t", str(at), str(out_a_path),
        ], timeout=60)
    except subprocess.TimeoutExpired:
        return {"error": "split (part A) timed out"}
    except Exception as e:
        log.error("split A failed: %s", e)
        return {"error": str(e)}

    # Part B: at to end
    try:
        _run([
            "ffmpeg", "-y", "-i", str(src_path),
            "-c", "copy", "-ss", str(at), str(out_b_path),
        ], timeout=60)
    except subprocess.TimeoutExpired:
        return {"error": "split (part B) timed out"}
    except Exception as e:
        log.error("split B failed: %s", e)
        # Clean up part A
        try: out_a_path.unlink()
        except OSError: pass
        return {"error": str(e)}

    dur_a = _probe_info(out_a_path).get("duration", at)
    dur_b = _probe_info(out_b_path).get("duration", duration - at)

    return {
        "ok": True,
        "clip_a": {"path": _served_path(session_id, out_a_name), "duration": dur_a},
        "clip_b": {"path": _served_path(session_id, out_b_name), "duration": dur_b},
    }
