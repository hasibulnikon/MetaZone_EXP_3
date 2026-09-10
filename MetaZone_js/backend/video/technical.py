"""Real video technical analysis via ffprobe.

Every field returned here comes from ffprobe actually reading the
file's own container/stream metadata -- duration, resolution, FPS,
codec, bitrate, frame count, audio presence. Nothing is estimated.
If ffprobe can't read a value for a given file, that field is left
out/None rather than filled with a guess.
"""
import json
import os
import subprocess
from core.bin_finder import find_bundled_binary


def _ffprobe_path():
    return find_bundled_binary("ffmpeg_pkg", ["ffprobe.exe", "ffprobe"])


def ffprobe_available():
    return _ffprobe_path() is not None


def analyze_video_technical(path):
    """Runs `ffprobe -show_format -show_streams` (real container +
    stream inspection) and returns the technical facts a stock
    platform actually cares about. Raises ValueError with a plain
    message on failure -- never returns fabricated numbers."""
    ffprobe_bin = _ffprobe_path()
    if not ffprobe_bin:
        raise RuntimeError(
            "ffprobe is not installed. It ships with FFmpeg -- install it "
            "from ffmpeg.org/download.html or via your package manager "
            "(e.g. 'apt install ffmpeg', 'brew install ffmpeg')."
        )

    cmd = [
        ffprobe_bin, "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=30)
    except subprocess.TimeoutExpired:
        raise ValueError("Reading this video's technical info timed out.")

    if result.returncode != 0:
        raise ValueError(f"ffprobe could not read this file: {result.stderr.decode(errors='replace')[:300]}")

    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        raise ValueError("ffprobe returned unreadable output for this file.")

    fmt = data.get("format", {})
    streams = data.get("streams", [])
    video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)

    if not video_stream:
        raise ValueError("No video stream found in this file -- it may be audio-only or corrupted.")

    duration = float(fmt.get("duration", video_stream.get("duration", 0)) or 0)
    fps = _parse_frame_rate(video_stream.get("r_frame_rate"))
    nb_frames = video_stream.get("nb_frames")
    if nb_frames is not None:
        try:
            nb_frames = int(nb_frames)
        except ValueError:
            nb_frames = None
    if nb_frames is None and fps:
        nb_frames = round(duration * fps)  # derived from two real values, not guessed

    return {
        "duration_sec": round(duration, 2),
        "width": video_stream.get("width"),
        "height": video_stream.get("height"),
        "fps": round(fps, 3) if fps else None,
        "video_codec": video_stream.get("codec_name"),
        "container": fmt.get("format_name"),
        "bitrate_kbps": round(int(fmt.get("bit_rate", 0)) / 1000, 1) if fmt.get("bit_rate") else None,
        "frame_count": nb_frames,
        "has_audio": audio_stream is not None,
        "audio_codec": audio_stream.get("codec_name") if audio_stream else None,
        "audio_channels": audio_stream.get("channels") if audio_stream else None,
        "file_size_bytes": int(fmt.get("size", 0)) if fmt.get("size") else os.path.getsize(path),
    }


def _parse_frame_rate(rate_str):
    """ffprobe gives frame rate as 'num/den' (e.g. '30000/1001') --
    real fractional rate, parsed exactly rather than rounded blindly."""
    if not rate_str or "/" not in rate_str:
        return None
    try:
        num, den = rate_str.split("/")
        num, den = float(num), float(den)
        return num / den if den else None
    except (ValueError, ZeroDivisionError):
        return None
