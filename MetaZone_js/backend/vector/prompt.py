"""Turns real structural facts (from svg_structure/ai_pdf_structure/
ps_structure) into a mandatory context block for the AI prompt, then
reuses engine.prompt_generator.build_meta_prompt UNCHANGED to build the
rest -- this is the "combine real structure + AI visual understanding"
step from the project brief, done by handing the AI the real numbers
as ground truth it must respect, not by asking it to guess them.
"""
import os

from core.constants import CONTENT_SUFFIXES
from engine.prompt_generator import build_meta_prompt


def _structural_facts_text(structure, has_preview):
    fmt = structure.get("format")
    if fmt == "svg":
        parts = [
            f"{structure['objects_total']} total objects",
            f"{structure['paths']} paths",
            f"{structure['shapes']} basic shapes",
        ]
        if structure.get("text_objects"):
            parts.append(f"{structure['text_objects']} text objects")
        if structure.get("groups"):
            parts.append(f"{structure['groups']} groups")
        if structure.get("gradients"):
            parts.append(f"{structure['gradients']} gradients")
        if structure.get("clipping_masks"):
            parts.append(f"{structure['clipping_masks']} clipping masks")
        parts.append(f"{structure['color_count']} unique colors")
        fact = "This SVG file's real structure (read directly from the file, not a guess): " + ", ".join(parts) + "."

    elif fmt == "ai-pdf":
        parts = [
            f"{structure['objects_total']} total vector objects",
            f"{structure['paths']} drawing paths",
        ]
        if structure.get("text_objects"):
            parts.append(f"{structure['text_objects']} text words")
        if structure.get("embedded_images"):
            parts.append(f"{structure['embedded_images']} embedded raster images")
        parts.append(f"{structure['color_count']} unique colors")
        fact = "This Illustrator file's real structure (read directly from the file): " + ", ".join(parts) + "."

    elif fmt == "ps-legacy":
        bits = []
        if structure.get("creator"):
            bits.append(f"created in {structure['creator']}")
        if structure.get("pages"):
            bits.append(f"{structure['pages']} page(s)")
        fact = ("This is a legacy PostScript-based vector file" +
                ((", " + ", ".join(bits)) if bits else "") +
                ". Structural object counts are not available for this format.")
    else:
        fact = ""

    if has_preview:
        fact += " Base your analysis on the real rendered preview image provided."
    else:
        fact += (
            " No visual preview could be rendered for this file (a local rendering "
            "tool failed on this machine) -- you have NOT been given an image. Base "
            "your analysis entirely on the real facts above and the filename, and do "
            "not describe visual details (colors, composition, exact subject "
            "appearance) you cannot know from those -- keep the title/description "
            "general and accurate to what's actually known, rather than inventing "
            "specifics."
        )
    return fact


def build_vector_meta_prompt(structure, title_c, desc_c, kw_n, custom_prompt="",
                              single_kw=False, avoid_copyright=False, include_desc=True,
                              has_preview=True, filename=None):
    """Same call shape as build_meta_prompt, but with real structural
    facts injected as a mandatory prefix to the custom prompt, and the
    'vector illustration' content phrase always applied.

    has_preview=False (real rendering failure, e.g. a Ghostscript DLL
    mismatch on the user's machine) switches the injected facts to
    explicitly tell the AI no image was provided, so it doesn't
    hallucinate visual details it was never shown -- see
    _structural_facts_text."""
    facts = _structural_facts_text(structure, has_preview)
    if not has_preview and filename:
        facts += f" The file's name is \"{os.path.basename(filename)}\", which may hint at its real subject."
    combined_custom = (facts + " " + custom_prompt.strip()).strip() if custom_prompt else facts

    return build_meta_prompt(
        title_c, desc_c, kw_n,
        custom_prompt=combined_custom,
        single_kw=single_kw,
        avoid_copyright=avoid_copyright,
        include_desc=include_desc,
        content_phrase=CONTENT_SUFFIXES.get("Vector", "a vector illustration"),
    )
