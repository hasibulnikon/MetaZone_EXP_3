"""Built-in starting presets for Automation Queue folder jobs.

Important: these are NOT invented per-file-type defaults. MetaZone's
real generation engine (session.py's _gen_thread) has exactly one set
of fallback values -- 130-char title, 200-char description, 49
keywords (see the `options.get("title_chars") or 130` style fallbacks
there) -- so every preset below starts from those same real numbers.
"Vector" / "Transparent PNG" / "JPEG" exist as separate *named*
presets so folders of different asset types can be grouped and tuned
independently (spec item 9), not because MetaZone's engine already
treats those file types differently -- it doesn't. Until real
per-type defaults are deliberately decided on, every named preset is
an identical copy of the same real numbers; naming them lets a folder
be assigned one without guessing at values on your behalf.
"""

DEFAULT_OPTIONS = {
    "mode": "meta",             # "meta" (title/desc/keywords) or "prompt"
    "title_chars": 130,
    "desc_chars": 200,
    "include_desc": True,
    "kw_count": 49,
    "custom": "",               # custom prompt text (spec item 8)
    "single_kw": False,
    "avoid_copyright": False,
    "prefix_on": False,
    "prefix": "",
    "suffix_on": False,
    "suffix": "",
    "content_phrase": "",
    "concurrency": 4,
    "max_words": 500,           # only used when mode == "prompt"
    # Automation-only flags (not read by session.py -- consumed by the
    # job controller instead, see automation/job_controller.py):
    "auto_download_csv": True,  # spec item 21: "Auto Save CSV"
    "auto_embed": False,        # spec item 22: "Auto Embed Metadata"
}

BUILTIN_PRESET_NAMES = ["Custom", "Vector", "Transparent PNG", "JPEG"]


def builtin_presets():
    """Returns {name: options}, each its own independent dict copy."""
    return {name: dict(DEFAULT_OPTIONS) for name in BUILTIN_PRESET_NAMES}
