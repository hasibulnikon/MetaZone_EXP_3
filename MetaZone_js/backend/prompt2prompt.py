"""
prompt2prompt.py — Stage 5 batch 2: thin bridge around the real,
unmodified `prompt_to_prompt.engine.PromptToPromptEngine`.

PromptToPromptEngine expects an `app`-like object with a few
attributes (`.prefs`, `._task_mgr`, `.ai_concurrency_var` — a Tk
IntVar-shaped thing with `.get()`, `._last_ai_provider`/
`._last_ai_model`). Rather than modify the engine to remove that
coupling, `_AppShim` below duck-types exactly what it reads, so the
real engine code runs completely unchanged.

v0.8.7: Image-to-Prompt mode (source_image=...) is now wired up --
the underlying engine already supported it (accepts source_image /
target_words and routes to build_image_to_prompts_prompt with the
downscaled-preview vision call path), it just was never passed
through from this session/bridge layer. P2PImageStore below manages
the up-to-15-image slot list the "From Image" tab needs (add/remove/
clear + background-thread thumbnails), independent of the main
Session class in session.py since this isn't a per-file
generate-a-result batch — it's a single shared reference set sent
together in one call.
"""
import os
import threading

from workers.task_manager import TaskManager
from core.config import load_prefs
from core.utils import wait_stable_and_validate_image, clear_shared_temp_data
from core.constants import IMAGE_EXTS
from prompt_to_prompt.engine import PromptToPromptEngine
from session import make_thumb_b64

import bridge


class _ConcurrencyVar:
    """Duck-types the .get() the engine expects from a Tk IntVar."""
    def __init__(self, value):
        self._value = value
    def get(self):
        return self._value


class _AppShim:
    """Duck-types exactly the attributes PromptToPromptEngine reads
    from the real App class -- nothing more."""
    def __init__(self, prefs, concurrency):
        self.prefs = prefs
        self._task_mgr = TaskManager()
        self.ai_concurrency_var = _ConcurrencyVar(concurrency)
        self._last_ai_provider = None
        self._last_ai_model = None


MAX_P2P_IMAGES = 15


class P2PImageStore:
    """The up-to-15-image reference set for P2P's "From Image" tab.
    Deliberately not session.py's Session class -- there's no per-file
    result/card here, just a shared ordered list of reference paths
    sent together in a single vision call."""

    def __init__(self):
        self.paths = []
        self.thumb_cache = {}

    def add_paths(self, paths):
        accepted, rejected = [], []
        # v0.9.x fix (Part 19/9): same within-batch duplicate gap as
        # Session.add_paths above -- 'p in self.paths' only caught
        # duplicates against already-added images, not duplicate
        # entries within the same incoming 'paths' list. seen_this_call
        # tracks both so two copies of the same file dropped/browsed
        # together can't both slip past the "Already added" check.
        seen_this_call = set(self.paths)
        for p in paths:
            if len(self.paths) + len(accepted) >= MAX_P2P_IMAGES:
                rejected.append((p, f"Limit is {MAX_P2P_IMAGES} images"))
                continue
            if p in seen_this_call:
                rejected.append((p, "Already added"))
                continue
            ext = os.path.splitext(p)[1].lower()
            if ext not in IMAGE_EXTS:
                rejected.append((p, "Unsupported file type"))
                continue
            ok, reason = wait_stable_and_validate_image(p)
            if not ok:
                rejected.append((p, reason))
                continue
            accepted.append(p)
            seen_this_call.add(p)
        self.paths.extend(accepted)
        threading.Thread(target=self._prefetch_thumbs, args=(accepted,), daemon=True).start()
        return {"accepted": accepted, "rejected": rejected, "paths": list(self.paths)}

    def _prefetch_thumbs(self, paths):
        for p in paths:
            b64 = make_thumb_b64(p)
            if b64:
                self.thumb_cache[p] = b64
                bridge.emit("p2p_image_thumb", {"path": p, "thumb": b64})

    def remove(self, path):
        if path in self.paths:
            self.paths.remove(path)
        self.thumb_cache.pop(path, None)
        return list(self.paths)

    def clear(self):
        self.paths = []
        self.thumb_cache = {}
        # v0.8.9: P2P's Reset is the "Clear All" for this page -- wipe
        # the same shared on-disk gen-preview/thumbnail/working-CSV
        # caches Meta Generator's Clear All already wipes (see
        # session.py's _cleanup_temp), so every clear/reset control in
        # the app leaves the app's temp footprint equally clean.
        # thumb_cache above is only this store's in-memory dict, not a
        # disk cache, so clearing it here is unrelated/additional.
        try:
            clear_shared_temp_data()
        except Exception:
            pass


class PromptToPromptSession:
    def __init__(self):
        self._engine = None
        self.running = False
        self.images = P2PImageStore()
        # v0.8.7: a generation-identity token, same concept as
        # session.py's gen_epoch. Each start() gets a fresh engine
        # instance already (so an old engine's stop_flag genuinely
        # belongs only to that run), but its callbacks are plain
        # lambdas bound straight to bridge.emit -- a batch already in
        # flight when Stop/Reset was pressed can still slip past the
        # engine's own stop_flag re-check (best-effort, checked at
        # specific points, not atomic with an in-flight HTTP call) and
        # fire p2p_partial/p2p_completed/p2p_error into the frontend.
        # Comparing the token each callback captured against the
        # session's *current* token at emit time is the final,
        # session-level guarantee that a stale run's events -- even
        # ones the engine itself failed to suppress -- can never reach
        # the UI once Stop/Reset/a new Start has moved the token on.
        self.run_token = 0

    def start(self, original_prompt, count, creativity, style, target_words, concurrency,
              source_image=None):
        if self.running:
            return {"ok": False, "error": "Already running"}
        if source_image and not self.images.paths:
            return {"ok": False, "error": "Add at least one reference image first"}
        prefs = load_prefs()
        shim = _AppShim(prefs, concurrency)
        engine = PromptToPromptEngine(shim)
        self._engine = engine

        self.run_token += 1
        token = self.run_token

        def _stale():
            return token != self.run_token

        engine.on_progress = lambda done, total, msg: (
            None if _stale() else
            bridge.emit("p2p_progress", {"done": done, "total": total, "msg": msg}))
        engine.on_partial = lambda prompts: (
            None if _stale() else
            bridge.emit("p2p_partial", {"prompts": prompts}))

        def _on_complete(prompts):
            if _stale():
                return
            self.running = False
            bridge.emit("p2p_completed", {"prompts": prompts})
        engine.on_complete = _on_complete

        def _on_error(msg):
            if _stale():
                return
            self.running = False
            bridge.emit("p2p_error", {"message": msg})
        engine.on_error = _on_error

        self.running = True
        images = list(self.images.paths) if source_image else None
        engine.start(original_prompt, count, creativity, style,
                     source_image=images, target_words=target_words)
        return {"ok": True}

    def pause(self):
        if not self._engine:
            return {"ok": False}
        paused = self._engine.toggle_pause()
        return {"ok": True, "paused": paused}

    def stop(self):
        # Bumping run_token here (not just calling engine.stop()) is
        # what makes this run "stale" for every callback check above,
        # even for a batch whose HTTP request was already in flight.
        self.run_token += 1
        if self._engine:
            self._engine.stop()
        self.running = False
        return {"ok": True}

    def reset(self):
        # v0.8.7: Reset = Stop + clear images/results. Bumping
        # run_token (via stop()) BEFORE clearing images means any
        # already-in-flight request from the old run that finishes
        # afterward is stale and cannot repopulate the just-cleared
        # state -- the UI is guaranteed to stay at "0 images / 0
        # prompts / Ready" even if that request lands milliseconds
        # later.
        self.stop()
        self.images.clear()
        return {"ok": True}
