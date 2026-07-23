"""Suno AI Bridge — AI music generation for AGENT OS.

Generate songs from text prompts via Suno AI API.
Creates lyrics (via DeepSeek), generates audio, and produces cover art.
"""
from __future__ import annotations
import json
import logging
import os
import re
import subprocess
import time
import uuid
from pathlib import Path

log = logging.getLogger("agentos.suno")

# ── Security helpers (same pattern as video_editor.py) ──────────────────────
_SAFE_SESSION = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
_SAFE_NAME = re.compile(r"^[a-zA-Z0-9_.-]{1,255}$")
MUSIC_DIR = Path("/var/lib/agent-os/music")


def _safe_session(sid: str) -> str:
    if not _SAFE_SESSION.match(sid): raise ValueError(f"invalid session: {sid!r}")
    return sid


def _safe_name(name: str) -> str:
    if not _SAFE_NAME.match(name): raise ValueError(f"invalid name: {name!r}")
    return name


def _music_path(session_id: str, filename: str) -> Path:
    folder = (MUSIC_DIR / _safe_session(session_id)).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    path = (folder / _safe_name(filename)).resolve()
    if not str(path).startswith(str(folder)):
        raise ValueError("path traversal")
    return path


def _served_path(session_id: str, filename: str) -> str:
    return f"/generated/music/{_safe_session(session_id)}/{_safe_name(filename)}"


def _clamp(val, lo, hi, default):
    try: return max(lo, min(hi, float(val)))
    except (TypeError, ValueError): return default


# ── Suno API integration ────────────────────────────────────────────────────

SUNO_API_BASE = "https://api.suno.ai/v1"


def _api_key(config: dict | None = None) -> str:
    """Resolve Suno API key from config, env, or file."""
    config = config or {}
    key = (config.get("api_key") or "").strip()
    if key:
        return key
    key = os.environ.get("SUNO_API_KEY", "").strip()
    if key:
        return key
    try:
        with open("/etc/agent-os/suno-key") as f:
            return f.read().strip()
    except OSError:
        return ""


def _suno_request(endpoint: str, payload: dict, config: dict | None = None,
                  method: str = "POST") -> dict:
    """Make a request to the Suno API with the configured key."""
    key = _api_key(config)
    if not key:
        return {"error": "no Suno API key configured"}
    
    import urllib.request
    url = f"{SUNO_API_BASE}/{endpoint}"
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=body, method=method,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        })
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        log.error("Suno HTTPError %s: %s", e.code, detail)
        return {"error": f"Suno error {e.code}: {detail}"}
    except Exception as e:
        log.error("Suno request failed: %s", e)
        return {"error": str(e)}


# ── Lyric generation via DeepSeek ───────────────────────────────────────────

def _generate_lyrics(theme: str, style: str, mood: str) -> dict:
    """Generate song lyrics using DeepSeek."""
    prompt = (
        f"Write song lyrics for a {mood} {style} song about {theme}. "
        f"The song should have: verse, chorus, verse, chorus, bridge, chorus structure. "
        f"Make it {max(30, min(120, 60))} lines. Return ONLY the lyrics, no explanation."
    )
    try:
        import subprocess
        r = subprocess.run(
            ["python3", "-c", f"""
import json, urllib.request
key = open('/root/.hermes/.env').read().split('DEEPSEEK_API_KEY=')[1].split(chr(10))[0].strip()
body = json.dumps({{
    "model": "deepseek-chat",
    "messages": [{{"role": "user", "content": {json.dumps(prompt)}}}],
    "max_tokens": 2000
}}).encode()
req = urllib.request.Request(
    "https://api.deepseek.com/v1/chat/completions", data=body,
    headers={{"Authorization": f"Bearer {{key}}", "Content-Type": "application/json"}})
data = json.loads(urllib.request.urlopen(req, timeout=30).read())
print(data['choices'][0]['message']['content'])
            """],
            capture_output=True, text=True, timeout=30,
        )
        lyrics = r.stdout.strip()
        if r.returncode != 0 or not lyrics:
            return {"error": f"lyric generation failed: {r.stderr}"}
        return {"lyrics": lyrics}
    except Exception as e:
        log.error("lyric generation error: %s", e)
        return {"error": str(e)}


# ── Public API functions ────────────────────────────────────────────────────

AVAILABLE_STYLES = [
    "workout", "hip-hop", "rap", "trap", "drill", "r&b", "electronic",
    "house", "techno", "lo-fi", "ambient", "meditation", "motivational",
    "rock", "pop", "reggae", "dancehall", "afrobeat", "latin", "country",
    "gospel", "orchestral", "cinematic", "jazz", "blues",
]

AVAILABLE_MOODS = [
    "energetic", "aggressive", "motivational", "uplifting", "inspiring",
    "calm", "melancholic", "dark", "powerful", "peaceful", "happy", "sad",
]


def generate_song(config: dict) -> dict:
    """Generate a complete song using Suno AI.

    Config keys:
    - session_id: str
    - theme: str (topic of the song, e.g. 'discipline', 'grind', 'no excuses')
    - style: str (genre, default 'workout')
    - mood: str (default 'energetic')
    - lyrics: str (optional — if provided, use these instead of generating)
    - generate_lyrics: bool (default True — generate lyrics if none provided)
    - duration: int (seconds, default 180, max 360)
    - api_key: str (optional Suno API key override)

    Returns: {"ok": True, "audio_url": str, "title": str, "lyrics": str}
    """
    session_id = config.get("session_id", "default")
    theme = config.get("theme", "motivation")
    style = config.get("style", "workout")
    mood = config.get("mood", "energetic")
    lyrics = config.get("lyrics", "")
    should_gen_lyrics = config.get("generate_lyrics", True)
    duration = _clamp(config.get("duration", 180), 30, 360, 180)

    # Generate lyrics if not provided
    if not lyrics and should_gen_lyrics:
        result = _generate_lyrics(theme, style, mood)
        if result.get("error"):
            return {"error": result["error"]}
        lyrics = result["lyrics"]

    # Build the prompt for Suno
    if lyrics:
        prompt = f"Style: {style}, Mood: {mood}\n\n{lyrics}"
    else:
        prompt = (
            f"Create a {mood} {style} song about {theme}. "
            f"Make it energetic and powerful with a strong beat, "
            f"suitable for gym workouts. Duration: {duration} seconds."
        )

    # Call Suno API
    payload = {
        "prompt": prompt,
        "style": style,
        "title": f"{theme.replace('_', ' ').title()} — {mood.title()}",
        "duration": duration,
        "make_instrumental": False,
        "tags": style,
        "mv": "chirp-v4",
    }

    result = _suno_request("generate", payload, config)
    if result.get("error"):
        return {"error": result["error"]}

    # Extract audio URL from response
    audio_url = ""
    title = payload["title"]
    response_lyrics = lyrics

    # Handle different response shapes
    if isinstance(result, dict):
        audio_url = (result.get("data") or result.get("audio_url") or
                     result.get("url") or "")
        title = result.get("title", title)
        response_lyrics = result.get("lyrics", response_lyrics)

    if not audio_url:
        # If no URL yet, Suno may need polling — return a pending status
        clip_id = result.get("id", "")
        if clip_id:
            return {
                "ok": True,
                "status": "generating",
                "clip_id": clip_id,
                "title": title,
                "lyrics": response_lyrics,
                "note": "Generation in progress — poll /api/suno/status/{clip_id}",
            }
        return {"error": "Suno returned no audio URL"}

    # Download the audio file
    try:
        import urllib.request
        out_name = f"suno_{uuid.uuid4().hex[:8]}.wav"
        out_path = _music_path(session_id, out_name)
        urllib.request.urlretrieve(audio_url, out_path)
    except Exception as e:
        return {"error": f"failed to download audio: {e}"}

    return {
        "ok": True,
        "audio_url": _served_path(session_id, out_name),
        "title": title,
        "lyrics": response_lyrics,
        "style": style,
        "mood": mood,
    }


def check_status(config: dict) -> dict:
    """Check the status of a Suno generation.

    Config keys: clip_id (str)
    """
    clip_id = config.get("clip_id", "")
    if not clip_id:
        return {"error": "clip_id required"}
    result = _suno_request(f"clip/{clip_id}", {}, config, method="GET")
    return result


def list_styles() -> dict:
    """Return available music styles."""
    return {"styles": AVAILABLE_STYLES, "moods": AVAILABLE_MOODS}


def generate_cover_art(config: dict) -> dict:
    """Generate cover art for a song using Fal.ai.

    Config keys: session_id, title, artist, style, mood
    """
    session_id = config.get("session_id", "default")
    title = config.get("title", "Untitled")
    artist = config.get("artist", "AI Artist")
    style = config.get("style", "workout")
    mood = config.get("mood", "energetic")

    prompt = (
        f"Album cover for '{title}' by {artist}. "
        f"{mood} {style} music theme. "
        f"Text on cover: '{title}' at top, '{artist}' at bottom. "
        f"3D render style, cinematic lighting, dark background with neon accents. "
        f"3000x3000 pixels, high quality, professional album artwork."
    )

    # Use Fal.ai for image generation
    try:
        fal_key = os.environ.get("FAL_KEY_ID", "") + ":" + os.environ.get("FAL_KEY_SECRET", "")
        if not fal_key:
            # Try reading from config
            pass
        if not fal_key:
            return {"error": "no Fal.ai key for cover art"}

        import urllib.request
        body = json.dumps({
            "prompt": prompt,
            "image_size": {"width": 1024, "height": 1024},
            "num_images": 1,
            "enable_safety_checker": False,
        }).encode()
        req = urllib.request.Request(
            "https://fal.run/fal-ai/flux/schnell", data=body, method="POST",
            headers={"Authorization": f"Key {fal_key}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read())

        img_url = ""
        for img in data.get("images", []):
            img_url = img.get("url", "")
            break

        if not img_url:
            return {"error": "no image generated"}

        # Download and save
        out_name = f"cover_{uuid.uuid4().hex[:8]}.jpg"
        out_path = _music_path(session_id, out_name)
        urllib.request.urlretrieve(img_url, out_path)

        # Resize to 3000x3000 with FFmpeg
        try:
            subprocess.run([
                "ffmpeg", "-y", "-i", str(out_path),
                "-vf", "scale=3000:3000:flags=lanczos",
                str(out_path.with_name(out_name.replace(".jpg", "_full.jpg"))),
            ], capture_output=True, timeout=30)
            full_path = _served_path(session_id, out_name.replace(".jpg", "_full.jpg"))
        except Exception:
            full_path = _served_path(session_id, out_name)

        return {
            "ok": True,
            "cover_url": full_path,
        }
    except Exception as e:
        log.error("cover art failed: %s", e)
        return {"error": str(e)}
