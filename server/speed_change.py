"""Speed Change — FFmpeg setpts/atempo for the AGENT OS video editor.

Change playback speed of a video clip. Supports 0.25x to 4.0x.
"""
from __future__ import annotations
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


def _probe_duration(path: Path) -> float:
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_format", "-show_streams", str(path)],
            capture_output=True, text=True, timeout=30,
        )
        import json
        data = json.loads(r.stdout)
        return float(data.get("format", {}).get("duration", 0))
    except Exception:
        return 0.0


def change_speed(config: dict) -> dict:
    """Change playback speed of a video clip.

    Config keys: session_id, source (filename), speed (0.25-4.0)
    """
    session_id = config.get("session_id", "default")
    source = config.get("source", "")
    speed = float(config.get("speed", 1.0))

    if speed < 0.25 or speed > 4.0:
        return {"error": "speed must be between 0.25 and 4.0"}

    src_name = source.split("/")[-1]
    src_path = _video_path(session_id, src_name)
    if not src_path.exists():
        return {"error": f"source not found: {src_path}"}

    out_name = f"speed_{uuid.uuid4().hex[:8]}_{src_name}"
    out_path = _video_path(session_id, out_name)

    # setpts for video
    setpts_factor = 1.0 / speed
    vf = f"setpts={setpts_factor}*PTS"

    # atempo for audio (supports 0.5-2.0, chain for higher/lower)
    atempo_filters = []
    remaining = speed
    while remaining > 2.0:
        atempo_filters.append("atempo=2.0")
        remaining /= 2.0
    while remaining < 0.5:
        atempo_filters.append("atempo=0.5")
        remaining /= 0.5
    atempo_filters.append(f"atempo={remaining}")

    af = ",".join(atempo_filters)

    cmd = [
        "ffmpeg", "-y", "-i", str(src_path),
        "-filter_complex", f"[0:v]{vf}[v];[0:a]{af}[a]",
        "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "fast",
        "-c:a", "aac", "-b:a", "128k", str(out_path),
    ]

    try:
        _run(cmd, timeout=300)
    except subprocess.TimeoutExpired:
        return {"error": "speed change timed out"}
    except Exception as e:
        log.error("speed change failed: %s", e)
        return {"error": str(e)}

    dur = _probe_duration(out_path)
    return {
        "ok": True,
        "path": _served_path(session_id, out_name),
        "duration": dur,
    }
