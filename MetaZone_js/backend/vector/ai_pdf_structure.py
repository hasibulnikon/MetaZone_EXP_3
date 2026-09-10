"""Real structural analysis for modern Adobe Illustrator (.ai) files.

Since Illustrator CS (2003+), .ai files are PDF underneath -- Adobe
embeds a full PDF representation alongside the native data specifically
so other PDF-aware tools can open them. That means we can get REAL
object/path/color counts and a REAL rendered preview via PyMuPDF,
exactly like SVG -- this is not a workaround or approximation, it's
reading the file's actual PDF content stream.

Legacy (pre-2003) .ai files and true .eps files are pure PostScript,
not PDF -- see ps_structure.py for what's honestly extractable there.
is_pdf_compatible() below is the real, file-content-based test that
decides which path a given .ai file takes.
"""
import pymupdf  # PyMuPDF


def is_pdf_compatible(path):
    """Real detection, not a guess: modern .ai files start with a
    '%PDF-' header (sometimes after a few bytes of comment) because
    they ARE PDF files with Illustrator-specific extensions layered on
    top. Legacy files don't have this header at all."""
    try:
        with open(path, "rb") as f:
            head = f.read(2048)
        return b"%PDF-" in head
    except OSError:
        return False


def parse_ai_pdf_structure(path):
    """Real structural read of a PDF-compatible .ai file via PyMuPDF.
    Counts come from PyMuPDF actually walking the page's content
    stream and resource dictionary -- not estimated."""
    try:
        doc = pymupdf.open(path)
    except Exception as e:
        raise ValueError(f"Could not open this .ai file as PDF-compatible: {e}")

    if doc.page_count == 0:
        raise ValueError("This .ai file has no pages to analyze.")

    page = doc[0]
    drawings = page.get_drawings()  # real vector drawing ops on the page

    paths = len(drawings)
    shapes = 0
    strokes = 0
    colors = set()
    for d in drawings:
        if d.get("type") == "f":  # fill-only
            shapes += 1
        if d.get("stroke_opacity") or d.get("color"):
            if d.get("color"):
                colors.add(_rgb_to_hex(d["color"]))
        if d.get("fill"):
            colors.add(_rgb_to_hex(d["fill"]))
        if d.get("width") and d.get("width") > 0:
            strokes += 1

    text_objects = len(page.get_text("words"))
    images = len(page.get_images())
    fonts = page.get_fonts()

    rect = page.rect
    result = {
        "format": "ai-pdf",
        "width": round(rect.width, 2),
        "height": round(rect.height, 2),
        "page_count": doc.page_count,
        "objects_total": len(drawings) + images,
        "paths": paths,
        "shapes": shapes,
        "text_objects": text_objects,
        "embedded_images": images,
        "fonts_used": sorted({f[3] for f in fonts}) if fonts else [],
        "strokes": strokes,
        "colors": sorted(colors),
        "color_count": len(colors),
    }
    doc.close()
    return result


def render_ai_pdf_preview(path, out_path, resolution=1024):
    """Real render of the first page via PyMuPDF's own PDF rasterizer
    (MuPDF) -- the same engine, not a separate approximation."""
    doc = pymupdf.open(path)
    try:
        page = doc[0]
        zoom = resolution / max(page.rect.width, page.rect.height, 1)
        mat = pymupdf.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        pix.save(out_path)
    finally:
        doc.close()
    return out_path


def _rgb_to_hex(color_tuple):
    try:
        r, g, b = [int(round(c * 255)) for c in color_tuple[:3]]
        return f"#{r:02x}{g:02x}{b:02x}"
    except Exception:
        return str(color_tuple)
