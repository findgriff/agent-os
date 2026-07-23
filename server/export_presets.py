"""Export Presets — Platform-optimised video export for AGENT OS.

Export videos in Facebook, Instagram, TikTok, YouTube Shorts, and square
formats with proper resolution, aspect ratio, and quality settings.
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

_VALID_PRESETS = {
    "facebook_feed", "facebook_story", "instagram_feed",
    "instagram_story", "instagram_reel", "tiktok",
    "youtube_short", "square",
}
_VALID_QUALITY = {"high", "medium", "fast"}

PRESET_SPECS = {
    "facebook_feed":     {"w": 1280, "h": 720,  "desc": "16:9 Feed"},
    "facebook_story":    {"w": 1080, "h": 1920, "desc": "9:16 Story"},
    "instagram_feed":    {"w": 1080, "h": 1080, "desc": "1:1 Square"},
    "instagram_story":   {"w": 1080, "h": 1920, "desc": "9:16 Story"},
    "instagram_reel":    {"w": 1080, "h": 1920, "desc": "9:16 Reel"},
    "tiktok":            {"w": 1080, "h": 1920, "desc": "9:16 TikTok"},
    "youtube_short":     {"w": 1080, "h": 1920, "desc": "9:15 Short"},
    "square":            {"w": 1080, "h": 1080, "desc": "1:1 Square"},
}

CRF = {"high": 18, "medium": 22, "fast": 28}
AUDIO_BITRATE = {"high": "192k", "medium": "128k", "fast": "96k"}

# Per-preset bitrate caps and scaling behaviour
PRESET_BITRATE = {
    "facebook_feed": {"maxrate": "4M", "bufsize": "8M", "crop": False},
    "facebook_story": {"maxrate": "4M", "bufsize": "8M", "crop": True},
    "instagram_feed": {"maxrate": "6M", "bufsize": "12M", "crop": False},
    "instagram_story": {"maxrate": "4M", "bufsize": "8M", "crop": True},
    "instagram_reel": {"maxrate": "6M", "bufsize": "12M", "crop": True},
    "tiktok": {"maxrate": "4M", "bufsize": "8M", "crop": True},
    "youtube_short": {"maxrate": "6M", "bufsize": "12M", "crop": True},
    "square": {"maxrate": "4M", "bufsize": "8M", "crop": False},
}


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


def _run(cmd: list[str], timeout: int = 300) -> subprocess.CompletedProcess:
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
        size = int(data.get("format", {}).get("size", 0))
        return {"duration": dur, "size_bytes": size}
    except Exception:
        return {"duration": 0.0, "size_bytes": 0}


def export_preset(config: dict) -> dict:
    """Export a video with platform-optimised settings.

    Config keys: session_id, source, preset, quality
    """
    session_id = config.get("session_id", "default")
    source = config.get("source", "")
    preset = config.get("preset", "instagram_feed")
    quality = config.get("quality", "high")

    if preset not in _VALID_PRESETS:
        return {"error": f"unknown preset: {preset}"}
    if quality not in _VALID_QUALITY:
        return {"error": f"unknown quality: {quality}"}

    src_name = source.split("/")[-1]
    src_path = _video_path(session_id, src_name)
    if not src_path.exists():
        return {"error": f"source not found: {src_path}"}

    spec = PRESET_SPECS[preset]
    tw, th = spec["w"], spec["h"]
    crf = CRF[quality]
    abit = AUDIO_BITRATE[quality]
    br = PRESET_BITRATE[preset]

    out_name = f"{preset}_{uuid.uuid4().hex[:8]}.mp4"
    out_path = _video_path(session_id, out_name)

    # Build filter: crop to fill if needed, otherwise scale to fit + pad
    if br["crop"]:
        # Crop to fill the target aspect ratio, then scale down
        vf = f"crop=iw:ih*{tw}/{th}/iw:0:0,scale={tw}:{th}:flags=lanczos,setsar=1,fps=30"
    else:
        # Scale to fit within bounds, pad to exact size
        vf = f"scale={tw}:{th}:force_original_aspect_ratio=decrease:flags=lanczos,pad={tw}:{th}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30"

    cmd = [
        "ffmpeg", "-y", "-i", str(src_path),
        "-vf", vf,
        "-c:v", "libx264", "-preset", "medium", "-crf", str(crf),
        "-maxrate", br["maxrate"], "-bufsize", br["bufsize"],
        "-c:a", "aac", "-b:a", abit,
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        str(out_path),
    ]

    try:
        r = _run(cmd, timeout=300)
        if r.returncode != 0:
            return {"error": f"FFmpeg failed: {r.stderr.strip()[-300:]}"}
    except subprocess.TimeoutExpired:
        return {"error": "export timed out"}
    except Exception as e:
        log.error("export failed: %s", e)
        return {"error": str(e)}

    info = _probe_info(out_path)
    res = f"{tw}x{th}"
    return {
        "ok": True,
        "path": _served_path(session_id, out_name),
        "preset": preset,
        "resolution": res,
        "duration": info.get("duration", 0),
        "size_bytes": info.get("size_bytes", 0),
    }
