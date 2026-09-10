"""Real SVG structural analysis.

Every number this module returns comes directly from parsing the SVG's
actual XML tree with lxml. Nothing here is estimated, guessed, or
inferred by AI -- if a count is wrong, it's a parsing bug, not a
"close enough" AI answer. This is the counterpart to the future
AI-visual-analysis step (vector/ai_analysis.py), which handles the
subjective side (subject, style, mood) -- the two are combined by
whatever calls this, never blended into one guess.

Supported: SVG only (this file). Modern PDF-based .ai files are
handled by vector/ai_pdf_structure.py (real, PyMuPDF-based). Legacy
.ai and true .eps files are PostScript, not markup -- see
vector/ps_structure.py, which is intentionally limited to what a
PostScript header can honestly tell you.
"""
from lxml import etree

SVG_NS = "http://www.w3.org/2000/svg"


def _local(tag):
    """Strip the namespace off a lxml tag name, e.g.
    '{http://www.w3.org/2000/svg}path' -> 'path'."""
    if isinstance(tag, str) and tag.startswith("{"):
        return tag.split("}", 1)[1]
    return tag


# Element groups, based on what each tag actually IS in the SVG spec --
# not a guess, this is the spec's own vocabulary.
_SHAPE_TAGS = {"rect", "circle", "ellipse", "polygon", "polyline", "line"}
_PATH_TAGS = {"path"}
_TEXT_TAGS = {"text", "tspan"}
_GROUP_TAGS = {"g"}
_GRADIENT_TAGS = {"linearGradient", "radialGradient"}
_CLIP_TAGS = {"clipPath", "mask"}
_STROKE_ATTR_HINTS = ("stroke",)


def parse_svg_structure(path):
    """Parse an SVG file and return real structural counts + real
    document properties. Raises ValueError with a plain-language
    message on invalid/corrupted SVG -- caller decides how to surface
    that to the user, but this function never fabricates a result for
    a file it couldn't actually read.
    """
    try:
        tree = etree.parse(path)
    except etree.XMLSyntaxError as e:
        raise ValueError(f"This SVG file is not valid XML and can't be read: {e}")
    except OSError as e:
        raise ValueError(f"Could not open the file: {e}")

    root = tree.getroot()
    if _local(root.tag) != "svg":
        raise ValueError("This file's root element isn't <svg> -- it may not be a real SVG.")

    all_elements = list(root.iter())
    tag_counts = {}
    colors = set()
    has_transparency = False

    paths = shapes = texts = groups = gradients = clips = strokes = 0

    def _collect_colors(value):
        if not value or value in ("none", "currentColor", "transparent"):
            if value == "transparent":
                nonlocal_flag["transparency"] = True
            return
        colors.add(value.strip())

    nonlocal_flag = {"transparency": False}

    for el in all_elements:
        tag = _local(el.tag)
        tag_counts[tag] = tag_counts.get(tag, 0) + 1

        if tag in _PATH_TAGS:
            paths += 1
        elif tag in _SHAPE_TAGS:
            shapes += 1
        elif tag in _TEXT_TAGS:
            texts += 1
        elif tag in _GROUP_TAGS:
            groups += 1
        elif tag in _GRADIENT_TAGS:
            gradients += 1
        elif tag in _CLIP_TAGS:
            clips += 1

        fill = el.get("fill")
        stroke = el.get("stroke")
        stop_color = el.get("stop-color")
        style = el.get("style") or ""

        if fill:
            _collect_colors(fill)
        if stroke:
            _collect_colors(stroke)
            strokes += 1
        if stop_color:
            _collect_colors(stop_color)
        # Inline style="fill:#...;stroke:#..." — real CSS-in-attribute,
        # parsed properly rather than assumed absent.
        for decl in style.split(";"):
            if ":" not in decl:
                continue
            prop, _, val = decl.partition(":")
            prop = prop.strip().lower()
            val = val.strip()
            if prop == "fill":
                _collect_colors(val)
            elif prop == "stroke":
                _collect_colors(val)
                strokes += 1

        opacity = el.get("opacity") or el.get("fill-opacity")
        if opacity is not None:
            try:
                if float(opacity) < 1.0:
                    nonlocal_flag["transparency"] = True
            except ValueError:
                pass

    width = root.get("width")
    height = root.get("height")
    view_box = root.get("viewBox")

    return {
        "format": "svg",
        "width": width,
        "height": height,
        "view_box": view_box,
        "objects_total": len(all_elements) - 1,  # exclude the <svg> root itself
        "paths": paths,
        "shapes": shapes,
        "text_objects": texts,
        "groups": groups,
        "gradients": gradients,
        "clipping_masks": clips,
        "strokes": strokes,
        "colors": sorted(colors),
        "color_count": len(colors),
        "has_transparency": nonlocal_flag["transparency"],
        "tag_breakdown": tag_counts,
    }
