"""Real (but intentionally limited) reading of legacy .ai and true
.eps files -- both are raw PostScript, a full programming language,
not a declarative shape list like SVG or PDF. There is no reliable way
to count "paths" or "shapes" in arbitrary PostScript without actually
executing it as a program, and even then the result is pixels, not
structured geometry.

Rather than faking path/shape/color counts the way a less careful tool
might, this module only reports what's ACTUALLY, RELIABLY present:
the file's own DSC (Document Structuring Conventions) header comments,
which PostScript/EPS files are required to carry for exactly this kind
of tooling. Anything not in this list is genuinely not available for
this file type -- the UI should say so, not guess.
"""
import re

_DSC_FIELDS = {
    "%%BoundingBox:": "bounding_box",
    "%%HiResBoundingBox:": "bounding_box_hires",
    "%%Creator:": "creator",
    "%%CreationDate:": "creation_date",
    "%%Title:": "title",
    "%%For:": "for_user",
    "%%Pages:": "pages",
    "%%DocumentFonts:": "document_fonts",
    "%%DocumentNeededFonts:": "needed_fonts",
    "%%LanguageLevel:": "language_level",
    "%%ColorUsage:": "color_usage",
    "%%DocumentProcessColors:": "process_colors",
    "%%DocumentCustomColors:": "custom_colors",
}


def parse_ps_header(path, max_header_bytes=8192):
    """Reads only the DSC header comments -- real fields the file
    itself declares, read as plain text. Never touches or interprets
    the actual PostScript program body."""
    try:
        with open(path, "rb") as f:
            head = f.read(max_header_bytes).decode("latin-1", errors="replace")
    except OSError as e:
        raise ValueError(f"Could not open the file: {e}")

    if "%!PS" not in head[:32] and "%!Adobe" not in head[:32]:
        raise ValueError(
            "This doesn't look like a valid PostScript/EPS file "
            "(missing the '%!PS' header)."
        )

    result = {"format": "ps-legacy"}
    for line in head.splitlines():
        for prefix, key in _DSC_FIELDS.items():
            if line.startswith(prefix):
                result[key] = line[len(prefix):].strip()

    bbox = result.get("bounding_box")
    if bbox:
        parts = bbox.split()
        if len(parts) == 4:
            try:
                x0, y0, x1, y1 = (float(p) for p in parts)
                result["width_pt"] = round(x1 - x0, 2)
                result["height_pt"] = round(y1 - y0, 2)
            except ValueError:
                pass

    result["structural_analysis_available"] = False
    result["structural_analysis_note"] = (
        "This is a legacy PostScript-based file. Real path/shape/color "
        "counts aren't reliably extractable without a full PostScript "
        "interpreter -- only the header fields above are genuinely "
        "known. Visual AI analysis, when a preview can be rendered, "
        "uses that real rendered preview -- otherwise these header "
        "facts alone are used (see the result's render_error field)."
    )
    return result
