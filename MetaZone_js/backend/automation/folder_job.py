"""FolderJob -- one queued folder plus its own independent settings
and status. Every job carries a full copy of its options dict (never a
shared reference), so editing one folder's settings can never leak
into another's (spec item 7).
"""
import os
import uuid

from core.constants import IMAGE_EXTS, VECTOR_EXTS, VIDEO_EXTS, ALL_SUPPORTED_EXTS
from automation.presets import DEFAULT_OPTIONS


def scan_folder(path):
    """Real, non-recursive scan of a folder's directly-contained files.
    Subfolders are intentionally not walked -- the queue's "one folder
    = one job" model, its auto CSV naming, and the common-folder
    inference the generation engine relies on all assume one flat
    folder. Returns (file_list, count, dominant_type_label).
    """
    files = []
    if os.path.isdir(path):
        for entry in os.listdir(path):
            full = os.path.join(path, entry)
            if os.path.isfile(full) and os.path.splitext(entry)[1].lower() in ALL_SUPPORTED_EXTS:
                files.append(full)

    counts = {"image": 0, "vector": 0, "video": 0}
    for f in files:
        ext = os.path.splitext(f)[1].lower()
        if ext in VECTOR_EXTS:
            counts["vector"] += 1
        elif ext in VIDEO_EXTS:
            counts["video"] += 1
        elif ext in IMAGE_EXTS:
            counts["image"] += 1

    if not files:
        dominant = "Empty"
    else:
        non_zero = [k for k, v in counts.items() if v > 0]
        top = max(counts, key=counts.get)
        dominant = {"image": "Image", "vector": "Vector", "video": "Video"}[top] \
            if len(non_zero) <= 1 else "Mixed"

    return files, len(files), dominant


class FolderJob:
    def __init__(self, path, preset_name="Custom", options=None):
        self.id = uuid.uuid4().hex[:12]
        self.path = path
        self.name = os.path.basename(os.path.normpath(path)) or path
        self.preset_name = preset_name
        self.options = dict(options or DEFAULT_OPTIONS)
        self.status = "waiting"     # waiting | running | done | error | stopped
        self.error_message = None
        self.csv_path = None
        self.embed_summary = None   # filled in by job_controller after an auto-embed pass
        self.started_at = None
        self.finished_at = None
        self.progress = {"done": 0, "failed": 0, "total": 0}
        self.current_step = None    # short human label while running, e.g. "Generating metadata"
        self.files = []
        self.file_count = 0
        self.file_type = "Empty"
        self.exists = False
        self.refresh_scan()

    def refresh_scan(self):
        """Re-reads the folder from disk -- called when added, and
        again right before processing, since a folder's contents can
        change between being queued and actually being run."""
        self.files, self.file_count, self.file_type = scan_folder(self.path)
        self.exists = os.path.isdir(self.path)

    def to_dict(self):
        return {
            "id": self.id,
            "path": self.path,
            "name": self.name,
            "exists": self.exists,
            "file_count": self.file_count,
            "file_type": self.file_type,
            "preset_name": self.preset_name,
            "options": self.options,
            "status": self.status,
            "error_message": self.error_message,
            "csv_path": self.csv_path,
            "embed_summary": self.embed_summary,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "progress": self.progress,
            "current_step": self.current_step,
        }
