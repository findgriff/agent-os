"""Overlay — FFmpeg overlay filter for watermarks, logos, and lower thirds.

Add image overlays (watermarks/logos) and text lower thirds to videos.
"""
from __future__ import annotations
import base64
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
_IMAGE_MAGIC_BYTES = {
    b"\x89PNG": ".png", b"\xff\xd8": ".jpg", b"GIF8": ".gif", b"RIFF": ".webp",
}
_VALID_POSITIONS = {"top-left", "top-right", "bottom-left", "bottom-right", "center"}


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
             "-show_format", str(path)],
            capture_output=True, text=True, timeout=30,
        )
        data = json.loads(r.stdout)
        return float(data.get("format", {}).get("duration", 0))
    except Exception:
        return 0.0


def _detect_image_type(data: bytes) -> str | None:
    for magic, ext in _IMAGE_MAGIC_BYTES.items():
        if data.startswith(magic):
            return ext
    return None


def add_overlay(config: dict) -> dict:
    """Overlay an image (logo/watermark) onto a video.

    Config keys: session_id, source, overlay_image, position, padding, width, start, end, opacity
    """
    session_id = config.get("session_id", "default")
    source = config.get("source", "")
    overlay_src = config.get("overlay_image", "")
    position = config.get("position", "bottom-right")
    padding = int(config.get("padding", 20))
    resize_w = int(config.get("width", 0))
    start = float(config.get("start", 0))
    end = float(config.get("end", 0))
    opacity = max(0.0, min(1.0, float(config.get("opacity", 1.0))))

    if position not in _VALID_POSITIONS:
        return {"error": f"invalid position: {position}"}

    src_name = source.split("/")[-1]
    src_path = _video_path(session_id, src_name)

    if not src_path.exists():
        return {"error": f"source not found: {src_path}"}

    # Handle overlay image: base64 data or file path
    overlay_path = None
    if overlay_src.startswith("data:"):
        # Base64 encoded image
        try:
            header, b64data = overlay_src.split(",", 1)
            raw = base64.b64decode(b64data)
            ext = _detect_image_type(raw)
            if not ext:
                return {"error": "unsupported image format"}
            img_name = f"overlay_{uuid.uuid4().hex[:8]}{ext}"
            overlay_path = _video_path(session_id, img_name)
            overlay_path.write_bytes(raw)
        except Exception as e:
            return {"error": f"invalid overlay image data: {e}"}
    else:
        img_name = overlay_src.split("/")[-1]
        overlay_path = _video_path(session_id, img_name)
        if not overlay_path.exists():
            return {"error": f"overlay not found: {overlay_path}"}

    out_name = f"watermark_{uuid.uuid4().hex[:8]}_{src_name}"
    out_path = _video_path(session_id, out_name)

    # Position formulas
    pos_map = {
        "top-left": f"{padding}:{padding}",
        "top-right": f"W-w-{padding}:{padding}",
        "bottom-left": f"{padding}:H-h-{padding}",
        "bottom-right": f"W-w-{padding}:H-h-{padding}",
        "center": f"(W-w)/2:(H-h)/2",
    }
    overlay_pos = pos_map[position]

    # Enable expression for time range
    enable = f"between(t,{start},{end})" if end > 0 else f"gte(t,{start})"

    # Build filter
    filters = []
    if resize_w > 0:
        filters.append(f"[1:v]scale={resize_w}:-1[ovr]")
        ovr_input = "[ovr]"
    else:
        ovr_input = "[1:v]"

    if opacity < 1.0:
        filters.append(f"{ovr_input}colorchannelmixer=aa={opacity}[ovr2]")
        ovr_input = "[ovr2]"

    overlay_expr = f"overlay={overlay_pos}:enable='{enable}'"
    ovr_filter = f"[0:v]{ovr_input}{overlay_expr}"

    cmd = [
        "ffmpeg", "-y", "-i", str(src_path), "-i", str(overlay_path),
        "-filter_complex", ovr_filter,
        "-c:a", "copy", str(out_path),
    ]

    try:
        _run(cmd, timeout=300)
    except subprocess.TimeoutExpired:
        return {"error": "overlay timed out"}
    except Exception as e:
        log.error("overlay failed: %s", e)
        return {"error": str(e)}

    dur = _probe_duration(out_path)
    return {"ok": True, "path": _served_path(session_id, out_name), "duration": dur}


def add_lower_third(config: dict) -> dict:
    """Add a text-based lower third (name/title bar) to a video.

    Config keys: session_id, source, text, start, end, font_size, color, background
    """
    session_id = config.get("session_id", "default")
    source = config.get("source", "")
    text = config.get("text", "")
    start = float(config.get("start", 0))
    end = float(config.get("end", 0))
    font_size = int(config.get("font_size", 28))
    color = config.get("color", "#FFFFFF")
    bg = config.get("background", "#000000AA")

    if not text.strip():
        return {"error": "text is required"}

    src_name = source.split("/")[-1]
    src_path = _video_path(session_id, src_name)
    if not src_path.exists():
        return {"error": f"source not found: {src_path}"}

    out_name = f"lower_{uuid.uuid4().hex[:8]}_{src_name}"
    out_path = _video_path(session_id, out_name)

    # Escape text for drawtext
    escaped = text.replace("\\", "\\\\").replace("%", "%%").replace(":", "\\:").replace("'", "\\\\'")
    enable = f"between(t,{start},{end})" if end > 0 else f"gte(t,{start})"

    # Parse background color and alpha
    bg_color = bg[:7] if bg.startswith("#") else "#000000"
    bg_alpha = 0.7
    if len(bg) == 9:
        try: bg_alpha = int(bg[7:9], 16) / 255
        except ValueError: pass

    bar_height = font_size + 40
    vf = (
        f"drawbox=x=0:y=H-{bar_height}:w=W:h={bar_height}:"
        f"color={bg_color}@{bg_alpha}:t=fill:enable='{enable}',"
        f"drawtext=text='{escaped}':fontsize={font_size}:fontcolor={color}:"
        f"x=(w-text_w)/2:y=H-{bar_height//2 + font_size//2}:enable='{enable}'"
    )

    cmd = [
        "ffmpeg", "-y", "-i", str(src_path),
        "-vf", vf, "-c:a", "copy", str(out_path),
    ]

    try:
        _run(cmd, timeout=300)
    except subprocess.TimeoutExpired:
        return {"error": "lower third timed out"}
    except Exception as e:
        log.error("lower third failed: %s", e)
        return {"error": str(e)}

    dur = _probe_duration(out_path)
    return {"ok": True, "path": _served_path(session_id, out_name), "duration": dur}
