"""Video Effects — FFmpeg visual effects for the AGENT OS video editor.

Apply brightness, contrast, saturation, hue, sharpen, blur, grayscale,
sepia, vignette, and auto-enhance presets to video clips.
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

_VALID_EFFECTS = {"brightness", "contrast", "saturation", "hue", "sharpen", "blur", "grayscale", "sepia", "vignette"}
_VALID_MODES = {"warm", "cool", "vibrant", "cinematic", "soft"}


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


def _probe_duration(path: Path) -> float:
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(path)],
            capture_output=True, text=True, timeout=30,
        )
        return float(json.loads(r.stdout).get("format", {}).get("duration", 0))
    except Exception:
        return 0.0


def _clamp(val, lo, hi, default):
    try: return max(lo, min(hi, float(val)))
    except (TypeError, ValueError): return default


def _build_effect_filter(effect: dict) -> str | None:
    """Build a single FFmpeg filter string for an effect. Returns None on invalid type."""
    etype = effect.get("type", "")
    value = effect.get("value", 0)
    try: value = float(value)
    except (TypeError, ValueError): value = 0

    if etype == "brightness":
        v = _clamp(value, -1.0, 1.0, 0)
        return f"eq=brightness={v}"
    elif etype == "contrast":
        v = _clamp(value, -1.0, 1.0, 0)
        return f"eq=contrast={v}"
    elif etype == "saturation":
        v = _clamp(value, -1.0, 1.0, 0)
        return f"eq=saturation={v}"
    elif etype == "hue":
        v = _clamp(value, -180, 180, 0)
        return f"hue=H={v}"
    elif etype == "sharpen":
        v = _clamp(value, 0, 5.0, 0)
        return f"unsharp=l_msize_x=5:l_msize_y=5:l_amount={v}" if v > 0 else None
    elif etype == "blur":
        v = _clamp(value, 0, 20, 0)
        return f"gblur=sigma={v}" if v > 0 else None
    elif etype == "grayscale":
        return "colorchannelmixer=.3:.4:.3:0:.3:.4:.3:0:.3:.4:.3:0"
    elif etype == "sepia":
        return "colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131:0"
    elif etype == "vignette":
        v = _clamp(value, 0, 1.0, 0)
        return f"vignette=PI*{v}/4" if v > 0 else None
    return None


def apply_effects(config: dict) -> dict:
    """Apply visual effects to a video clip.

    Config keys: session_id, source, effects (list of {type, value})
    """
    session_id = config.get("session_id", "default")
    source = config.get("source", "")
    effects = config.get("effects", [])

    if not effects:
        return {"error": "no effects specified"}
    if not isinstance(effects, list):
        return {"error": "effects must be a list"}

    src_name = source.split("/")[-1]
    src_path = _video_path(session_id, src_name)
    if not src_path.exists():
        return {"error": f"source not found: {src_path}"}

    out_name = f"fx_{uuid.uuid4().hex[:8]}_{src_name}"
    out_path = _video_path(session_id, out_name)

    # Build filter chain
    filter_parts = []
    for eff in effects:
        etype = eff.get("type", "")
        if etype not in _VALID_EFFECTS:
            return {"error": f"unknown effect: {etype}"}
        f_str = _build_effect_filter(eff)
        if f_str:
            filter_parts.append(f_str)

    if not filter_parts:
        return {"error": "no valid effects could be applied"}

    vf = ",".join(filter_parts)
    cmd = [
        "ffmpeg", "-y", "-i", str(src_path),
        "-vf", vf, "-c:a", "copy",
        "-c:v", "libx264", "-preset", "fast", "-crf", "20",
        str(out_path),
    ]

    try:
        r = _run(cmd, timeout=300)
        if r.returncode != 0:
            return {"error": f"FFmpeg failed: {r.stderr.strip()[-300:]}"}
    except subprocess.TimeoutExpired:
        return {"error": "effects timed out"}
    except Exception as e:
        log.error("effects failed: %s", e)
        return {"error": str(e)}

    dur = _probe_duration(out_path)
    return {"ok": True, "path": _served_path(session_id, out_name), "duration": dur}


def apply_auto_enhance(config: dict) -> dict:
    """Auto-enhance a video with a preset look.

    Config keys: session_id, source, mode ('warm','cool','vibrant','cinematic','soft')
    """
    mode = config.get("mode", "vibrant")

    if mode not in _VALID_MODES:
        return {"error": f"unknown mode: {mode}. Valid: {', '.join(sorted(_VALID_MODES))}"}

    # Define preset looks
    presets = {
        "warm": [
            {"type": "brightness", "value": 0.05},
            {"type": "contrast", "value": 0.05},
            {"type": "hue", "value": 15},
        ],
        "cool": [
            {"type": "contrast", "value": 0.08},
            {"type": "hue", "value": -20},
            {"type": "saturation", "value": -0.1},
        ],
        "vibrant": [
            {"type": "saturation", "value": 0.25},
            {"type": "contrast", "value": 0.08},
            {"type": "brightness", "value": 0.03},
            {"type": "sharpen", "value": 0.3},
        ],
        "cinematic": [
            {"type": "saturation", "value": -0.15},
            {"type": "contrast", "value": 0.15},
            {"type": "vignette", "value": 0.4},
            {"type": "hue", "value": 5},
        ],
        "soft": [
            {"type": "contrast", "value": -0.08},
            {"type": "brightness", "value": 0.05},
            {"type": "blur", "value": 0.5},
        ],
    }

    return apply_effects({**config, "effects": presets[mode]})
