"""Audio Track — FFmpeg amix-based audio overlay for AGENT OS video editor.

Add background music, voiceover, extract or replace audio tracks.
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


def _clamp(val, lo, hi, default):
    try: return max(lo, min(hi, float(val)))
    except (TypeError, ValueError): return default


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


def add_background_music(config: dict) -> dict:
    """Add background music to a video with volume control.

    Config keys: session_id, source (video), music (audio), volume (0-1), loop
    """
    session_id = config.get("session_id", "default")
    source = config.get("source", "")
    music = config.get("music", "")
    volume = _clamp(config.get("volume", 0.3), 0.0, 1.0, 0.3)
    loop = bool(config.get("loop", True))

    src_name = source.split("/")[-1]
    music_name = music.split("/")[-1]
    src_path = _video_path(session_id, src_name)
    music_path = _video_path(session_id, music_name)

    if not src_path.exists():
        return {"error": f"source not found: {src_path}"}
    if not music_path.exists():
        return {"error": f"music not found: {music_path}"}

    out_name = f"bgm_{uuid.uuid4().hex[:8]}_{src_name}"
    out_path = _video_path(session_id, out_name)

    if loop:
        # Loop music to match video length using -stream_loop (safer than amovie= filter)
        cmd = [
            "ffmpeg", "-y", "-stream_loop", "-1", "-i", str(music_path),
            "-i", str(src_path),
            "-filter_complex", f"[0:a]volume={volume}[bgm];[1:a][bgm]amix=inputs=2:duration=first[outa]",
            "-map", "1:v", "-map", "[outa]",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
            "-shortest", str(out_path),
        ]
    else:
        cmd = [
            "ffmpeg", "-y", "-i", str(src_path), "-i", str(music_path),
            "-filter_complex", f"[1:a]volume={volume}[bgm];[0:a][bgm]amix=inputs=2:duration=first[outa]",
            "-map", "0:v", "-map", "[outa]",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
            "-shortest", str(out_path),
        ]

    try:
        r = _run(cmd, timeout=300)
        if r.returncode != 0:
            err = r.stderr.strip()[-300:] if r.stderr else "unknown error"
            return {"error": f"FFmpeg failed: {err}"}
    except subprocess.TimeoutExpired:
        return {"error": "background music timed out"}
    except Exception as e:
        log.error("background music failed: %s", e)
        return {"error": str(e)}

    dur = _probe_duration(out_path)
    return {"ok": True, "path": _served_path(session_id, out_name), "duration": dur}


def add_voiceover(config: dict) -> dict:
    """Overlay a voiceover audio track onto a video.

    Config keys: session_id, source (video), voiceover (audio), volume (0-2), start_at (seconds)
    """
    session_id = config.get("session_id", "default")
    source = config.get("source", "")
    voiceover = config.get("voiceover", "")
    volume = _clamp(config.get("volume", 1.0), 0.0, 2.0, 1.0)
    start_at = max(0.0, float(config.get("start_at", 0)))

    src_name = source.split("/")[-1]
    vo_name = voiceover.split("/")[-1]
    src_path = _video_path(session_id, src_name)
    vo_path = _video_path(session_id, vo_name)

    if not src_path.exists():
        return {"error": f"source not found: {src_path}"}
    if not vo_path.exists():
        return {"error": f"voiceover not found: {vo_path}"}

    out_name = f"vo_{uuid.uuid4().hex[:8]}_{src_name}"
    out_path = _video_path(session_id, out_name)

    # Delay voiceover by start_at seconds, then amix
    filter_complex = (
        f"[1:a]adelay={int(start_at*1000)}|{int(start_at*1000)},"
        f"volume={volume}[vo];"
        f"[0:a][vo]amix=inputs=2:duration=first[outa]"
    )

    cmd = [
        "ffmpeg", "-y", "-i", str(src_path), "-i", str(vo_path),
        "-filter_complex", filter_complex,
        "-map", "0:v", "-map", "[outa]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
        "-shortest", str(out_path),
    ]

    try:
        _run(cmd, timeout=300)
    except subprocess.TimeoutExpired:
        return {"error": "voiceover timed out"}
    except Exception as e:
        log.error("voiceover failed: %s", e)
        return {"error": str(e)}

    dur = _probe_duration(out_path)
    return {"ok": True, "path": _served_path(session_id, out_name), "duration": dur}


def extract_audio(config: dict) -> dict:
    """Extract audio track from a video file.

    Config keys: session_id, source (video), format ('mp3', 'wav', 'aac')
    """
    session_id = config.get("session_id", "default")
    source = config.get("source", "")
    fmt = config.get("format", "mp3")

    if fmt not in ("mp3", "wav", "aac"):
        return {"error": f"unsupported format: {fmt}"}

    src_name = source.split("/")[-1]
    src_path = _video_path(session_id, src_name)
    if not src_path.exists():
        return {"error": f"source not found: {src_path}"}

    out_name = f"audio_{uuid.uuid4().hex[:8]}.{fmt}"
    out_path = _video_path(session_id, out_name)

    codec = {"mp3": "libmp3lame", "wav": "pcm_s16le", "aac": "aac"}[fmt]
    try:
        _run([
            "ffmpeg", "-y", "-i", str(src_path),
            "-vn", "-c:a", codec, str(out_path),
        ], timeout=120)
    except subprocess.TimeoutExpired:
        return {"error": "audio extraction timed out"}
    except Exception as e:
        log.error("audio extraction failed: %s", e)
        return {"error": str(e)}

    dur = _probe_duration(out_path)
    return {"ok": True, "path": _served_path(session_id, out_name), "duration": dur}


def replace_audio(config: dict) -> dict:
    """Replace the entire audio track of a video with a new one.

    Config keys: session_id, source (video), audio (new audio file)
    """
    session_id = config.get("session_id", "default")
    source = config.get("source", "")
    audio = config.get("audio", "")

    src_name = source.split("/")[-1]
    audio_name = audio.split("/")[-1]
    src_path = _video_path(session_id, src_name)
    audio_path = _video_path(session_id, audio_name)

    if not src_path.exists():
        return {"error": f"source not found: {src_path}"}
    if not audio_path.exists():
        return {"error": f"audio not found: {audio_path}"}

    out_name = f"replaced_{uuid.uuid4().hex[:8]}_{src_name}"
    out_path = _video_path(session_id, out_name)

    cmd = [
        "ffmpeg", "-y", "-i", str(src_path), "-i", str(audio_path),
        "-c:v", "copy", "-map", "0:v:0", "-map", "1:a:0",
        "-c:a", "aac", "-b:a", "128k", "-shortest", str(out_path),
    ]

    try:
        _run(cmd, timeout=300)
    except subprocess.TimeoutExpired:
        return {"error": "audio replace timed out"}
    except Exception as e:
        log.error("audio replace failed: %s", e)
        return {"error": str(e)}

    dur = _probe_duration(out_path)
    return {"ok": True, "path": _served_path(session_id, out_name), "duration": dur}
