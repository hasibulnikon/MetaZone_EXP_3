"""
session.py — Stage 4: the real Meta Generator pipeline, ported to run
behind the JS bridge instead of behind Tk widgets.

This is a deliberate PORT, not a rewrite: the actual generation logic
(prompt building, call_with_failover, parsing, sanitization, the
undercount-keyword retry, prefix/suffix application) is copied
line-for-line in intent from ui/main_window.py's `_gen_thread` /
`process_one`, calling the exact same unmodified engine/core functions.
What's different is only the UI-facing seam: instead of
`self._ui_action_queue.put(lambda: card.apply_result(...))`, this
module calls `bridge.emit(...)`, and instead of CTkImage thumbnails,
`make_thumb_b64` produces a plain base64 PNG for an `<img>` tag.

Card-render rules carried over unchanged (see project knowledge doc):
- A path never gets a card while "waiting"/"working" -- only once
  "done"/"failed" (see `_results` status transitions below).
- Cards render in completion order; `completion_order` is append-only,
  exactly like main_window.py's `_completion_order`.
"""
import base64
import csv
import io
import os
import threading
import time

from core.constants import VECTOR_EXTS, VIDEO_EXTS, ALL_SUPPORTED_EXTS
from core.utils import (
    wait_stable_and_validate_image, prepare_generation_preview, model_label,
    clear_shared_temp_data, get_original_file_meta,
)
from engine.ai_providers import call_with_failover
from engine.prompt_generator import build_meta_prompt, build_prompt_prompt
from engine.parser import (
    parse_meta, enforce_single_keywords, _strip_copyright_keywords,
    smart_trim, dedupe_content_phrase, sanitize_text_punctuation,
    sanitize_keywords_punctuation, enforce_word_cap,
)
from workers.task_manager import TaskManager

# v0.9.7: real Vector/Video engines, wired into the Generate workflow's
# Auto Detect dispatch below (see process_one) -- NOT a separate page,
# NOT a separate session object. A dropped .ai/.eps/.svg/.mp4/.mov file
# lands in the exact same all_paths/results/completion_order/card_update
# machinery every image already uses; only the *how the AI answer gets
# produced* step differs per file, in _vector_call/_video_call below.
from vector.analyzer import detect_and_analyze as _vector_detect_and_analyze
from vector.prompt import build_vector_meta_prompt
from video.technical import analyze_video_technical
from video.frames import extract_frames_fixed_interval
from video.prompt import build_video_meta_prompt

try:
    from PIL import Image
except ImportError:
    Image = None

import bridge  # for bridge.emit -- see bridge.py's queue seam


def _working_csv_dir():
    """Where the auto-written 'working CSV' (see `_write_working_csv`)
    and nothing else lives -- deliberately its own subfolder under the
    same common MetaZone cache root as gen_previews/thumbs, so Clear
    All can wipe it the same way, and so it's never anywhere near
    prefs.json (API keys / settings).

    v0.9.1 bugfix: this is the actual root cause of the Embed page's
    "auto-import the CSV from Meta Generator" not working for some
    installs. core.config._common_pref_dir() points at a fixed
    C:\\MetaZone on Windows (see core/config.py) -- writable for most
    users, but not guaranteed (e.g. a standard/non-admin account where
    that folder hasn't already been created with permissive ACLs).
    Previously, only a failure of the *import itself* fell back to a
    temp directory; a failure of the actual os.makedirs() call below
    (permissions, read-only drive, etc.) just returned None with no
    fallback at all -- so _write_working_csv() silently never ran,
    self.last_csv_path stayed None, and clicking Embed on Meta
    Generator would switch pages but find nothing to load, with only
    a small, easy-to-miss status-line error explaining why. Now falls
    back to the OS temp directory (same one core.config.get_prefs_path
    already falls back to for the exact same reason) on ANY failure
    creating the primary location, not just an import error, so the
    working CSV -- and therefore the Embed auto-import -- keeps
    working even when C:\\MetaZone isn't writable."""
    try:
        from core.config import _common_pref_dir
        d = os.path.join(_common_pref_dir(), ".cache", "exports")
        os.makedirs(d, exist_ok=True)
        return d
    except Exception:
        pass
    try:
        import tempfile
        d = os.path.join(tempfile.gettempdir(), "MetaZone_working")
        os.makedirs(d, exist_ok=True)
        return d
    except Exception:
        return None


class Session:
    """One in-memory batch, mirroring the subset of App's instance
    state that the generation pipeline actually needs. A real desktop
    app has exactly one of these alive at a time (same as the Tk app
    only ever has one App window)."""

    def __init__(self, event_prefix=""):
        self.all_paths = []          # append-only import order
        self.results = {}            # path -> {"status": ..., ...}
        self.completion_order = []   # append-only, never reordered
        self.thumb_cache = {}        # path -> base64 PNG string
        self.file_meta = {}          # v0.9.3: path -> {width,height,size_bytes} (original file, not thumb)
        # v0.9.4.1: path -> {"all_paths_index": int|None, "completion_order_index": int|None},
        # populated by delete_card/delete_cards right before removing
        # the path from each list, consumed by restore_card so Undo
        # reinserts at the original position instead of silently
        # appending to the end (see restore_card's docstring).
        self._deleted_positions = {}
        self.task_mgr = TaskManager()
        self.stop_flag = False
        self.paused = False
        self.gen_epoch = 0
        self.running = False
        self.last_provider = None
        self.last_model = None
        # Set only on a full, natural generation completion (never on
        # Stop/Pause) -- gates the Embed button and the popup's
        # auto-load, same visibility rule the original app used.
        self.last_csv_path = None
        self.last_common_folder = None
        self.batch_complete = False
        # v0.8.5: this Session class now backs TWO independent pages
        # (Meta Generator AND the new Image to Prompt Generator) as two
        # separate instances (see bridge.py's Api.__init__), each with
        # its own imported files/results/running state. Both instances
        # push events through the same bridge.emit()/ui_event_queue,
        # so each instance's events need distinct names or the two
        # pages' frontends would receive each other's card updates.
        # event_prefix="" keeps the original Meta Generator's event
        # names byte-for-byte unchanged (app.js listens for
        # "card_update" etc, no frontend change needed there); the
        # Image to Prompt session is constructed with
        # event_prefix="prompt_" so its events land as "prompt_card_update"
        # etc for the new promptgen.js to listen to separately.
        self.event_prefix = event_prefix
        # Set by start_generation(mode=...) so export_csv()/auto-download
        # know which column layout to write without callers having to
        # pass mode a second time.
        self.last_mode = "meta"
        # v0.8.5: "Auto Download CSV" toggle beside Stop on Meta
        # Generator -- when true, a completed batch is automatically
        # exported (via export_csv()) into the images' own common
        # folder, in addition to (not instead of) the existing
        # always-on internal working CSV used for the Embed handoff.
        self.auto_download_csv = False

    def _emit(self, name, payload):
        bridge.emit(self.event_prefix + name, payload)

    # ---- import ----
    def add_paths(self, paths):
        # v0.9.x fix (Part 19): 'existing' used to be a static snapshot
        # of self.all_paths taken before this loop, so it only caught
        # duplicates against *already-imported* files. If the same path
        # appeared twice in a single incoming batch (e.g. a folder walk
        # that follows a symlink back to a file already in the list, or
        # a drag event that hands over overlapping file lists), both
        # copies passed this check and both ended up appended to
        # self.all_paths -- a real duplicate card + wasted duplicate
        # generation. 'existing' is now updated as each path is
        # accepted into 'candidates', so within-batch duplicates are
        # caught the same way cross-batch ones already were.
        existing = set(self.all_paths)
        accepted, rejected = [], []
        candidates = []
        for p in paths:
            if p in existing:
                # v0.9.4: duplicates used to just `continue` silently --
                # never counted anywhere. The new import-summary toast
                # needs to tell "N duplicates skipped" apart from "N
                # unsupported skipped", so this is now a real rejection
                # reason instead of a silent no-op.
                rejected.append((p, "duplicate"))
                continue
            ext = os.path.splitext(p)[1].lower()
            if ext not in ALL_SUPPORTED_EXTS:
                rejected.append((p, "unsupported file type"))
                continue
            candidates.append(p)
            existing.add(p)

        # v0.9.4: 'accepted' used to be appended to directly from inside
        # _check_one, so its final order was whichever thread's
        # validation happened to finish first -- not the order the
        # files were selected/dropped in. wait_stable_and_validate_image's
        # cost varies per file (recency-gated retries), so completion
        # order is genuinely unpredictable under real usage, not just a
        # theoretical race. Fix: each thread now only records its own
        # result into results_by_path (keyed, so concurrent writes to
        # different keys need no ordering guarantee at all), and
        # accepted/rejected are built afterwards by walking `candidates`
        # in its original order. Validation itself is still fully
        # parallel -- only the bookkeeping of the outcome changed.
        lock = threading.Lock()
        results_by_path = {}
        def _check_one(p):
            ext = os.path.splitext(p)[1].lower()
            if ext in VECTOR_EXTS or ext in VIDEO_EXTS:
                with lock:
                    results_by_path[p] = (True, None)
                return
            ok, reason = wait_stable_and_validate_image(p)
            with lock:
                results_by_path[p] = (ok, reason)

        threads = [threading.Thread(target=_check_one, args=(p,)) for p in candidates]
        MAX_CONCURRENT = 8
        for i in range(0, len(threads), MAX_CONCURRENT):
            batch = threads[i:i + MAX_CONCURRENT]
            for t in batch: t.start()
            for t in batch: t.join()

        for p in candidates:
            ok, reason = results_by_path[p]
            if ok:
                accepted.append(p)
            else:
                rejected.append((p, reason))

        for p in accepted:
            self.all_paths.append(p)
            self.results[p] = {"status": "waiting"}

        # Warm thumbnails in the background, never blocking the caller.
        threading.Thread(target=self._prefetch_thumbs, args=(accepted,), daemon=True).start()
        return {"accepted": accepted, "rejected": rejected}

    def _prefetch_thumbs(self, paths):
        for p in paths:
            b64 = make_thumb_b64(p)
            if b64:
                self.thumb_cache[p] = b64
                self._emit("thumb_ready", {"path": p, "thumb": b64})
            # v0.9.3: original width/height + on-disk size for the card
            # grid's info line -- same one-time-at-import spirit as the
            # thumbnail above, kept as its own event so a slow/large
            # file's PIL open never blocks the thumbnail from showing.
            meta = get_original_file_meta(p)
            self.file_meta[p] = meta
            self._emit("file_meta_ready", {"path": p, "meta": meta})

    def clear(self):
        # v0.8.7: Clear All must be safe even while a generation is
        # actively running -- bumping gen_epoch here invalidates every
        # in-flight worker's token (see _gen_thread/process_one's epoch
        # checks and _on_all_done below). Workers that are mid-API-call
        # can't be killed, but every check-and-commit point they hit
        # after this line compares against the *new* epoch and no-ops,
        # so they can never repopulate self.results/completion_order
        # after this clear. stop_flag/running are also reset so the UI
        # (which reads /running) reflects "not generating" immediately.
        self.gen_epoch += 1
        self.stop_flag = True
        self.running = False
        self.all_paths = []
        self.results = {}
        self.completion_order = []
        self.thumb_cache = {}
        self._deleted_positions = {}  # v0.9.4.1: stale undo positions from a cleared batch must not apply to whatever's imported next
        self.last_csv_path = None
        self.last_common_folder = None
        self.batch_complete = False
        self._cleanup_temp()

    def _cleanup_temp(self):
        """Clear All wipes MetaZone's own temp/cache folders too --
        generation-preview cache, thumbnail cache, and the working CSV
        written for the Embed handoff -- so the app is genuinely clean
        afterward, not just visually empty. v0.8.9: delegates to
        core.utils.clear_shared_temp_data(), the same routine every
        other page's Clear/Reset button now calls (see prompt2prompt.py),
        so all three never drift out of sync again."""
        try:
            clear_shared_temp_data()
        except Exception:
            pass

    def _common_folder(self):
        if not self.all_paths:
            return None
        dirs = [os.path.dirname(p) for p in self.all_paths]
        try:
            return os.path.commonpath(dirs)
        except ValueError:
            return dirs[0]  # paths on different drives (Windows) -- fall back to the first

    def _write_working_csv(self):
        """Write current completed results to a working CSV on disk,
        automatically, so the Embed button can hand it straight to the
        Embedder without a manual Export/Save step first -- same intent
        as the original app's always-on-disk working CSV (see
        CHANGELOG.md's 'Save button' entry)."""
        rows = [(p, self.results.get(p, {})) for p in self.completion_order
                if self.results.get(p, {}).get("status") == "done"]
        if not rows:
            return None
        d = _working_csv_dir()
        if not d:
            return None
        try:
            csv_path = os.path.join(d, "metazone_batch.csv")
            with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
                writer = csv.writer(f)
                writer.writerow(["Filename", "Title", "Description", "Keywords"])
                for p, r in rows:
                    writer.writerow([os.path.basename(p), r.get("title", ""),
                                      r.get("desc", ""), r.get("kw", "")])
            self.last_csv_path = csv_path
            self.last_common_folder = self._common_folder()
            return csv_path
        except Exception:
            return None

    def _auto_csv_path(self, folder):
        """v0.8.5: builds the "#FolderName.csv" filename requested for
        the auto/manual downloadable CSV.
        v0.8.9.2: this had drifted from that spec -- it was writing a
        leading number instead of "#" (e.g. "1_100 halloween
        flatlay.csv" instead of the requested "#100 halloween
        flatlay.csv"). Fixed to use a literal "#" prefix for the first
        export in a folder; a numbered "(n)" suffix only kicks in if
        that exact name is already taken, so repeated batches in the
        same folder still never silently overwrite an earlier export.
        This is intentionally separate from _write_working_csv's fixed
        "metazone_batch.csv" (an internal cache file solely for the
        Embed handoff, never meant to be user-facing)."""
        folder = folder or _working_csv_dir()
        base = os.path.basename(os.path.normpath(folder)) if folder else "MetaZone"
        base = base or "MetaZone"
        candidate = os.path.join(folder, f"#{base}.csv")
        if not os.path.exists(candidate):
            return candidate
        n = 2
        while True:
            candidate = os.path.join(folder, f"#{base} ({n}).csv")
            if not os.path.exists(candidate):
                return candidate
            n += 1

    def export_csv(self, dest_path=None):
        """v0.8.5: the real user-facing "Download CSV" -- manual (dest_path
        chosen via a save dialog by the caller) or automatic (dest_path=None,
        writes straight into the images' own common folder using the
        "#FolderName.csv" naming). Column layout follows whichever mode
        (meta vs prompt) this batch was actually run in, so a Prompt
        Generator export gets Filename/Prompt columns instead of
        Title/Description/Keywords."""
        rows = [(p, self.results.get(p, {})) for p in self.completion_order
                if self.results.get(p, {}).get("status") == "done"]
        if not rows:
            return {"ok": False, "error": "Nothing to export yet."}
        if not dest_path:
            folder = self._common_folder() or _working_csv_dir()
            if not folder:
                return {"ok": False, "error": "No folder to export into."}
            dest_path = self._auto_csv_path(folder)
        try:
            os.makedirs(os.path.dirname(dest_path) or ".", exist_ok=True)
            with open(dest_path, "w", newline="", encoding="utf-8-sig") as f:
                writer = csv.writer(f)
                if self.last_mode == "prompt":
                    writer.writerow(["Filename", "Prompt"])
                    for p, r in rows:
                        writer.writerow([os.path.basename(p), r.get("prompt", "")])
                else:
                    writer.writerow(["Filename", "Title", "Description", "Keywords"])
                    for p, r in rows:
                        writer.writerow([os.path.basename(p), r.get("title", ""),
                                          r.get("desc", ""), r.get("kw", "")])
            return {"ok": True, "path": dest_path}
        except Exception as e:
            return {"ok": False, "error": str(e)[:200]}

    def delete_card(self, path):
        """v0.8.9: per-card delete button under a card's thumbnail --
        removes one path entirely from the batch (results, completion
        order, import list, thumbnail cache) rather than just hiding
        it in the UI, so a deleted card can't reappear on a page
        reload/get_batch_state re-render, and a Regenerate click can
        never target it again. Rewrites the working CSV so the Embed
        handoff doesn't still include a card the user removed.

        v0.9.4.1: records exactly where `path` sat in all_paths and
        completion_order before removing it (see restore_card), so
        Undo can put it back in the same place instead of the end.
        """
        if path not in self.results:
            return {"ok": False, "error": "unknown path"}
        self.results.pop(path, None)
        self._deleted_positions[path] = {
            "all_paths_index": self.all_paths.index(path) if path in self.all_paths else None,
            "completion_order_index": self.completion_order.index(path) if path in self.completion_order else None,
        }
        if path in self.completion_order:
            self.completion_order.remove(path)
        if path in self.all_paths:
            self.all_paths.remove(path)
        self.thumb_cache.pop(path, None)
        if self.last_csv_path:
            self._write_working_csv()
        self._emit("card_removed", {"path": path})
        return {"ok": True}

    def delete_cards(self, paths):
        """v0.9.4: bulk sibling of delete_card, for 'Remove Selected'.
        Deliberately not just N calls to delete_card from the frontend
        -- that would fire N separate card_removed events, each
        re-rendering the grid once. This does all the bookkeeping in
        one pass and emits a single cards_removed event, so removing
        (say) 40 selected cards is one grid update, not 40.

        v0.9.4.1: same per-path position recording as delete_card,
        captured immediately before each individual removal (so each
        recorded index is relative to the list state at that exact
        moment in the loop -- correct as long as a later multi-item
        Undo restores them in the reverse of this method's own removal
        order; see restore_card's docstring and app.js's bulk-Undo
        handler, which does exactly that).
        """
        removed = []
        for path in paths:
            if path not in self.results:
                continue
            self.results.pop(path, None)
            self._deleted_positions[path] = {
                "all_paths_index": self.all_paths.index(path) if path in self.all_paths else None,
                "completion_order_index": self.completion_order.index(path) if path in self.completion_order else None,
            }
            if path in self.completion_order:
                self.completion_order.remove(path)
            if path in self.all_paths:
                self.all_paths.remove(path)
            self.thumb_cache.pop(path, None)
            removed.append(path)
        if removed and self.last_csv_path:
            self._write_working_csv()
        if removed:
            self._emit("cards_removed", {"paths": removed})
        return {"ok": True, "removed": removed}

    def restore_card(self, path, result):
        """v0.9.4.1: Undo for delete_card/delete_cards. Reinserts at the
        exact original index in all_paths (and, if applicable,
        completion_order) recorded by delete_card/delete_cards --
        previously this appended to the end instead, which restored a
        card visually in the right spot (the frontend keeps the actual
        DOM node) but silently reordered it in every backend structure,
        corrupting a fresh CSV export or anything reading all_paths/
        completion_order afterward. Falls back to appending only if no
        recorded position exists (e.g. a path restored without ever
        having gone through delete_card/delete_cards in this session).

        Multi-item Undo note: a recorded index is only valid against
        the list state at the moment it was captured. For a bulk
        delete_cards([B, D]) call, restoring must happen in the
        reverse of that removal order (D, then B) for both indices to
        land correctly -- see app.js's bulk-Undo handler, which
        restores its snapshots in reverse for exactly this reason.
        """
        if path in self.results:
            return {"ok": False, "error": "already present"}
        pos = self._deleted_positions.pop(path, None)
        ap_idx = pos.get("all_paths_index") if pos else None
        co_idx = pos.get("completion_order_index") if pos else None

        if ap_idx is not None and ap_idx <= len(self.all_paths):
            self.all_paths.insert(ap_idx, path)
        else:
            self.all_paths.append(path)

        self.results[path] = result

        if result.get("status") in ("done", "failed"):
            if co_idx is not None and co_idx <= len(self.completion_order):
                self.completion_order.insert(co_idx, path)
            else:
                self.completion_order.append(path)

        if self.last_csv_path:
            self._write_working_csv()
        return {"ok": True}

    def regenerate_one(self, path, mode, options, prefs):
        """v0.8.9: per-card regenerate button under a card's thumbnail
        -- re-runs generation for exactly this one path, reusing the
        exact same _gen_thread/process_one pipeline a full batch uses
        (targets=[path]), so parsing/sanitization/retry logic can't
        drift between a full run and a single-card regenerate. The
        card's position in completion_order is preserved (process_one
        only appends a path if it isn't already there), matching the
        \"cards never move once placed\" rule."""
        if path not in self.results:
            return {"ok": False, "error": "unknown path"}
        if self.running:
            return {"ok": False, "error": "A generation is already running"}
        self.results[path] = {"status": "waiting"}
        self._emit("card_update", {"path": path, "result": self.results[path]})
        self.stop_flag = False
        self.paused = False
        self.gen_epoch += 1
        epoch = self.gen_epoch
        self.running = True
        threading.Thread(target=self._gen_thread, args=([path], epoch, mode, options, prefs),
                          daemon=True).start()
        return {"ok": True}

    def update_field(self, path, field, value):
        """A single card's title/description/keywords was hand-edited
        via the pencil icon (or a Paste button) on the Meta Generator
        grid. Updates in-memory state and, if this batch already has a
        working CSV on disk, rewrites it too, so the Embed popup always
        reflects whatever's actually on screen."""
        if field not in ("title", "desc", "kw", "prompt"):
            return {"ok": False, "error": "unknown field"}
        if path not in self.results:
            return {"ok": False, "error": "unknown path"}
        self.results[path][field] = value
        if self.last_csv_path:
            self._write_working_csv()
        return {"ok": True}

    # ---- generation ----
    def start_generation(self, mode, options, prefs):
        targets = [p for p in self.all_paths
                   if self.results.get(p, {}).get("status") in ("waiting", "failed", "stopped")]
        return self._start_targets(targets, mode, options, prefs)

    def start_generation_for_paths(self, paths, mode, options, prefs):
        """v0.9.4: explicit-target-list sibling of start_generation, for
        the new selection-based actions -- 'Generate Selected' (any
        selection, any status, mirroring regenerate_one's existing
        "regenerate a done card is fine" precedent) and 'Retry Failed'
        (frontend passes just the paths it already knows are failed,
        no new backend bookkeeping needed for that distinction). Shares
        every guard/bookkeeping step with start_generation via
        _start_targets rather than duplicating them."""
        targets = [p for p in paths if p in self.results]
        return self._start_targets(targets, mode, options, prefs)

    def _start_targets(self, targets, mode, options, prefs):
        if self.running:
            return {"ok": False, "error": "Generation already running"}
        if not targets:
            return {"ok": False, "error": "Nothing to generate"}
        self.stop_flag = False
        self.paused = False
        self.gen_epoch += 1
        epoch = self.gen_epoch
        self.running = True
        self.batch_complete = False  # a fresh run in progress -- Embed hides again until this one finishes naturally

        threading.Thread(target=self._gen_thread, args=(targets, epoch, mode, options, prefs),
                          daemon=True).start()
        return {"ok": True, "total": len(targets)}

    def _vector_call(self, path, prefs, tc, dc, kn, custom, single_kw, avoid_copyright, include_desc, status_cb):
        """Real vector pipeline for one file: structural read -> real
        render -> vector-flavored prompt (real structural facts
        injected as mandatory context) -> the same call_with_failover
        every image call already uses. Returns
        (raw, provider, model_id, key_idx, send_arg, prompt_used,
        cleanup_fn) -- same shape process_one already expects, so
        parsing/sanitization/commit below it needs zero changes.
        Errors propagate up to process_one's existing except block
        (same failure path a normal image already has)."""
        structure, preview_path, render_error = _vector_detect_and_analyze(path, render_resolution=1024)
        if render_error:
            self._emit("status_text", {"msg": f"{os.path.basename(path)}: preview unavailable ({render_error[:80]}) — using file data only"})
        prompt_used = build_vector_meta_prompt(
            structure, title_c=tc, desc_c=dc, kw_n=kn, custom_prompt=custom,
            single_kw=single_kw, avoid_copyright=avoid_copyright, include_desc=include_desc,
            has_preview=preview_path is not None, filename=path,
        )
        try:
            # preview_path may be None (render failed) -- call_with_failover
            # already supports a text-only call when path is falsy, same
            # as the "no image" case elsewhere in this codebase.
            raw, provider, model_id, key_idx = call_with_failover(preview_path, prompt_used, prefs, status_cb=status_cb)
        except Exception:
            if preview_path and os.path.exists(preview_path):
                try:
                    os.remove(preview_path)
                except OSError:
                    pass
            raise
        if preview_path and os.path.exists(preview_path):
            try:
                with open(preview_path, "rb") as f:
                    self.thumb_cache[path] = base64.b64encode(f.read()).decode("ascii")
                self._emit("thumb_ready", {"path": path, "thumb": self.thumb_cache[path]})
            except OSError:
                pass

        def _cleanup():
            if preview_path and os.path.exists(preview_path):
                try:
                    os.remove(preview_path)
                except OSError:
                    pass

        return raw, provider, model_id, key_idx, preview_path, prompt_used, _cleanup

    def _video_call(self, path, prefs, tc, dc, kn, custom, single_kw, avoid_copyright, include_desc, status_cb):
        """Real video pipeline for one file: ffprobe technical read ->
        ffmpeg fixed-interval frame sampling -> ONE AI call with all
        sampled frames together (multi-image support already proven by
        Prompt-to-Prompt) -> video-flavored prompt with real technical
        facts injected as mandatory context. Same return shape as
        _vector_call above. Cleans up its own temp frame directory on
        any failure inside this method; on success, cleanup is deferred
        to the returned cleanup_fn since a keyword-count retry (see
        process_one) may still need to resend the same frames."""
        import shutil, tempfile
        technical = analyze_video_technical(path)
        work_dir = tempfile.mkdtemp(prefix="mze_video_")
        try:
            frames = extract_frames_fixed_interval(path, technical["duration_sec"], count=5, out_dir=work_dir)
            frame_paths = [p for _, p in frames]
            prompt_used = build_video_meta_prompt(
                technical, title_c=tc, desc_c=dc, kw_n=kn, custom_prompt=custom,
                single_kw=single_kw, avoid_copyright=avoid_copyright, include_desc=include_desc,
            )
            raw, provider, model_id, key_idx = call_with_failover(frame_paths, prompt_used, prefs, status_cb=status_cb)
        except Exception:
            shutil.rmtree(work_dir, ignore_errors=True)
            raise

        mid_frame = frame_paths[len(frame_paths) // 2] if frame_paths else None
        if mid_frame and os.path.exists(mid_frame):
            try:
                with open(mid_frame, "rb") as f:
                    self.thumb_cache[path] = base64.b64encode(f.read()).decode("ascii")
                self._emit("thumb_ready", {"path": path, "thumb": self.thumb_cache[path]})
            except OSError:
                pass

        def _cleanup():
            shutil.rmtree(work_dir, ignore_errors=True)

        return raw, provider, model_id, key_idx, frame_paths, prompt_used, _cleanup

    def _gen_thread(self, targets, epoch, mode, options, prefs):
        self.last_mode = mode
        self.auto_download_csv = bool(options.get("auto_download_csv", False))
        custom = options.get("custom", "")
        single_kw = options.get("single_kw", False)
        avoid_copyright = options.get("avoid_copyright", False)
        prefix = options.get("prefix", "") if options.get("prefix_on") else ""
        suffix_title = options.get("suffix", "") if options.get("suffix_on") else ""
        concurrency = max(1, min(20, int(options.get("concurrency", 4))))
        content_phrase = options.get("content_phrase", "")

        if mode == "meta":
            tc = int(options.get("title_chars") or 130)
            dc = int(options.get("desc_chars") or 200)
            kn = min(int(options.get("kw_count") or 49), 49)
            include_desc = options.get("include_desc", True)
            prompt = build_meta_prompt(tc, dc, kn, custom, single_kw, "", prefix,
                                        suffix_title, avoid_copyright, include_desc,
                                        content_phrase)
        else:
            # v0.9.3: frontend's Max Prompt Words control moved from a
            # free-drag 10-500 slider to a fixed 50/100/200/300/500/1000
            # dropdown -- this clamp's old 500 ceiling would have silently
            # capped the new 1000 option right back down to 500.
            mw = max(1, min(1000, int(options.get("max_words") or 500)))
            styles = [content_phrase] if content_phrase else []
            prompt = build_prompt_prompt(mw, styles, custom)

        total = len(targets)
        done_count_holder = {"n": 0}   # successes
        failed_count_holder = {"n": 0} # v0.9.4: tracked separately so
        # progress can report success/failed/processing instead of
        # just a single "done" number that silently excluded failures
        # (a batch with real failures used to look "stuck" below 100%
        # even once every item had actually been attempted, since only
        # successes incremented the counter that drove the bar).
        lock = threading.Lock()

        def process_one(path, i):
            if self.stop_flag or epoch != self.gen_epoch:
                return
            while self.paused and not self.stop_flag:
                time.sleep(0.3)
            if self.stop_flag or epoch != self.gen_epoch:
                return
            fname = os.path.basename(path)
            self.results[path] = {"status": "working"}
            self._emit("card_update", {"path": path, "result": self.results[path]})
            self._emit("task_progress", {
                "done": done_count_holder["n"], "total": total,
                "msg": f"[{i+1}/{total}] {fname}",
                "success": done_count_holder["n"], "failed": failed_count_holder["n"],
            })
            try:
                ext = os.path.splitext(path)[1].lower()
                cleanup_fn = None
                local_prompt = prompt
                # v0.9.7 Auto Detect dispatch: a real vector/video
                # extension ALWAYS routes to its own real engine here,
                # regardless of the File Type dropdown's selection --
                # the plain image engine literally cannot open these
                # formats (PIL/prepare_generation_preview would just
                # fail), so there's nothing a style-hint dropdown value
                # could sensibly override for them. Only 'meta' mode
                # (the Meta Generator page) has these engines wired in;
                # the Image-to-Prompt Generator page keeps its original
                # explicit rejection below, unchanged.
                if mode == "meta" and ext in VECTOR_EXTS:
                    raw, provider, model_id, key_idx, send_path, local_prompt, cleanup_fn = self._vector_call(
                        path, prefs, tc, dc, kn, custom, single_kw, avoid_copyright, include_desc,
                        status_cb=lambda msg: self._emit("status_text", {"msg": msg}))
                elif mode == "meta" and ext in VIDEO_EXTS:
                    raw, provider, model_id, key_idx, send_path, local_prompt, cleanup_fn = self._video_call(
                        path, prefs, tc, dc, kn, custom, single_kw, avoid_copyright, include_desc,
                        status_cb=lambda msg: self._emit("status_text", {"msg": msg}))
                elif ext in VECTOR_EXTS or ext in VIDEO_EXTS:
                    raise ValueError("Vector/video: convert to JPG first")
                else:
                    send_path = prepare_generation_preview(path)
                    raw, provider, model_id, key_idx = call_with_failover(
                        send_path, local_prompt, prefs,
                        status_cb=lambda msg: self._emit("status_text", {"msg": msg}))
                if epoch != self.gen_epoch:
                    return
                model_used = f"{provider} · {model_label(provider, model_id)}" + \
                             (f" ({key_idx})" if key_idx else "")
                self.last_provider = provider
                self.last_model = model_label(provider, model_id)

                if mode == "meta":
                    title, desc, kw = parse_meta(raw)
                    if not include_desc:
                        desc = ""
                    title = sanitize_text_punctuation(title)
                    if desc:
                        desc = sanitize_text_punctuation(desc)
                    kw = sanitize_keywords_punctuation(kw)
                    if prefix and not title.lower().startswith(prefix.lower()):
                        title = prefix + " " + title
                    if suffix_title and not title.lower().endswith(suffix_title.lower()):
                        title = title + " " + suffix_title
                    if content_phrase:
                        title = dedupe_content_phrase(title, content_phrase)
                    if len(title) > tc:
                        title = smart_trim(title, tc, must_include=content_phrase or None)
                    if single_kw:
                        kw = enforce_single_keywords(kw)
                    if avoid_copyright:
                        kw = _strip_copyright_keywords(kw)
                    kw_list = [k.strip() for k in kw.split(",") if k.strip()]
                    seen, deduped = set(), []
                    for k in kw_list:
                        lk = k.lower()
                        if lk not in seen:
                            seen.add(lk); deduped.append(k)
                    if kn > 0 and len(deduped) < kn * 0.7:
                        try:
                            retry_prompt = local_prompt + (
                                f"\n\nIMPORTANT CORRECTION: your previous attempt only "
                                f"produced {len(deduped)} keywords — that is NOT enough. "
                                f"You MUST output EXACTLY {kn} keywords this time, "
                                f"comma-separated, no fewer.")
                            raw2, _, _, _ = call_with_failover(send_path, retry_prompt, prefs,
                                                                status_cb=lambda msg: None)
                            _, _, kw2 = parse_meta(raw2)
                            kw2 = sanitize_keywords_punctuation(kw2)
                            if single_kw:
                                kw2 = enforce_single_keywords(kw2)
                            if avoid_copyright:
                                kw2 = _strip_copyright_keywords(kw2)
                            kw2_list = [k.strip() for k in kw2.split(",") if k.strip()]
                            seen2, deduped2 = set(), []
                            for k in kw2_list:
                                lk = k.lower()
                                if lk not in seen2:
                                    seen2.add(lk); deduped2.append(k)
                            if len(deduped2) > len(deduped):
                                deduped = deduped2
                        except Exception:
                            pass
                    kw = ", ".join(deduped[:kn])
                    # v0.8.7: re-check right before commit -- the
                    # undercount-keyword retry above makes a second,
                    # slow network call, so epoch can have gone stale
                    # (Stop/Clear All) since the first check at the top
                    # of this try block. Without this, a stopped/cleared
                    # generation's stale worker could still write a
                    # "done" result into a brand-new batch's self.results.
                    if epoch != self.gen_epoch:
                        return
                    self.results[path] = {"status": "done", "title": title, "desc": desc,
                                           "kw": kw, "model_used": model_used}
                else:
                    # v0.8.7: max_words was previously only a suggestion in
                    # the prompt text -- never actually enforced on the
                    # returned text, so a model going long produced a
                    # prompt over the stated cap. enforce_word_cap is the
                    # hard backstop (word-count counterpart to smart_trim
                    # above, which only handles character caps).
                    if epoch != self.gen_epoch:
                        return
                    prompt_text = raw.strip()
                    word_count = len(prompt_text.split())
                    target_lo = max(int(mw * 0.85), min(mw, 8))
                    # Part 7: hard max (enforce_word_cap below) is separate
                    # from *target* length -- when the model comes back
                    # well under the 85% target, do one bounded,
                    # image-grounded expansion retry before falling back
                    # to what we have. Same shape as the meta-mode
                    # keyword-undercount retry above: single retry, never
                    # loop, silently keep the original on any failure.
                    if word_count < target_lo:
                        try:
                            expand_prompt = (
                                f"Here is a partial AI image-generation prompt describing "
                                f"the reference image:\n\n\"{prompt_text}\"\n\n"
                                f"Expand the prompt using ONLY additional relevant, "
                                f"visually grounded details actually supported by the "
                                f"reference image. Do not invent objects, people, actions, "
                                f"locations, brands, or concepts. Produce a complete "
                                f"finished prompt and remain within {mw} words maximum. "
                                f"Output ONLY the finished prompt text.")
                            raw2, _, _, _ = call_with_failover(
                                send_path, expand_prompt, prefs, status_cb=lambda msg: None)
                            if epoch != self.gen_epoch:
                                return
                            expanded = raw2.strip()
                            if len(expanded.split()) > word_count:
                                prompt_text = expanded
                        except Exception:
                            pass
                    if epoch != self.gen_epoch:
                        return
                    prompt_text = enforce_word_cap(prompt_text, mw)
                    self.results[path] = {"status": "done", "prompt": prompt_text,
                                           "model_used": model_used}
                with lock:
                    done_count_holder["n"] += 1
            except Exception as e:
                # v0.8.7: a stale worker's API call can also fail (e.g.
                # the provider errors out after Stop/Clear All was
                # already pressed) -- must not write a "failed" card
                # into a generation that's no longer current either.
                if epoch != self.gen_epoch:
                    return
                self.results[path] = {"status": "failed", "error": str(e)[:200]}
                with lock:
                    failed_count_holder["n"] += 1
            finally:
                # v0.9.7: vector's rendered preview PNG / video's
                # extracted-frame temp dir must outlive the keyword-
                # retry call above (which may resend the same
                # send_path), so cleanup is deferred to here -- the one
                # place that runs after every exit from this file's
                # processing, success or failure, instead of littering
                # cleanup calls at each individual return point.
                if cleanup_fn is not None:
                    cleanup_fn()

            # Final gate: everything below mutates shared, generation-
            # scoped state (completion_order/emit) and must never run
            # for a stale worker, even though the two commit points
            # above already re-checked epoch individually.
            if epoch != self.gen_epoch:
                return
            if path not in self.completion_order:
                self.completion_order.append(path)
            self._emit("card_update", {"path": path, "result": self.results[path]})
            # v0.9.4: success/failed reported alongside the existing
            # done/total pair (kept for backwards compatibility with
            # anything still reading just those two) so the frontend
            # can show a real success/failed/processing breakdown
            # instead of one number that silently excluded failures.
            self._emit("task_progress", {
                "done": done_count_holder["n"] + failed_count_holder["n"], "total": total,
                "success": done_count_holder["n"], "failed": failed_count_holder["n"],
            })

        def _on_all_done():
            # v0.8.7: TaskManager waits for every submitted future
            # (including ones already in flight when Stop/Clear All was
            # pressed) before calling this, so it can fire well after
            # this generation was invalidated. Without this check, a
            # Stop followed by the in-flight requests finishing would
            # still flip running/batch_complete back on and emit
            # task_completed as if the batch had finished naturally --
            # exactly the "STOPPED reported as natural completion" bug.
            if epoch != self.gen_epoch:
                return
            self.running = False
            # Only a natural full completion (never Stop) reaches here --
            # matches the original app's "Embed button shown only after a
            # full, natural generation completion" rule.
            self.batch_complete = True
            self._write_working_csv()
            if self.auto_download_csv:
                # Best-effort: a failed auto-download (e.g. the common
                # folder became unwritable/removable-drive was ejected)
                # should never take down the completion event itself --
                # the internal working CSV above already succeeded and
                # the manual "Download CSV" button is still available.
                try:
                    self.export_csv()
                except Exception:
                    pass
            self._emit("task_completed", {"total": total})

        self.task_mgr.run_batch(targets, process_one, max_workers=concurrency,
                                 on_all_done=_on_all_done)

    def pause(self):
        if not self.running:
            return {"ok": False}
        self.paused = not self.paused
        return {"ok": True, "paused": self.paused}

    def stop(self):
        # v0.8.7 fix: this used to only set stop_flag, but every
        # post-API-return commit point in process_one checked epoch,
        # not stop_flag (the pre-call checks checked both). Since
        # gen_epoch was never bumped here, a request already in flight
        # when Stop was pressed would return, find epoch unchanged, and
        # still commit its "done" result -- the exact
        # "Stop pressed -> in-flight request returns -> old result still
        # committed" race described in the spec. Bumping gen_epoch here
        # makes Stop use the same single invalidation mechanism as
        # Clear All and a fresh Start: any worker still holding the old
        # epoch value is stale from this point on, at every check point.
        self.gen_epoch += 1
        self.stop_flag = True
        for p in self.all_paths:
            if self.results.get(p, {}).get("status") in ("waiting", "working"):
                self.results[p] = {"status": "stopped"}
        self.running = False
        return {"ok": True}


def make_thumb_b64(path, size=(160, 160)):
    """Plain-PIL replacement for core/utils.py's make_thumb, which
    returns a ctk.CTkImage (no browser equivalent). Same intent
    (bounded thumbnail for the card grid), different output shape:
    a base64 PNG data-URI body for an <img> tag."""
    if Image is None:
        return None
    try:
        ext = os.path.splitext(path)[1].lower()
        if ext in VECTOR_EXTS or ext in VIDEO_EXTS:
            return None  # no PIL-renderable preview; frontend shows a file-type icon instead
        with Image.open(path) as im:
            im = im.convert("RGB")
            im.thumbnail(size)
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=82)
            return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:
        return None
