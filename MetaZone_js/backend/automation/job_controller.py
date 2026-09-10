"""AutomationController -- the real sequential processing engine for
the Automation Queue (spec items 11-23). Calls session.py's Session
and embedder.py's EmbedSession directly, the same way Meta Generator
and the Embed page already do -- never drives their UI, never
simulates progress.
"""
import threading
import time

from session import Session
from embedder import EmbedSession
from core import config as core_config
import bridge as bridge_mod

# Embed defaults -- the same defaults embedder.py's own _embed_thread
# already falls back to (see its options.get(..., True/False) calls),
# not invented here. Automation always runs with these; a folder-
# level override isn't exposed yet (matches: "don't invent settings").
EMBED_DEFAULTS = {
    "subfolders": True,
    "match_ext_only": True,
    "remove_progressive": True,
    "remove_copyright": True,
    "replace_filename": False,
}

# Session's CSV export always writes exactly these four headers (see
# session.py's export_csv) -- known, not guessed, so no need to run
# EmbedSession's _guess_columns heuristic for a CSV this app wrote.
CSV_COLUMNS = {"filename": "Filename", "title": "Title",
               "description": "Description", "keywords": "Keywords"}

_POLL_SEC = 0.4


class AutomationController:
    def __init__(self, queue):
        self.queue = queue
        self.running = False
        self.paused = False
        self.stop_flag = False
        self.current_job_id = None
        self.queue_started_at = None
        self.queue_finished_at = None
        self._lock = threading.Lock()
        self._folder_started_at = None
        self._folder_durations = []  # completed folders' elapsed seconds, for the ETA
        self.last_report = None

    # ---- state for the UI ----
    def status_dict(self):
        eta = self._estimate_remaining()
        return {
            "running": self.running,
            "paused": self.paused,
            "current_job_id": self.current_job_id,
            "queue_started_at": self.queue_started_at,
            "queue_finished_at": self.queue_finished_at,
            "avg_folder_seconds": (sum(self._folder_durations) / len(self._folder_durations))
                                   if self._folder_durations else None,
            "estimated_remaining_seconds": eta,
            "last_report": self.last_report,
        }

    def _estimate_remaining(self):
        # Real average of folders actually completed THIS run -- never
        # a static/invented number (spec item 15). None (shown as
        # "Calculating estimate..." by the frontend) until at least one
        # folder has finished, since one data point isn't a real average.
        if not self._folder_durations or not self.running:
            return None
        avg = sum(self._folder_durations) / len(self._folder_durations)
        remaining_jobs = [j for j in self.queue.jobs if j.status in ("waiting", "interrupted")]
        return avg * len(remaining_jobs)

    def _emit_state(self):
        bridge_mod.emit("automation_state", {**self.queue.to_dict(), "controller": self.status_dict()})

    # ---- controls (spec items 16, 17) ----
    def start(self):
        with self._lock:
            if self.running:
                return {"ok": False, "error": "Queue is already running."}
            pending = [j for j in self.queue.jobs if j.status in ("waiting", "interrupted", "error")]
            if not pending:
                return {"ok": False, "error": "Nothing to process — add a folder first."}
            self.running = True
            self.paused = False
            self.stop_flag = False
            self.queue_started_at = time.time()
            self.queue_finished_at = None
            self._folder_durations = []
            self.last_report = None
            threading.Thread(target=self._run, daemon=True).start()
            self._emit_state()
            return {"ok": True}

    def pause(self):
        if not self.running:
            return {"ok": False, "error": "Queue isn't running."}
        self.paused = not self.paused
        self._emit_state()
        return {"ok": True, "paused": self.paused}

    def stop(self):
        if not self.running:
            return {"ok": False, "error": "Queue isn't running."}
        self.stop_flag = True
        self.paused = False  # don't leave the loop stuck on a pause check
        return {"ok": True}

    def _wait_while_paused(self):
        while self.paused and not self.stop_flag:
            time.sleep(0.3)

    # ---- Completion report (spec item 23) ----
    def _build_report(self):
        total_files = successful = failed = csv_count = 0
        embed_success = embed_errors = 0
        for job in self.queue.jobs:
            total_files += job.progress.get("total", 0)
            successful += job.progress.get("done", 0)
            failed += job.progress.get("failed", 0)
            if job.csv_path:
                csv_count += 1
            if job.embed_summary is not None:
                if job.embed_summary.get("not_embedded", 0) > 0:
                    embed_errors += 1
                else:
                    embed_success += 1
        completed = sum(1 for j in self.queue.jobs if j.status == "done")
        seconds = None
        if self.queue_started_at and self.queue_finished_at:
            seconds = self.queue_finished_at - self.queue_started_at
        return {
            "folders_total": len(self.queue.jobs),
            "folders_completed": completed,
            "total_files": total_files,
            "successful": successful,
            "failed": failed,
            "total_seconds": seconds,
            "csv_generated": csv_count,
            "embed_success": embed_success,
            "embed_errors": embed_errors,
            "embed_attempted": embed_success + embed_errors,
            "stopped_early": self.stop_flag,
        }

    # ---- the engine (spec item 11: strictly sequential) ----
    def _run(self):
        try:
            for job in self.queue.jobs:
                if self.stop_flag:
                    break
                if job.status == "done":
                    continue  # never restart an already-completed folder (spec item 19)
                self._run_one_folder(job)
        finally:
            self.running = False
            self.current_job_id = None
            self.queue_finished_at = time.time()
            # A report is generated whenever a run ends, whether it ran
            # to completion or was stopped -- spec item 17: "preserve
            # useful status information after stopping", not just on a
            # clean finish.
            self.last_report = self._build_report()
            self._emit_state()

    def _fail(self, job, message):
        job.status = "error"
        job.error_message = message
        job.finished_at = time.time()
        job.current_step = None
        self.queue._save()
        self._emit_state()

    def _run_one_folder(self, job):
        self._wait_while_paused()
        if self.stop_flag:
            return

        self.current_job_id = job.id
        job.refresh_scan()  # spec item 11: re-read the folder now, not whatever it was at add-time
        job.status = "running"
        job.error_message = None
        job.csv_path = None
        job.embed_summary = None
        job.started_at = time.time()
        job.finished_at = None
        job.progress = {"done": 0, "failed": 0, "total": job.file_count}
        job.current_step = "Scanning folder"
        self._folder_started_at = time.time()
        self.queue._save()
        self._emit_state()

        if not job.exists:
            return self._fail(job, "Folder no longer exists.")
        if job.file_count == 0:
            return self._fail(job, "No supported files found in this folder.")

        prefs = core_config.load_prefs()
        session = Session(event_prefix="automation_")
        add_res = session.add_paths(job.files)
        accepted = add_res.get("accepted", [])
        if not accepted:
            return self._fail(job, "None of this folder's files could be imported.")

        gen_options = dict(job.options)
        # The controller exports the CSV itself below (to reliably
        # capture the real destination path) rather than letting
        # Session's own auto_download_csv fire -- see the CSV section
        # further down for why running both would double-export.
        gen_options["auto_download_csv"] = False
        mode = gen_options.get("mode", "meta")
        job.current_step = "Generating metadata"
        session.start_generation_for_paths(accepted, mode, gen_options, prefs)

        # Poll rather than hook into Session's internal event system --
        # Session already emits its own automation_task_progress /
        # automation_card_update events (event_prefix="automation_")
        # for the live monitor to render directly; this loop is only
        # how the controller itself learns when to move on.
        while session.running:
            if self.stop_flag:
                session.stop()
                break
            self._wait_while_paused()
            done = sum(1 for r in session.results.values() if r.get("status") == "done")
            failed = sum(1 for r in session.results.values() if r.get("status") in ("failed", "stopped"))
            job.progress = {"done": done, "failed": failed, "total": len(accepted)}
            self._emit_state()
            time.sleep(_POLL_SEC)

        done = sum(1 for r in session.results.values() if r.get("status") == "done")
        failed = sum(1 for r in session.results.values() if r.get("status") in ("failed", "stopped"))
        job.progress = {"done": done, "failed": failed, "total": len(accepted)}

        if self.stop_flag:
            job.status = "stopped"
            job.finished_at = time.time()
            job.current_step = None
            self.queue._save()
            self._emit_state()
            return

        if done == 0:
            return self._fail(job, f"Generation failed for all {failed} file(s).")

        # ---- CSV (spec item 21) ----
        if job.options.get("auto_download_csv", True) or job.options.get("auto_embed", False):
            job.current_step = "Saving CSV"
            self._emit_state()
            # A CSV is written into the folder either because the user
            # asked for one directly, or because Auto Embed needs one
            # to read from -- there's no embed path that doesn't start
            # from a CSV, same as the Embed page today.
            csv_res = session.export_csv(dest_path=None)
            if csv_res.get("ok"):
                job.csv_path = csv_res["path"]
            else:
                job.error_message = f"CSV export failed: {csv_res.get('error')}"

        # ---- Embed (spec item 22) ----
        if job.options.get("auto_embed", False):
            if not job.csv_path:
                job.error_message = _append(job.error_message,
                    "Auto Embed skipped: no CSV was available to embed from.")
            else:
                embed_sess = EmbedSession(event_prefix="automation_")
                load_res = embed_sess.load_csv(job.csv_path)
                if load_res.get("ok"):
                    job.current_step = "Embedding metadata"
                    self._emit_state()
                    embed_sess.set_folder(job.path)
                    embed_sess.start_embed(job.path, CSV_COLUMNS, EMBED_DEFAULTS)
                    while embed_sess.running:
                        # Known limitation: EmbedSession has no stop()
                        # of its own (see embedder.py), so Stop can't
                        # interrupt an embed pass already in progress --
                        # it finishes on its own, then the queue halts
                        # before starting the next folder.
                        self._wait_while_paused()
                        time.sleep(0.3)
                    # embedder.py's own success/fail counts are local
                    # to its emit-only internals, not stored on the
                    # object -- rather than duplicating that counting
                    # logic here (the separation principle this project
                    # follows warns against a second implementation),
                    # dry_run re-reads the files' real embedded Title
                    # tags afterward for an honest, non-fabricated
                    # summary.
                    post = embed_sess.dry_run(job.path, CSV_COLUMNS, EMBED_DEFAULTS)
                    if post.get("ok"):
                        c = post["counts"]
                        job.embed_summary = {
                            "embedded": c.get("already_embedded", 0),
                            "not_embedded": c.get("matched", 0),
                            "missing_image": c.get("missing_image", 0),
                            "unsupported": c.get("unsupported", 0),
                        }
                        if c.get("matched", 0) > 0:
                            job.error_message = _append(job.error_message,
                                f"{c['matched']} file(s) weren't embedded.")
                else:
                    job.error_message = _append(job.error_message,
                        f"Auto Embed skipped: couldn't read the CSV ({load_res.get('error')}).")

        if failed:
            job.error_message = _append(job.error_message, f"{failed} of {len(accepted)} file(s) failed to generate.")

        job.status = "done"
        job.finished_at = time.time()
        job.current_step = None
        self._folder_durations.append(job.finished_at - self._folder_started_at)
        self.queue._save()
        self._emit_state()


def _append(existing, msg):
    return f"{existing} {msg}" if existing else msg
