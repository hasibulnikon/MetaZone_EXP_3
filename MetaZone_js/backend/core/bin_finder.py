"""Locates external tool binaries (ffmpeg, ffprobe, Ghostscript) the
same way core/utils.py's find_exiftool() already locates exiftool:
check the PyInstaller-frozen bundle first (sys._MEIPASS/<pkg_dir>/),
so a packaged EXE built by .github/workflows/build_js.yml works on a
machine that never installed these tools -- then fall back to the
system PATH, for development and for users who already have the tool
installed system-wide.

Unlike find_exiftool() (which deliberately never falls back to PATH,
to dodge a stray-temp-exe issue specific to that tool), ffmpeg/gs are
common enough on real machines that a PATH fallback is worth having
in both frozen and dev modes.
"""
import os
import sys
from shutil import which


def find_bundled_binary(pkg_dir, exe_names):
    """pkg_dir: folder name under the bundle root (e.g. 'ffmpeg_pkg').
    exe_names: list of possible executable filenames to try, in order
    (e.g. ['ffmpeg.exe', 'ffmpeg'])."""
    if getattr(sys, "frozen", False):
        base = getattr(sys, "_MEIPASS", None)
        if base:
            for name in exe_names:
                p = os.path.join(base, pkg_dir, name)
                if os.path.exists(p):
                    return p
    for name in exe_names:
        found = which(name)
        if found:
            return found
    return None


def bundled_pkg_root(pkg_dir):
    """Returns the absolute path to <frozen bundle root>/<pkg_dir> if
    this is a frozen build AND that folder was actually bundled,
    otherwise None. Used by render_via_ghostscript to point Ghostscript
    at its own Resource/lib/iccprofiles folders explicitly via -I,
    instead of relying on its relative-to-exe auto-detection (which
    depends on Ghostscript seeing itself sitting in a normal
    <installdir>/bin/ layout -- worth pinning down explicitly rather
    than trusting for a bundle this bespoke)."""
    if getattr(sys, "frozen", False):
        base = getattr(sys, "_MEIPASS", None)
        if base:
            p = os.path.join(base, pkg_dir)
            if os.path.isdir(p):
                return p
    return None
