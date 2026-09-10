"""Video AI prompting -- simplified to ONE overall analysis call.

Earlier version did one AI call per detected scene plus a final
synthesis call (slow: N+1 round trips). Reworked per direct feedback:
no scene-by-scene breakdown wanted, just fast title/description/
keywords for the video as a whole. Every provider in
engine/ai_providers.py already supports multiple images in a single
call (proven by Prompt-to-Prompt's existing multi-image mode), so this
sends all representative frames together in ONE request -- the AI sees
the whole video's visual range at once and writes one description,
instead of us stitching together separate per-frame descriptions
after the fact.

Still real, still no guessing: the real ffprobe technical facts are
injected as mandatory context, same as before, via the same reused
engine.prompt_generator.build_meta_prompt.
"""
from engine.prompt_generator import build_meta_prompt


def _technical_facts_text(tech):
    parts = [f"{tech['duration_sec']}s duration", f"{tech['width']}x{tech['height']} resolution"]
    if tech.get("fps"):
        parts.append(f"{tech['fps']} fps")
    parts.append("has audio" if tech.get("has_audio") else "no audio")
    return (
        "This video's real technical properties (read directly from the file): "
        + ", ".join(parts) + ". "
        "You have been given several representative frames sampled evenly across "
        "the video's full duration -- treat them together as one video and describe "
        "its overall subject, activity, setting, and style. Do not describe them as "
        "separate frames or scenes."
    )


def build_video_meta_prompt(technical, title_c, desc_c, kw_n,
                             custom_prompt="", single_kw=False, avoid_copyright=False,
                             include_desc=True):
    facts = _technical_facts_text(technical)
    combined_custom = (facts + " " + custom_prompt.strip()).strip() if custom_prompt else facts

    return build_meta_prompt(
        title_c, desc_c, kw_n,
        custom_prompt=combined_custom,
        single_kw=single_kw,
        avoid_copyright=avoid_copyright,
        include_desc=include_desc,
    )
