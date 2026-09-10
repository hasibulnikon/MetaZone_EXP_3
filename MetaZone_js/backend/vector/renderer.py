"""Renders vector files to real PNG previews so the existing AI vision
engine (engine/ai_providers.py) can look at them -- every provider we
support takes an image, not a vector file, so this step is mandatory,
not optional polish. This module never fabricates a preview; if
rendering fails, it raises rather than returning a blank/placeholder
image that would silently feed a meaningless picture to the AI.

SVG rendering uses PyMuPDF (already a hard dependency for the
PDF-compatible .ai path), NOT cairosvg. This was a deliberate switch:
cairosvg needs the native Cairo C library at runtime (libcairo-2.dll on
Windows), which isn't a Python package pip can install -- it requires
bundling a chain of GTK-adjacent DLLs, a genuinely fragile, poorly
documented deployment path with many long-standing open issues.
PyMuPDF statically bundles its own renderer inside its wheel, so it
has zero equivalent native-library-discovery problem, and it was
already proven working in this project's CI.

KNOWN TRADEOFF: MuPDF's SVG renderer does not render <linearGradient>/
<radialGradient> fills -- they come out solid black in the preview
image. This does NOT affect the real structural data (gradient count
and real stop colors are still read correctly by svg_structure.py and
injected into the AI prompt as text facts either way) -- it only means
the AI's VISUAL read of a gradient-filled shape won't see the actual
gradient colors, just a black shape. Acceptable tradeoff versus
shipping a Cairo DLL chain that can fail to load on a stock Windows
machine with no clear error message.
"""
import os
import subprocess
import tempfile

import pymupdf

from core.bin_finder import bundled_pkg_root


def render_svg_to_png(svg_path, out_path=None, resolution=1024):
    """Real rasterization via PyMuPDF/MuPDF's own SVG renderer (renders
    the actual SVG paint tree, not a guess at what it might look like).
    See the module docstring for the one known limitation (gradients
    render as solid black). Returns the output path."""
    if out_path is None:
        fd, out_path = tempfile.mkstemp(suffix=".png")
        os.close(fd)
    try:
        doc = pymupdf.open(svg_path)
        try:
            page = doc[0]
            zoom = resolution / max(page.rect.width, page.rect.height, 1)
            mat = pymupdf.Matrix(zoom, zoom)
            pix = page.get_pixmap(matrix=mat, alpha=False)
            pix.save(out_path)
        finally:
            doc.close()
    except Exception as e:
        raise ValueError(f"Could not render this SVG for preview: {e}")
    return out_path


def render_via_ghostscript(vector_path, out_path=None, resolution=200):
    """Real rasterization for PostScript-family files (.eps, legacy
    .ai) via Ghostscript -- the same real renderer Adobe/print
    pipelines use to interpret PostScript, not a custom guesser.
    Requires the `gs` binary to be installed on the system (same
    external-dependency pattern MetaZone already uses for exiftool),
    OR the bundled copy shipped in a Windows build's gs_pkg/ folder
    (see core/bin_finder.py + .github/workflows/build_js.yml).
    """
    if out_path is None:
        fd, out_path = tempfile.mkstemp(suffix=".png")
        os.close(fd)

    gs_bin = _find_gs()
    if not gs_bin:
        raise RuntimeError(
            "Ghostscript ('gs') is not installed. It's required to preview "
            ".eps and legacy .ai files. Install it from ghostscript.com/releases "
            "or via your package manager (e.g. 'apt install ghostscript', "
            "'brew install ghostscript')."
        )

    cmd = [
        gs_bin, "-dSAFER", "-dBATCH", "-dNOPAUSE", "-dEPSCrop",
        "-sDEVICE=png16m", f"-r{resolution}",
    ]
    # v0.9.8: when running the bundled copy from a frozen Windows
    # build, tell Ghostscript exactly where its own Resource/lib/
    # iccprofiles folders are via -I / -sICCProfilesDir, instead of
    # relying on its own relative-to-exe auto-detection. That
    # auto-detection assumes gswin64c.exe sits in a conventional
    # <installdir>/bin/ layout -- true here (gs_pkg/bin/), but explicit
    # is safer than implicit for a bundle this bespoke, and this has
    # not been verified against a real Windows install of the bundled
    # build (no Windows machine available in this sandbox -- see
    # CHANGELOG). A system-installed `gs` on PATH (dev machines, Linux,
    # macOS) needs none of this -- it already knows where it lives.
    gs_pkg_root = bundled_pkg_root("gs_pkg")
    if gs_pkg_root:
        resource_dir = os.path.join(gs_pkg_root, "Resource")
        lib_dir = os.path.join(gs_pkg_root, "lib")
        icc_dir = os.path.join(gs_pkg_root, "iccprofiles")
        if os.path.isdir(resource_dir):
            cmd.append(f"-I{resource_dir}")
        if os.path.isdir(lib_dir):
            cmd.append(f"-I{lib_dir}")
        if os.path.isdir(icc_dir):
            cmd.append(f"-sICCProfilesDir={icc_dir}")
    cmd += [f"-sOutputFile={out_path}", vector_path]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=30)
    except subprocess.TimeoutExpired:
        raise ValueError("Rendering this file timed out — it may be corrupted or unusually complex.")
    if result.returncode != 0 or not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        err = result.stderr.decode(errors="replace")[:300]
        raise ValueError(f"Ghostscript could not render this file: {err}")
    return out_path


def _find_gs():
    from core.bin_finder import find_bundled_binary
    return find_bundled_binary("gs_pkg/bin", ["gswin64c.exe", "gswin32c.exe", "gs.exe", "gs"])
