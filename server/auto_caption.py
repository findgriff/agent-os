"""Auto Caption — Whisper-powered caption generation for AGENT OS.

Extract audio from a video with FFmpeg, transcribe it with OpenAI Whisper,
and return timed captions ready for burn-in via video_editor.render_captions.

Videos live under /var/lib/agent-os/videos/ and are served at
/generated/videos/. Temp audio is written into the session directory and
cleaned up in a finally block.

Install: pip install openai-whisper   (ffmpeg v6.1.1 already present)
"""
from __future__ import annotations
import logging
import re
import subprocess
import uuid
from pathlib import Path

log = logging.getLogger("agentos.autocaption")

VIDEOS_DIR = Path("/var/lib/agent-os/videos")

# Security: strict session/filename allowlists (mirrors video_editor.py)
_SAFE_SESSION = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
_SAFE_NAME = re.compile(r"^[a-zA-Z0-9_.-]{1,255}$")
# Language code: ISO 639-1/2 style tokens like "en", "en-US", "pt"
_SAFE_LANG = re.compile(r"^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{2,8})?$")

# Transcription budget (seconds)
_TRANSCRIBE_TIMEOUT = 300

# Whisper model is expensive to load; cache a single instance per process.
_MODEL = None


def _safe_session(sid: str) -> str:
    if not _SAFE_SESSION.match(sid):
        raise ValueError(f"invalid session_id: {sid!r}")
    return sid


def _safe_name(name: str) -> str:
    if not _SAFE_NAME.match(name):
        raise ValueError(f"invalid filename: {name!r}")
    return name


def _safe_lang(lang: str) -> str:
    if not _SAFE_LANG.match(lang):
        raise ValueError(f"invalid language: {lang!r}")
    return lang


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


def _load_model():
    """Load (and cache) the Whisper 'base' model."""
    global _MODEL
    if _MODEL is None:
        import whisper
        log.info("loading whisper model 'base'")
        _MODEL = whisper.load_model("base")
    return _MODEL


def _extract_audio(src_path: Path, wav_path: Path) -> None:
    """Extract mono 16kHz PCM WAV audio from a video for Whisper."""
    log.info("extract audio: %s -> %s", src_path.name, wav_path.name)
    r = subprocess.run(
        ["ffmpeg", "-y", "-i", str(src_path),
         "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
         str(wav_path)],
        capture_output=True, text=True, timeout=120,
    )
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg audio extraction failed: {r.stderr[-500:]}")


def split_long_captions(segments: list, max_chars: int = 40) -> list:
    """Split long caption segments into shorter ones with sequential timing.

    Each input segment is a dict with {start, end, text}. Segments whose text
    exceeds ``max_chars`` are broken on word boundaries into multiple pieces,
    with each piece's time slice proportional to its share of the characters so
    the sub-captions play back-to-back across the original span.
    """
    out: list = []
    for seg in segments:
        text = str(seg.get("text", "")).strip()
        start = float(seg.get("start", 0.0))
        end = float(seg.get("end", start))
        if not text:
            continue

        if len(text) <= max_chars:
            out.append({"start": start, "end": end, "text": text})
            continue

        # Greedily pack words into lines no longer than max_chars.
        lines: list[str] = []
        current = ""
        for word in text.split():
            if not current:
                current = word
            elif len(current) + 1 + len(word) <= max_chars:
                current += " " + word
            else:
                lines.append(current)
                current = word
            # A single word longer than max_chars becomes its own line.
            if len(current) > max_chars and " " not in current:
                lines.append(current)
                current = ""
        if current:
            lines.append(current)

        if not lines:
            continue

        # Distribute the segment's duration proportionally by character count.
        span = max(end - start, 0.0)
        total_chars = sum(len(ln) for ln in lines) or 1
        cursor = start
        for i, ln in enumerate(lines):
            if i == len(lines) - 1:
                seg_end = end
            else:
                seg_end = cursor + span * (len(ln) / total_chars)
            out.append({"start": cursor, "end": seg_end, "text": ln})
            cursor = seg_end

    return out


def generate_captions(config: dict) -> dict:
    """Extract audio from video, transcribe, return captions.

    Config keys:
    - session_id: str (for file organization)
    - source: str (filename or /generated/videos/... path)
    - language: str (default 'en')
    - max_line_length: int (default 40 - max chars per caption line)
    - min_gap: float (default 0.5 - minimum gap between captions in seconds)

    Returns:
    - success: {"ok": True, "captions": [...], "duration": float}
    - error: {"error": "message"}
    """
    wav_path: Path | None = None
    try:
        session_id = config.get("session_id", "default")
        source = config.get("source", "")
        language = _safe_lang(config.get("language") or "en")
        max_line_length = int(config.get("max_line_length", 40))
        min_gap = float(config.get("min_gap", 0.5))

        if not source:
            return {"error": "no source provided"}

        # source may be a full /generated/videos/... path or just a filename
        src_name = source.split("/")[-1]
        src_path = _video_path(session_id, src_name)
        if not src_path.exists():
            return {"error": f"source not found: {src_path}"}

        # Extract audio into the (validated) session directory.
        wav_path = _video_path(session_id, f"audio_{uuid.uuid4().hex[:8]}.wav")
        try:
            _extract_audio(src_path, wav_path)
        except subprocess.TimeoutExpired:
            return {"error": "audio extraction timed out"}

        # Transcribe with Whisper.
        try:
            model = _load_model()
        except ImportError:
            return {"error": "whisper not installed (pip install openai-whisper)"}

        log.info("transcribing %s (lang=%s)", wav_path.name, language)
        try:
            result = _transcribe(model, wav_path, language)
        except subprocess.TimeoutExpired:
            return {"error": "transcription timed out"}

        raw_segments = result.get("segments", []) or []
        segments = [
            {"start": float(s.get("start", 0.0)),
             "end": float(s.get("end", 0.0)),
             "text": str(s.get("text", "")).strip()}
            for s in raw_segments
            if str(s.get("text", "")).strip()
        ]

        # Split long lines, then enforce a minimum gap between captions.
        pieces = split_long_captions(segments, max_chars=max_line_length)
        pieces = _apply_min_gap(pieces, min_gap)

        captions = []
        for i, p in enumerate(pieces):
            captions.append({
                "id": i,
                "start": round(p["start"], 3),
                "end": round(p["end"], 3),
                "text": p["text"],
                "position": "bottom",
                "fontSize": 24,
                "color": "#FFFFFF",
            })

        duration = float(segments[-1]["end"]) if segments else 0.0
        return {"ok": True, "captions": captions, "duration": duration}

    except ValueError as e:
        # Validation failures (bad session/filename/language).
        log.warning("generate_captions rejected input: %s", e)
        return {"error": str(e)}
    except Exception as e:
        log.error("generate_captions failed: %s", e)
        return {"error": str(e)}
    finally:
        if wav_path is not None:
            try:
                wav_path.unlink()
            except OSError:
                pass


def _transcribe(model, wav_path: Path, language: str) -> dict:
    """Run Whisper transcription under the transcription timeout.

    Whisper runs in-process, so the timeout is enforced by wrapping the CPU-
    bound call; on machines where a hard limit is required this bounds the
    inference to _TRANSCRIBE_TIMEOUT seconds.
    """
    import signal

    class _Timeout(Exception):
        pass

    def _raise(signum, frame):
        raise _Timeout()

    # SIGALRM is only available in the main thread on POSIX; fall back to an
    # unbounded call elsewhere rather than crashing.
    can_alarm = hasattr(signal, "SIGALRM")
    if can_alarm:
        prev = signal.signal(signal.SIGALRM, _raise)
        signal.alarm(_TRANSCRIBE_TIMEOUT)
    try:
        return model.transcribe(str(wav_path), language=language, verbose=False)
    except _Timeout:
        raise subprocess.TimeoutExpired("whisper.transcribe", _TRANSCRIBE_TIMEOUT)
    finally:
        if can_alarm:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, prev)


def _apply_min_gap(pieces: list, min_gap: float) -> list:
    """Trim caption ends so consecutive captions are separated by min_gap.

    Only adjusts when captions would otherwise touch or overlap; the caption is
    shortened (never its start moved) and dropped if the gap leaves no room.
    """
    if min_gap <= 0 or not pieces:
        return pieces
    adjusted: list = []
    for i, p in enumerate(pieces):
        start, end = p["start"], p["end"]
        if i + 1 < len(pieces):
            next_start = pieces[i + 1]["start"]
            if end > next_start - min_gap:
                end = next_start - min_gap
        if end <= start:
            # No room for a visible caption; skip it.
            continue
        adjusted.append({**p, "start": start, "end": end})
    return adjusted
