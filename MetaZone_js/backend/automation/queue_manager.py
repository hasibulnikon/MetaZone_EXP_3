"""AutomationQueue -- ordered list of FolderJobs, their presets, and
disk persistence. Deliberately owns only queue order/config; it never
touches session.py's Session (Meta Generator's state), per the spec's
separation requirement. The actual sequential processing engine is a
separate module (job_controller.py, next phase) that reads/writes
FolderJob objects this class hands it -- this file has no threads and
does no generation/CSV/embedding work itself.
"""
import json
import os
import threading

from automation.folder_job import FolderJob
from automation.presets import builtin_presets, DEFAULT_OPTIONS
from core.config import _common_pref_dir


def _queue_state_path():
    base = _common_pref_dir()
    try:
        os.makedirs(base, exist_ok=True)
    except Exception:
        pass
    return os.path.join(base, "automation_queue_state.json")


class AutomationQueue:
    def __init__(self):
        self.jobs = []            # list[FolderJob], order == processing order
        self.custom_presets = {}  # name -> options (spec item 9: user-saved presets)
        self.lock = threading.Lock()

    # ---- folder management (spec items 4, 6, 7) ----
    def add_folder(self, path, preset_name="Custom"):
        with self.lock:
            if not path:
                return {"ok": False, "error": "No folder path given."}
            if any(j.path == path for j in self.jobs):
                return {"ok": False, "error": "That folder is already queued."}
            if not os.path.isdir(path):
                return {"ok": False, "error": f"Folder not found: {path}"}
            options = self._preset_options(preset_name)
            job = FolderJob(path, preset_name, options)
            self.jobs.append(job)
            self._save()
            return {"ok": True, "job": job.to_dict()}

    def add_folders(self, paths):
        return {"ok": True, "results": [self.add_folder(p) for p in paths]}

    def remove_folder(self, job_id):
        with self.lock:
            job = self._find(job_id)
            if not job:
                return {"ok": False, "error": "Folder not found in queue."}
            if job.status == "running":
                return {"ok": False, "error": "Can't remove a folder while it's processing."}
            self.jobs = [j for j in self.jobs if j.id != job_id]
            self._save()
            return {"ok": True}

    def duplicate_folder(self, job_id):
        with self.lock:
            job = self._find(job_id)
            if not job:
                return {"ok": False, "error": "Folder not found in queue."}
            new_job = FolderJob(job.path, job.preset_name, dict(job.options))
            self.jobs.insert(self.jobs.index(job) + 1, new_job)
            self._save()
            return {"ok": True, "job": new_job.to_dict()}

    def reorder(self, ordered_ids):
        with self.lock:
            by_id = {j.id: j for j in self.jobs}
            if set(ordered_ids) != set(by_id.keys()):
                return {"ok": False, "error": "That order doesn't match the current queue."}
            self.jobs = [by_id[i] for i in ordered_ids]
            self._save()
            return {"ok": True}

    def move(self, job_id, direction):
        """direction: -1 (up) / +1 (down) -- quick-action alternative
        to full drag reorder (spec item 27)."""
        with self.lock:
            idx = next((i for i, j in enumerate(self.jobs) if j.id == job_id), None)
            if idx is None:
                return {"ok": False, "error": "Folder not found in queue."}
            new_idx = idx + direction
            if not (0 <= new_idx < len(self.jobs)):
                return {"ok": False, "error": "Already at that end of the queue."}
            self.jobs[idx], self.jobs[new_idx] = self.jobs[new_idx], self.jobs[idx]
            self._save()
            return {"ok": True}

    # ---- per-folder settings (spec items 7, 8, 9) ----
    def update_job_options(self, job_id, options):
        with self.lock:
            job = self._find(job_id)
            if not job:
                return {"ok": False, "error": "Folder not found in queue."}
            if job.status == "running":
                return {"ok": False, "error": "Can't change settings while this folder is processing."}
            job.options.update(options)
            job.preset_name = "Custom"  # edited away from whatever preset it started as
            self._save()
            return {"ok": True, "job": job.to_dict()}

    def apply_preset(self, job_id, preset_name):
        with self.lock:
            job = self._find(job_id)
            if not job:
                return {"ok": False, "error": "Folder not found in queue."}
            job.options = self._preset_options(preset_name)
            job.preset_name = preset_name
            self._save()
            return {"ok": True, "job": job.to_dict()}

    # ---- Universal Preset: define settings once, apply to every
    # folder currently in the queue in one shot. Individual per-folder
    # customization (update_job_options/apply_preset above) remains
    # fully available afterward -- this is a bulk starting point, not
    # a lock, matching the request: "keep that functionality, but add
    # a Universal Preset". ----
    def apply_universal_preset(self, options):
        with self.lock:
            applied, skipped = [], []
            for job in self.jobs:
                if job.status == "running":
                    # Never mutate a folder's options while its own
                    # generation pass is mid-read of them.
                    skipped.append(job.id)
                    continue
                job.options = dict(options)
                job.preset_name = "Custom"
                applied.append(job.id)
            self._save()
            return {"ok": True, "applied": applied, "skipped": skipped,
                     **self.to_dict()}

    def save_custom_preset(self, name, options):
        if not name or name == "Custom":
            return {"ok": False, "error": "Choose a different preset name."}
        with self.lock:
            self.custom_presets[name] = dict(options)
            self._save()
            return {"ok": True}

    def get_presets(self):
        return {"ok": True, "builtin": list(builtin_presets().keys()),
                "custom": list(self.custom_presets.keys())}

    def _preset_options(self, preset_name):
        presets = {**builtin_presets(), **self.custom_presets}
        return dict(presets.get(preset_name, DEFAULT_OPTIONS))

    def _find(self, job_id):
        return next((j for j in self.jobs if j.id == job_id), None)

    # ---- state for the UI ----
    def to_dict(self):
        return {"jobs": [j.to_dict() for j in self.jobs],
                "custom_presets": list(self.custom_presets.keys())}

    # ---- persistence (spec item 19) ----
    def _save(self):
        """Best-effort snapshot so an interrupted queue can be detected
        on next launch. Saves job config + status only, not live
        progress counters -- resuming re-scans each folder fresh."""
        data = {
            "custom_presets": self.custom_presets,
            "jobs": [
                {"path": j.path, "preset_name": j.preset_name, "options": j.options,
                 "status": "interrupted" if j.status == "running" else j.status}
                for j in self.jobs
            ],
        }
        path = _queue_state_path()
        tmp = path + ".tmp"
        try:
            with open(tmp, "w") as f:
                json.dump(data, f, indent=2)
            os.replace(tmp, path)
        except Exception:
            pass

    def find_resumable(self):
        """Returns the saved queue dict if a previous run left folders
        unfinished, else None. Read-only -- doesn't touch self.jobs."""
        try:
            with open(_queue_state_path()) as f:
                data = json.load(f)
        except Exception:
            return None
        if any(j.get("status") in ("waiting", "interrupted") for j in data.get("jobs", [])):
            return data
        return None

    def load_from_state(self, data):
        """Rebuilds self.jobs from a saved state dict (Resume). Already
        "done" folders are skipped so they're never restarted."""
        with self.lock:
            self.custom_presets = data.get("custom_presets", {})
            self.jobs = [
                FolderJob(j["path"], j.get("preset_name", "Custom"), j.get("options"))
                for j in data.get("jobs", []) if j.get("status") != "done"
            ]
            self._save()
            return self.to_dict()

    def discard_saved_state(self):
        try:
            os.remove(_queue_state_path())
        except Exception:
            pass
        return {"ok": True}

    # ---- Dry Run (spec item 20) ----
    # Read-only: validates every folder/setting/output-permission/API-
    # readiness question up front, without generating a single piece of
    # metadata or spending an API call. Real checks against the actual
    # filesystem/config, not a canned "looks fine" response.
    def dry_run(self):
        import settings as settings_mod
        from core.utils import find_exiftool

        results = []
        total_files = 0
        any_embed_requested = False

        for job in self.jobs:
            job.refresh_scan()
            issues = []
            if not job.exists:
                issues.append("Folder not found.")
            elif job.file_count == 0:
                issues.append("No supported files in this folder.")
            else:
                # Real readability check -- open() the first byte of
                # each file rather than assuming os.listdir() finding
                # it means it's actually readable (permissions, locked
                # files, etc. can still block a real read).
                unreadable = 0
                for f in job.files:
                    try:
                        with open(f, "rb") as fh:
                            fh.read(1)
                    except Exception:
                        unreadable += 1
                if unreadable:
                    issues.append(f"{unreadable} file(s) couldn't be read.")

            if job.exists and not os.access(job.path, os.W_OK):
                issues.append("Output folder isn't writable -- CSV/embed would fail here.")

            opts = job.options
            if opts.get("title_chars", 0) <= 0 or opts.get("kw_count", 0) <= 0:
                issues.append("Title length / keyword count must be greater than 0.")

            if opts.get("auto_embed"):
                any_embed_requested = True

            total_files += job.file_count
            results.append({
                "job_id": job.id, "name": job.name, "path": job.path,
                "file_count": job.file_count, "ok": len(issues) == 0, "issues": issues,
            })

        # One shared check, not per-folder -- API keys and exiftool
        # availability are global, not folder-specific.
        providers = settings_mod.get_provider_summary()
        api_ready = any(p.get("active_count", 0) > 0 for p in providers)
        exiftool_ready = find_exiftool() is not None if any_embed_requested else None

        return {
            "ok": True,
            "folders": results,
            "total_folders": len(self.jobs),
            "total_files": total_files,
            "all_folders_ok": all(r["ok"] for r in results),
            "api_ready": api_ready,
            "embed_requested": any_embed_requested,
            "exiftool_ready": exiftool_ready,
        }
