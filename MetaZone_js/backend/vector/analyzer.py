"""Vector analyzer router.

Detects the REAL format of an uploaded vector file (not just by file
extension -- .ai files are checked for a real PDF header before being
treated as PDF-compatible) and routes to the correct real reader:

  .svg              -> svg_structure.parse_svg_structure (always real)
  .ai (PDF-based)    -> ai_pdf_structure.parse_ai_pdf_structure (real)
  .ai (legacy)/.eps  -> ps_structure.parse_ps_header (real, limited)

Also produces a real raster preview for the AI visual-analysis step,
using the renderer that matches the format actually detected.

STRUCTURE READ FAILURES ARE FATAL (we genuinely can't say anything real
about a file we can't parse). RENDER FAILURES ARE NOT -- a real report
from the field: Ghostscript can fail with a DLL version mismatch on a
given Windows machine even when correctly installed (multiple
Ghostscript versions/DLLs on one system is a known, common conflict).
Rather than losing the whole file over a rendering problem, this
returns (structure, None, render_error) so the caller can fall back to
a text-only AI call using the real structural/header facts alone.
"""
import os

from vector.svg_structure import parse_svg_structure
from vector.ai_pdf_structure import is_pdf_compatible, parse_ai_pdf_structure, render_ai_pdf_preview
from vector.ps_structure import parse_ps_header
from vector.renderer import render_svg_to_png, render_via_ghostscript


def detect_and_analyze(path, render_resolution=1024):
    """Returns (structure_dict, preview_png_path_or_None, render_error_or_None).
    Raises ValueError only if the STRUCTURAL read itself fails -- that's
    the one thing we can't proceed without."""
    ext = os.path.splitext(path)[1].lower()

    if ext == ".svg":
        structure = parse_svg_structure(path)
        preview, render_error = _try_render(render_svg_to_png, path, resolution=render_resolution)
        return structure, preview, render_error

    if ext == ".ai":
        if is_pdf_compatible(path):
            structure = parse_ai_pdf_structure(path)
            preview_path = _temp_png()
            preview, render_error = _try_render(
                render_ai_pdf_preview, path, preview_path, resolution=render_resolution
            )
            return structure, preview, render_error
        else:
            structure = parse_ps_header(path)
            preview, render_error = _try_render(render_via_ghostscript, path, resolution=200)
            return structure, preview, render_error

    if ext == ".eps":
        structure = parse_ps_header(path)
        preview, render_error = _try_render(render_via_ghostscript, path, resolution=200)
        return structure, preview, render_error

    raise ValueError(f"Unsupported vector format: {ext}")


def _try_render(render_fn, *args, **kwargs):
    """Runs a render function; on failure, returns (None, error_message)
    instead of raising, so a render problem (e.g. a Ghostscript DLL
    mismatch) doesn't take down the whole file's analysis."""
    try:
        return render_fn(*args, **kwargs), None
    except Exception as e:
        return None, str(e)


def _temp_png():
    import tempfile
    fd, p = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    return p
