# Changelog

## v0.9.8 — Deployment/runtime reliability: FFmpeg + Ghostscript bundling, testable Windows build

Pure deployment/runtime work, per explicit request — **no changes to
image, vector, video, Batch, or Embedder/EPS generation logic, and no
UI/design changes.** The only UI-adjacent touch is widening one error-
message truncation length (120→200 chars) in `session.py`'s shared
failure path, so the clearer dependency-missing messages below aren't
cut off mid-sentence — same code path every generation error (image
included) already went through, not new logic.

### v0.9.8 patch — fixed the `--diag` self-check itself

The dependency *bundling* described below (FFmpeg/Ghostscript/
ExifTool staging, `bin_finder.py`) was already correct. The self-check
added to verify it was not: the Windows CI job was failing with
`metazone_diag.txt was not created next to the exe` even when the exe
had written that file correctly. Two real bugs, both in the verification
path rather than the bundling itself:

- **`.github/workflows/build_js.yml`**: the self-check step checked
  for a bare `metazone_diag.txt` relative to the job's working
  directory (`MetaZone_js\`), but `app.py` writes it next to
  `sys.executable`, i.e. `MetaZone_js\dist\metazone_diag.txt`. Fixed
  to check `dist\metazone_diag.txt`, and the step now also fails
  (rather than silently passing) if `--diag` exits 0 without writing
  the report at all.
- **`app.py`**: `--diag` was handled at the very bottom of the file,
  *after* `import webview` and the full `bridge.py` import chain
  (`session.py`, `embedder.py`, `engine/ai_providers.py`,
  `automation/*`, `dashboard.py`, ...). Any unrelated import failure
  anywhere in that chain crashed the process before `--diag` ever ran
  — no report written, non-zero exit, indistinguishable in CI logs
  from a genuine missing-dependency failure. `--diag` is now handled
  immediately after `sys.path` is set up for `backend/`, before any of
  those heavier imports, so the four-dependency check only depends on
  `core.utils`/`core.bin_finder` (pure stdlib + PIL) actually being
  importable. Report format also tightened to the requested
  `Name: PASS — path` / `Name: MISSING — looked in: ...` shape, always
  naming every path it checked.

**1. FFmpeg — bundled.** `.github/workflows/build_js.yml` now
downloads `BtbN/FFmpeg-Builds`' **LGPL, shared** Windows build (pinned
to their floating `latest` release tag), stages `ffmpeg.exe`,
`ffprobe.exe`, and their required DLLs into `ffmpeg_pkg/`, and adds it
to the PyInstaller bundle via `--add-data`. LGPL/shared chosen
deliberately over GPL/static: MetaZone only ever does fixed-interval
PNG frame extraction + ffprobe reads (never encoding/muxing), so it
doesn't need GPL-only codecs, and "shared" (DLLs alongside small exes)
trivially satisfies LGPL's relinking requirement. `core/bin_finder.py`
(already written in an earlier batch, now actually wired up by CI)
was already set up to find `ffmpeg_pkg/ffmpeg.exe` first before
falling back to PATH — no changes needed there.

**2. Ghostscript — bundled**, with a documented, honest gap. Official
Windows Ghostscript ships as an NSIS installer, not a plain zip; the
workflow now downloads it and extracts its payload directly via
7-Zip (already present on `windows-latest` runners) **without ever
running/installing it**, staging `bin/gswin64c.exe`, `bin/gsdll64.dll`,
`Resource/`, `lib/`, `iccprofiles/` into `gs_pkg/`. `vector/renderer.py`
now passes explicit `-I<Resource> -I<lib> -sICCProfilesDir=<icc>`
flags when running the bundled copy, instead of trusting Ghostscript's
own relative-to-exe path auto-detection. Licensing: Ghostscript is
AGPLv3 (or a paid Artifex commercial license); bundling an unmodified
upstream binary that's invoked as a separate subprocess is "mere
aggregation," not linking, so this doesn't put MetaZone itself under
AGPL — its license file is copied alongside it in `gs_pkg/` for
redistribution. **What's real vs. not:** the download URL, the 7-Zip
extraction, and the resulting file layout were all verified for real
in a sandbox (real HTTP 200, real `7z x`, real resulting folder
sizes/contents — see verification section). What's **not** verified:
whether `gswin64c.exe` actually renders correctly with those flags
when invoked from inside a PyInstaller onefile bundle on real Windows
— no Windows machine was available to check that specific step.

**3. Windows build made actually testable**, not just "builds
without erroring":
   - Added `--diag` CLI flag to `app.py` — runs a plain dependency
     check (ExifTool/ffmpeg/ffprobe/Ghostscript: found, and from
     where) and exits without opening a window. Writes the same
     report to `metazone_diag.txt` next to the exe, since this is a
     `--windowed` (no console subsystem) build and plain stdout from
     a launched .exe isn't reliably visible to a CI step that just
     invokes it.
   - New CI step **actually runs the just-built `MetaZone.exe --diag`**
     and fails the workflow if any of the four dependencies expected
     to be bundled aren't found — this is the part that turns "PyInstaller
     didn't error and a .exe file exists" into a real, if partial,
     smoke test of the produced artifact.
   - Added `--collect-all=pymupdf` and `--collect-all=lxml` to the
     PyInstaller args (same reasoning `--collect-all=Pillow` was
     already there for): `backend/` is bundled as plain `--add-data`,
     not import-analyzed by PyInstaller, so these two compiled-
     extension packages (the Vector engine's real dependencies) would
     otherwise silently fail to import on a clean machine despite
     `pip install -r requirements.txt` succeeding in the same CI job.
   - No hardcoded local dev paths were found in the existing workflow
     or `app.py`'s resource resolution (`BASE_DIR`/`sys._MEIPASS`
     pattern was already correct); nothing to fix there.

**4. Graceful errors.** Largely already true going into this batch —
`video/technical.py`/`video/frames.py`/`vector/renderer.py`'s existing
`RuntimeError`s on a missing ffmpeg/ffprobe/gs already flow through
`session.py`'s existing per-file exception handling into a normal
`{"status": "failed", "error": ...}` card, same as any other
generation failure, never a crash. Only change here: the truncation
length noted above, so the full clear message survives.

### Verification
- `python3 -m py_compile` on every changed backend file
  (`bin_finder.py`, `vector/renderer.py`, `session.py`, `app.py`):
  clean. Regression suite: **18 passed, 1 skipped — unchanged**.
- **Real download verification** (not assumed): fetched the actual
  BtbN FFmpeg zip (HTTP 200, 73MB) and the actual Ghostscript NSIS
  installer (HTTP 200, 65MB) in this sandbox; ran real `unzip -l` /
  real `7z x` against them and confirmed the exact file layouts this
  workflow's staging steps depend on (`bin/ffmpeg.exe`,
  `bin/ffprobe.exe` + 7 DLLs; `bin/gswin64c.exe`, `bin/gsdll64.dll`,
  `Resource/`, `lib/`, `iccprofiles/`, ~43MB of the 65MB installer).
- **Real regression test**: re-ran `render_via_ghostscript` against a
  real `.eps` test file through the normal (non-frozen, system-`gs`)
  path — confirmed still renders correctly, and confirmed the fuller
  `detect_and_analyze` pipeline (structural read + render) still works
  end-to-end. The new `-I`/`-sICCProfilesDir` logic is skipped
  entirely on this path (`bundled_pkg_root` returns `None` when not
  frozen), so dev/Linux/macOS behavior is provably unchanged.
- **Real path-resolution test for the frozen/bundled case**: since an
  actual Windows machine isn't available here, simulated the frozen
  layout by setting `sys.frozen=True` / `sys._MEIPASS` to a real
  directory built with the *exact* structure the CI workflow stages
  (`ffmpeg_pkg/ffmpeg.exe`, `gs_pkg/bin/gswin64c.exe`,
  `gs_pkg/Resource`, etc.) and confirmed `find_bundled_binary`/
  `bundled_pkg_root` resolve every path correctly, and that
  `render_via_ghostscript` would construct the exact `-I`/
  `-sICCProfilesDir` command-line flags intended. This proves the
  Python-side logic is internally consistent with the staging layout,
  though it's still not the same as an actual Windows execution.
- **Not verified in this sandbox (no Windows machine available):**
  the full CI workflow end-to-end run itself; whether
  `Invoke-WebRequest`/`Expand-Archive`/`7z x` behave exactly as
  scripted inside GitHub's actual `windows-latest` runner; whether the
  bundled `gswin64c.exe` actually renders a real `.eps`/`.ai` file
  correctly when invoked this way from inside a real frozen onefile
  bundle. Recommend treating the first real run of this workflow, and
  the resulting EXE's Vector engine specifically, as the real test —
  the `--diag` smoke test will at least confirm the binaries were
  found before anyone gets to that point.

### Are FFmpeg and Ghostscript bundled, or still external dependencies?
**Both are bundled** by this workflow going forward — a user on a
clean Windows 11 machine should not need to install either one
separately. `requirements.txt`'s existing "install FFmpeg/Ghostscript
yourself" notes (from the previous batch) remain accurate as a
*fallback* description of what the bundled binaries actually are and
where they come from, and matter for anyone running from source
(`python app.py`) rather than a built EXE — bundling only applies to
the PyInstaller-built release, not source runs.



Phase 2 of the three-way merge. This batch touches **only** the
Generate page (`page-meta`) and its backend (`session.py`,
`core/constants.py`, `bridge.py`'s `browse_images`) — no other page
was changed, and normal JPG/PNG image generation itself is
byte-for-byte the same code path it was before, just re-routed through
a locally-scoped prompt variable so vector/video's own prompt could be
injected without touching the shared one (see below). Batch (v0.9.6)
is untouched. The EPS-10 embed fix is still separate, not-yet-started
work.

**Design note (changed from the source experiment):** the
Vector/Video experimental build implemented these as three separate
tabs with three separate card grids (Image/Vectors/Videos), not a
single Auto Detect grid — that's not what was asked for, so it wasn't
carried over as-is. What *was* carried over: the real engines
underneath (structural parsers, renderer, ffprobe/ffmpeg wrappers,
prompt builders) — copied in as new files, unchanged. What's new: the
actual per-file dispatch that makes Auto Detect real, built fresh
against this app's existing single-grid `session.py`.

**1. Real per-file engine dispatch, one grid.** `session.py`'s
`process_one` (the function every dropped file already goes through)
now checks each file's real extension: `.ai/.eps/.svg` → the real
vector engine, `.mp4/.mov` → the real video engine, everything else →
the unchanged image engine. This happens regardless of the File Type
dropdown's value — a real vector/video file can't be opened by the
plain image engine at all (PIL can't read it), so extension-based
routing is the only sensible default; "Vector File"/"Videos" as
dropdown entries exist as explicit, human-readable confirmation of
that same routing, not a second code path. Added `_vector_call`/
`_video_call` helper methods that produce the exact same
`(raw, provider, model_id, key_idx)` shape the image path already
produces, so every line of parsing/sanitization/keyword-retry/commit
logic below the dispatch point needed **zero changes** — a vector or
video result is written into `self.results[path]` in the identical
shape an image result is, which is what makes the existing card
component render it identically, unchanged.

**2. Real engines, not placeholders.**
   - Vector (`vector/`): real structural read (SVG via `lxml`,
     PDF-compatible `.ai` and legacy `.ai`/`.eps` via `pymupdf` /
     PostScript header parsing), real PNG render for the AI call, with
     a graceful text-only fallback (real structural facts + filename,
     explicitly telling the AI no image was provided) if rendering
     fails locally (e.g. a Ghostscript issue on the user's machine) --
     a render failure never loses the whole file.
   - Video (`video/`): real `ffprobe` technical read (duration,
     resolution, fps, audio), real `ffmpeg` fixed-interval 5-frame
     extraction, all 5 frames sent together in **one** AI call (multi-
     image support already proven by Prompt-to-Prompt) rather than one
     call per frame.
   - Both real engines produce a real thumbnail (the rendered vector
     preview / the middle extracted video frame) cached and emitted
     through the exact same `thumb_ready` event image thumbnails
     already use — so vector/video cards get a real preview image, not
     a generic icon.

**3. `core/constants.py`: `CONTENT_SUFFIXES` reordered/relabeled** to
the exact requested list — Auto Detect, Vector Image Preview, Vector
File, Transparent PNG, White Background, Silhouette, Videos.
"Illustration" removed (not in the requested list); "Vector" renamed
to "Vector Image Preview" (unchanged behavior — still just a style
hint for an actual raster image, via the plain image engine). "Vector
File" and "Videos" carry no content-phrase text since real vector/
video files are always routed by extension regardless of this
dropdown's value (see #1). The dropdown itself needed no frontend
code change — it's already populated dynamically from this dict.

**4. Dropzone text updated** on the Generate page only (per spec, not
the separate Image-to-Prompt Generator page): "Click anywhere in this
box or just drag and drop files." + a formats line listing Ai, EPS,
SVG, JPG, PNG, MP4, MOV. `browse_images`'s native file-picker filter
gained `*.ai` (it already had svg/eps/mp4/mov, just was missing this
one extension).

**5. `requirements.txt`** gained `lxml` and `pymupdf` (real pip
dependencies for the vector engine) plus documented, non-pip system
binaries (`ffmpeg`/`ffprobe`, `Ghostscript`) with the exact install
commands for Windows/macOS/Debian — both degrade to a clear per-file
error rather than a hang or crash if missing on a given machine.

### Verification
- `python3 -m py_compile` on every new/changed backend file
  (`session.py`, `bridge.py`, `core/constants.py`,
  `vector/*.py`, `video/*.py`, `core/bin_finder.py`): clean.
- `node --check` on `app.js`: clean. Duplicate-id scan across
  `index.html`: none.
- Regression suite (`tests/test_regression.py`): **18 passed, 1
  skipped — unchanged**.
- **Real, non-mocked exercise of the actual engines** (only the
  network AI call itself was mocked, with its provider/token cost):
  installed `lxml`, `pymupdf`, `ffmpeg`, `ghostscript` in the sandbox;
  generated a real test `.svg` and a real test `.mp4` (via `ffmpeg`'s
  own `testsrc` filter); ran them through `Session.add_paths` →
  `start_generation('meta', ...)` for real. Confirmed: real SVG
  structural parse + real PyMuPDF render actually ran and produced a
  real PNG that was actually sent to the (mocked) AI call; real
  `ffprobe` read + real 5-frame `ffmpeg` extraction actually ran and
  sent 5 real frames as one multi-image call; both landed in
  `self.results` in the identical shape a normal image result has; no
  leaked temp files/dirs after generation (checked `/tmp` directly).
  Also ran a **mixed batch** (real `.jpg` + `.svg` + `.mp4` together,
  with a `content_phrase` set, simulating a "Silhouette" File Type
  selection) and confirmed the plain-image path still receives
  `content_phrase` in its prompt exactly as before — the dispatch
  refactor didn't change existing image-generation behavior.
- **Not verified in this sandbox:** on-screen rendering (same
  WebKitGTK limitation as v0.9.6 — see that entry); real AI-provider
  output quality for vector/video prompts (the actual network call was
  mocked in every test above, since no API key was available in this
  sandbox) -- the plumbing up to and including that call is real and
  verified, but the AI's actual answer quality should be checked with
  a real key before relying on it for real listings.

### Still open (not part of this batch)
- The EPS-10-specific metadata embed path + read-back verification
  (spec item 6) — separate, not started.



Phase 1 of the three-way merge (base v0.9.5 + Automation experiment +
Vector/Video experiment). This batch is **Batch only** — the Vector/Video
engines, the Generate page's File Type dropdown, and the EPS-10 embed
fix are separate, not-yet-started work (see below). Image generation
(Meta Generator page) is untouched.

**1. Batch is now a normal nav page, not a popup window.** The
Automation experiment's queue system previously only rendered inside
a `webview.create_window(...)` popup launched from a Dashboard button
(`open_automation_window` in `bridge.py`, `btnOpenAutomation` in
`automation.js`). Both are removed. `page-automation` (labeled "Batch"
in the sidebar and on the Dashboard) is now a `<section class="page">`
inside the existing `index.html`, shown/hidden by the same
`data-page` nav mechanism every other page already uses — no new
routing system. Its real filesystem drag-and-drop (`#automationDropzone`)
is now bound in `app.py`'s existing `_bind_real_drag_drop`, the same
place Embed's and P2P's dropzones are bound, instead of a
popup-specific binding.

**2. Universal Preset (new).** Per-folder preset/settings editing is
unchanged. Added a "🌐 Universal Preset" control that opens a modal
with the same fields as the per-folder settings modal; "Apply to All
Folders" pushes one set of options onto every folder currently in the
queue in a single call (`automation_apply_universal_preset` →
`AutomationQueue.apply_universal_preset`). A folder that's mid-run
when Universal Preset is applied is skipped rather than having its
in-flight options mutated (verified: `applied`/`skipped` id lists
returned and checked directly against the queue). Individual folders
can still be re-customized afterward through the existing per-folder
⚙ button — confirmed with a real update call after a universal apply.

**3. Backend: `automation/` package added** (`queue_manager.py`,
`job_controller.py`, `folder_job.py`, `presets.py`) — new files,
carried over from the Automation experiment unchanged except for the
new `apply_universal_preset` method. `bridge.py` gained the
`automation_*` API methods (state, start/pause/stop, add/remove/
reorder/duplicate folder, per-folder and universal preset apply,
resumable-queue check/load/discard, dry run) and now owns
`self.automation_queue` / `self.automation_controller` instances,
separate from the Meta Generator's `self.session`.

**4. `embedder.py`: added optional `event_prefix` to `EmbedSession`**
(default `""`) so the Batch queue's own `EmbedSession(event_prefix="automation_")`
instance can emit `automation_embed_log` / `automation_embed_progress`
/ `automation_embed_completed` without colliding with the Meta
Embedder page's own `embed_log` / `embed_progress` / `embed_completed`
events. Default value means every existing call site keeps its exact
original event names — **the JPEG/PNG embed pipeline itself is not
touched by this change.**

**5. Fixed a pre-existing id collision surfaced during integration:**
the Embed page already had a button with `id="btnDryRun"`; the new
Batch page's own Dry Run button was renamed to `id="btnAutomationDryRun"`
before merging (both are real, separate features — not a duplicate).

### Verification
- `python3 -m py_compile` on all new/changed backend files: clean.
- `node --check` on `automation.js`, `app.js`, `nav.js`: clean.
- Duplicate-`id` scan across the full `index.html`: none (the
  `btnDryRun` collision above was caught this way and fixed).
- Existing backend regression suite (`tests/test_regression.py`):
  **18 passed, 1 skipped — unchanged from pre-merge**, confirming
  nothing in Meta Generator/Embed/Dashboard/Settings broke.
- Real, non-mocked exercise of the new backend logic: instantiated
  `Api()`, added two real temp folders to the queue, applied a
  Universal Preset and confirmed both jobs' options updated; set one
  job to `status="running"` and confirmed Universal Preset correctly
  skipped it while updating the other; confirmed a per-folder override
  still works on top of a universal apply; confirmed the dropped-file
  → parent-folder fallback for `automation_add_folders_dropped`.
- **Not verified in this sandbox:** actual on-screen rendering of the
  Batch page (no WebKitGTK available to launch a real pywebview
  window here — `apt-get install webkit2gtk` 404'd against this
  sandbox's mirror). The HTML/CSS/JS is structurally verified (tag
  balance, unique ids, real class names reused from the
  Automation experiment's own working CSS) but the actual visual
  layout should be checked on your machine before relying on it.

### Still open (not part of this batch)
- Vector/Video generation engines, the Generate page's reordered File
  Type dropdown + Auto Detect routing, drag-drop text/format updates.
- The EPS-10-specific metadata embed path + read-back verification.
- These are large enough to warrant their own batch(es) rather than
  being rushed in alongside Batch — see chat for sequencing.



Two work items landed together in this release: a surgical maintenance
pass (originally scoped as v0.9.4.1 -- three real bugs fixed, a
regression test suite added) and a follow-up batch of smaller UI
requests found while testing v0.9.4. No redesign, no restructuring --
every change below is scoped to the specific issue it fixes.

### Maintenance fixes

**1. Test All event/request correlation (HIGH PRIORITY).** Root
cause: the backend already generated a proper `request_id` for each
Test All batch and tagged every `key_validated` event with it, but the
frontend's progress handler ignored that field entirely and
incremented on *any* `key_validated` event app-wide -- an unrelated
manual "Test" click on a single key (or a still-draining previous Test
All run) would silently corrupt the counter. Fixed using the existing
request-id mechanism (no second event system introduced): extracted
the correlation check into a small shared `BackendEvents.matchesRequest()`
helper in `events.js`, used by both the per-batch listener and the
completion handler. Also fixed a real listener-leak: `BackendEvents`
had no `off()` method at all, so every Test All click (or every
provider-tab render, for the completion listener) would leave another
listener attached forever. Added `off()`, made the Test All listener a
single tracked module-level slot (`activeTestAll`) so starting a new
run always tears down a previous one first. Verified with 11 dedicated
Node tests (`frontend/tests/test_event_correlation.js`) covering
unrelated-event isolation, out-of-order arrival, never-exceeds-total,
and two independently-tracked batches not leaking into each other --
plus a real Playwright click-through of the actual `settings.js` code.

**2. Undo ordering.** `restore_card()` previously just appended a
restored path to the end of `all_paths`/`completion_order`, so undoing
a delete of B in `A → B → C → D` produced `A → C → D → B` internally
(the frontend's own DOM reuse made it *look* right, but every backend
structure -- a fresh CSV export, remaining-count math -- would see the
wrong order). Fixed: `delete_card`/`delete_cards` now record each
path's exact original index in both lists before removing it;
`restore_card` reinserts at that recorded index instead of appending.
For bulk deletes, a multi-item undo is only correct if restored in the
reverse of its deletion order (worked example in `restore_card`'s
docstring) -- `app.js`'s bulk-Undo handler now does exactly that,
sequentially rather than firing all restores concurrently. Verified
with real functional tests for both the single-delete and bulk-delete
cases, matching the spec's own `A → B → C → D` example exactly.

**3. Dry Run "Already Embedded" detection -- added.** v0.9.4 explicitly
left this unimplemented, flagged as needing a per-file EXIF read that
seemed too heavy. Re-evaluated: ExifTool has always supported reading
many files in a single invocation (`-j`, JSON output), so this is one
batch subprocess call for every *matched* file, not one call per file
-- genuinely cheap. Added `core.utils.read_existing_titles_batch()`
and a new `already_embedded` category in `EmbedSession.dry_run()`
(files that are otherwise matched but already carry a non-empty
Title). New filter tab in the Dry Run panel. If the batch exiftool
call fails outright, affected files fall back to "matched" rather than
being misclassified either way. Verified against real files with real
ExifTool (installed in the test environment): tagged one file's Title
via exiftool, confirmed it's correctly classified, confirmed the
file's content and title are byte-for-byte unchanged after two dry_run
calls -- still 100% non-destructive.

**4. Automated regression suite -- added.** `backend/tests/test_regression.py`
(19 tests, plain stdlib `unittest`, no new dependency) covering
duplicate detection, import-order preservation under a deliberately
reversed-completion race, Generate Remaining / Retry Failed target
filtering, single- and bulk-delete Undo ordering, Clear-All epoch
protection, Dry Run classification (including the new Already-Embedded
path with real ExifTool, plus a no-exiftool fallback case), and
API-key persistence (nicknames, test-result status, Activate Valid
Keys, model enable/disable). `frontend/tests/test_event_correlation.js`
(11 tests, plain Node, no dependency) covers the Test All correlation
fix specifically, loading the real `events.js` rather than a
reimplementation of it. Run with:
```
cd backend && python3 -m unittest discover -s tests -v
node frontend/tests/test_event_correlation.js
```

**5. Regression protection.** Full `py_compile` pass across every
backend module, `node --check` across every frontend JS file, and a
scripted audit cross-referencing every `pywebview.api.*` call site
against `bridge.py`'s `Api` class -- zero missing methods, zero
duplicate definitions. `bridge.Api()` instantiation smoke test
confirms every pre-existing v0.9.4 bridge method is still present
alongside the new ones.

### New since v0.9.4 (found while testing)

**6. Model enable/disable per provider.** New gear-icon "Models"
button on the API Manager page, aligned with the provider tabs (top
right). Opens a panel listing every model each provider supports as a
toggle -- disabling a model only hides it from the Model Selection
dropdown, it's never removed from the app, and at least one model must
stay enabled per provider (enforced backend-side, not just a UI
suggestion). If the currently-selected model gets disabled, the
provider automatically falls back to the first still-enabled one
rather than leaving the dropdown pointed at a hidden option. New
`settings.set_model_enabled()` / `Api.set_model_enabled()`, new
`disabled_models` prefs key. Verified end-to-end with a real
Playwright click-through: toggled a model off, confirmed it vanished
from the live dropdown immediately.

**7. "Generate Selected" renamed to "Regenerate Selected"** in the
contextual selection toolbar.

**8. "Select All" added** to the selection toolbar, left of "Clear
Selection" -- selects every currently-rendered card. Only visible once
something is already selected, same as the rest of that toolbar.

**9. Progress breakdown merged onto one line.** The ✓/✕/⏳
successful/failed/processing chips used to sit on their own row above
the "Done -- N images processed" status line. Now both live in the
same `.status-row`, status text and chips grouped on the left, the
current-provider/model text still pinned right (unchanged from the
v0.9.3 fix that originally separated those two).

**10. Neon theme text contrast.** White text on solid cyan buttons
(active tabs, active filter/choice buttons, "Apply to All Keys", etc.)
was hard to read. Fixed to dark text for those *solid*-background
elements only -- the gradient buttons (`.btn-primary`, "Undo") already
used dark text and were untouched, per the request.

## v0.9.4 — Context-aware UX overhaul (15-item spec) + Neon theme

Builds on v0.9.3.2 (the person's own hotfix pass on top of v0.9.3,
delivered outside this session). This is a large batch implementing a
full context-aware-UI specification for the Meta Generator page, plus
a third "Neon" theme. Every item below was verified with a real test
(Python functional tests against actual files/sessions, or a
Playwright-driven Chromium click-through) — not just written and
assumed correct; several genuine bugs were only caught because of
that, and are called out explicitly rather than glossed over.

**Shared UX architecture (new, reused everywhere below instead of
duplicated per page):**
- `toast.js` — app-wide toast/notification system (success/warning/
  error/info, auto-dismiss, manual dismiss, optional action button).
  Added `BackendEvents.off()` alongside this batch after catching a
  real listener-leak bug in Test All (see item 15) — the event system
  previously had no way to unsubscribe at all.
- `confirm.js` — shared Promise-based confirmation modal, used only
  for genuinely destructive actions (Clear All while generation is
  running), not routine ones.

**1. Import order preservation.** Root cause: `Session.add_paths`
validated files across parallel threads but appended results in
whichever order each thread's validation *finished*, not input order
— completion time genuinely varies per file (recency-gated retries),
so this was a real, reproducible bug, not theoretical. Fixed by having
each thread record its result into a keyed dict, then rebuilding the
accepted/rejected lists by walking the original candidate order.
Proved it with an adversarial test that deliberately reverses
completion timing (last file finishes first) — output still comes
back in exact input order.

**2. Import summary toast.** Wired into Browse and real drag-drop on
Meta and Prompt Generator. Found along the way that duplicate files
were being silently discarded server-side with no count at all —
fixed so "N duplicates skipped" is a real, distinguished category now.

**3. Safe Clear All.** Confirmation dialog only appears if generation
is actually running; idle-batch Clear All behaves exactly as before,
no extra click for the common case.

**4. Undo after card deletion.** Toast with an Undo action, ~7s
window, works for both single-card delete and bulk "Remove Selected".
Found and fixed a real race condition here: clicking Undo quickly
after a delete could silently lose the restored card (or duplicate
it), because the fade-out animation's cleanup was still pending and
fired *after* the card was reinserted. Root-caused via a monkey-patch
trace on `Element.prototype.remove()` to catch the exact call site —
fixed by cloning the node (sheds stale listeners) and force-removing
the original first (prevents duplicates if the animation hadn't
actually finished yet). Verified both the fast-click race and the
normal delayed case, for both delete paths.

**5. (Shared architecture, see above.)**

**6/7. Card selection + contextual selection toolbar.** Checkbox
overlay on each card's thumbnail; a "Selected: N" bar with Generate
Selected / Remove Selected / Clear Selection appears only once
something is selected, and collapses (not just hides) when nothing is.

**8. Generate Selected.** New backend method
`start_generation_for_paths` (targets an explicit list rather than
auto-scanning for non-done paths) — refactored the shared guard/
bookkeeping logic out of `start_generation` rather than duplicating it.

**9. Retry Failed.** Shown only when failures exist; reuses
`start_generation_for_paths` with the frontend's own tracked failed-
path list, no bespoke "retry" endpoint needed.

**10. Generate Remaining.** Deliberately *not* a second button —
`start_generation` already only targets non-done paths, so once
there's partial progress the existing Generate button just relabels
itself to "Generate Remaining (N)". Avoids the "ambiguous duplicate
state" the spec's own regression section warned against.

**11. Better batch progress.** Backend now tracks success/failed
counts separately — previously "done" only incremented on success, so
a batch with real failures looked stuck below 100% even after every
item had been attempted. New compact ✓/✕/⏳ breakdown under the
progress bar; "processing" count tracked client-side from `working`-
status transitions, exact rather than estimated.

**12. Copy feedback.** One shared `flashCopied()` helper (icon buttons
tint green briefly; text buttons like "Copy All" swap their label)
wired into all 5 existing copy sites — metadata card fields, prompt-
generator card fields, P2P per-card copy, P2P Copy All, and API key
copy (which previously bypassed the shared clipboard helper entirely).
Guards against rapid double-clicking corrupting the button label.

**13. Add/Remove image workflow.** Covered by items 6/7/9 — "Remove
Selected" is now clearly distinct from "Clear All" (selection vs.
whole batch), each with its own confirmation posture.

**14. Embed Dry Run + mismatch summary.** New `EmbedSession.dry_run()`
categorizes every CSV row (matched / missing_image / missing_metadata
/ unsupported) against the same one-time file index the real embed run
already uses, without touching a single file. Filterable results list
in a new panel on the Embed page. Deliberately does *not* implement
"Already Embedded" detection — that would need a real per-file EXIF
read (a materially heavier operation than the index lookup this reuses)
— flagged as a known gap rather than faked with a placeholder count.

**15. API key status + nicknames.** Real, persisted status per key
(VALID/INVALID/ERROR/UNKNOWN as text labels, not color-only) via a new
`record_key_test` that saves validate_key()'s actual result; a key
that's never been tested honestly shows UNKNOWN. Click-to-rename
nicknames. "Last tested" timestamp. New Test All (tests keys serially,
not in parallel — no reason to hammer a provider's API for this) and
Activate Valid Keys (only acts on keys with a real recorded valid
result — never guesses on an untested key). "Last used" / request-
count stats deliberately *not* added — the generation pipeline doesn't
track per-key usage anywhere today, and fabricating those numbers was
exactly what the spec warned against; a real implementation would mean
threading usage-reporting through the whole failover call path, which
is out of scope for this pass.

**Neon theme (separate request, same session).** Third option
alongside Dark/White in Settings → Theme: deep navy base, cyan accent,
gradient primary buttons with a soft glow, glowing borders on panels/
cards (brighter on hover and when selected), matching glow on the
active nav item, online-status dot, and version pill. Built as a new
palette entry in `theme.js` (same mechanism Dark/White already use)
plus a `[data-theme="neon"]`-scoped CSS block for the gradient/glow
treatment, so it can't leak into the other two modes — confirmed via
computed-style checks (`backgroundImage`, `box-shadow`) that Dark/
White are byte-for-byte unaffected. Gets its own background-preset
swatches and its own persisted-override storage key, mirroring how
Dark/White each already keep their overrides independent.

## v0.9.3 — UI fixes/features batch: progress/model line, versioning, P2P controls, drag cursor, card grid & info, API Manager layout

Continuing from v0.9.2 with the licensing/subscription work on hold at
Hasib's request (not sold as a paid product yet) -- this batch is a
straight numbered list of UI fixes/features, verified with a real
Chromium (Playwright) render where the fix was a layout/visual claim,
since the sandbox's only other headless renderer (wkhtmltoimage) turned
out not to support CSS Grid at all and produced misleading results
during this batch (see item 10).

**1. Progress count vs. current-model text no longer overwrite each
other.** `#status`/`#statusPrompt` used to be a single element written
to by both the `task_progress` event ("[i/total] file.jpg") and the
`status_text` event (`"{provider} · {model}…"`, fired from
`call_with_failover`'s `status_cb`) -- whichever fired last won,
routinely blocking the progress line. Split into a flex row
(`.status-row`) with the progress text pinned left and a new
`.status-model-text` pinned right, on both the Meta and Prompt pages.
Model text is cleared on Start/Stop/Clear/Complete so it never shows a
stale provider name.

**2. Version pill was stuck at v0.9.1.** It was a second hardcoded
string in `index.html`, completely disconnected from `APP_VERSION` in
`constants.py` (already v0.9.2, never bumped further, never read by
the UI). Bumped `APP_VERSION` to v0.9.3 and added `Api.get_app_version()`
so the topbar pill reads the real constant on load -- can't silently
drift out of sync again.

**3. Online-status pill moved next to the version pill** (topbar-left,
same row/alignment), out of `topbar-right`.

**4/5. P2P panel: Concurrency and Prompt Length.** Concurrency was a
bare `<input type=number>` at the bottom of the panel; replaced with a
1-20 slider (`.control-slider-row` + `.range-input`, the same styling
Prompt Length used), moved between Prompt Length and the Generate
button. Prompt Length itself was that slider (10-500, free drag);
replaced with a fixed button-row selector (50/100/200/300/400/500),
same `.p2p-choice-btn` pattern as the Generate count row, default 50.

**6. P2P result cards: copy + edit added.** A copy button (left of the
word count, top row) copies that exact prompt to the clipboard, reusing
app.js's existing `copyText()` helper (both files load as plain
non-module scripts into the same global scope, so no duplication
needed). An edit (pencil) button sits left of delete, following the
Metadata cards' exact toggle pattern (pencil <-> checkmark,
contenteditable on/off) -- the only difference is where the result
lands: P2P has no per-item backend/session state, so leaving edit mode
writes the on-screen text straight back into the in-memory
`p2pPrompts` array and refreshes that card's word count in place.
Verified end-to-end (edit -> retype -> exit edit -> word count updates)
with a real headless Chromium click-through, not just read from code.

**7. Drag-and-drop "blocked" cursor for ~1 second before the correct
one.** Root-caused by actually reading pywebview's own source
(`webview/dom/element.py`) rather than guessing: the Python-side
`dragover`/`dragenter` DOM handlers' `debounce=200` was the obvious
suspect but turned out NOT to be the cause -- pywebview's generated JS
wrapper calls `e.preventDefault()`/`e.stopPropagation()` synchronously
on every native event regardless of debounce; debounce only delays the
follow-up (no-op) Python callback dispatch. The real gap: none of the
cosmetic drag-active JS listeners (app.js, p2p.js, promptgen.js,
embed.js) ever set `event.dataTransfer.dropEffect`. `preventDefault()`
alone stops the browser's default *reject* action, but Chromium/
WebView2 still needs `dropEffect` set on the same event to switch the
OS cursor glyph from "no-drop" to "copy". Added `dropEffect = 'copy'`
to all four files' dragenter/dragover handlers. Honest gap: this
sandbox has no real Windows/pywebview/WebView2 window, so the actual
OS cursor glyph itself could not be visually confirmed here -- worth a
quick real-machine check.

**8. Sidebar/control-panel collapse button redesigned.** Was a
24x56px pill with filled ▶/◀ triangle glyphs; now a true circle
(28x28, border-radius:50%) with plain "<"/">" characters, in both
places this button appears (Meta Generator and Image-to-Prompt
Generator control panels).

**9. Metadata Generator card grid: bigger thumbnails, file info line,
2/3/4-column view.**
- Thumbnail bumped 72px -> 96px ("a bit bigger, not too much" per
  request); `.card-thumb-actions` width matched to stay aligned.
- New info line under the thumbnail: file name (ellipsis-truncated,
  full path in the `title` tooltip), *original* image dimensions, and
  on-disk file size (B/KB/MB/GB, auto-scaled) -- explicitly the
  original file's numbers, never the thumbnail's or the downscaled
  AI-preview copy's. Backend: `core/utils.get_original_file_meta()`
  reads this once per file at import time (same one-time-cost spirit
  as thumbnail prefetching, not re-read during generation), pushed to
  the frontend via a new `file_meta_ready` event
  (`prompt_file_meta_ready` on the Prompt page) alongside the existing
  `thumb_ready` event, and cached client-side the same way thumbnails
  are.
- New "View" dropdown (top-right of "Generated Metadata", under
  Browse) lets the person pick 2/3/4 columns for `#cardGrid`
  (`grid-template-columns` via a `data-cols` attribute), persisted
  through the same `get_prefs`/`save_prefs` merge Concurrent
  Generations already uses. Switching fades the grid out/in
  (`.view-fading` opacity transition) rather than snapping instantly,
  directly addressing the "cards get very tall with Description on,
  because the grid is stuck at 3 fixed columns" complaint -- fewer
  columns means wider cards means less text wrapping means shorter
  cards. Verified with a real Chromium click-through: opened the
  dropdown, selected 2, confirmed `cardGrid.dataset.cols` updated and
  the layout visibly reflowed to two wider cards.

**10. API Manager "leaving 30/35% of the window blank."** Measured
this for real with Playwright/Chromium (not assumed): the STORED KEYS
panel (`.api-keys-panel`, the `1fr` grid column) was already spanning
the full available width -- confirmed via `getBoundingClientRect()`,
right edge landed within a few px of the window edge, matching every
other page's padding. The actual problem was `.api-key-list` being
`flex-direction: column`, so every key card stacked full-width one per
row; on a wide window each card's own content is narrow, so most of
that full-width row just sat empty. Switched `.api-key-list` to a
responsive grid (`repeat(auto-fill, minmax(300px, 1fr))`) so multiple
key cards sit side by side, matching the Meta Generator's card-grid
pattern the person was comparing it to. Screenshot-confirmed: 3 keys
now sit in one row spanning the full panel width instead of stacking.

**Sandbox tooling note:** this batch's headless visual checks moved
from `wkhtmltoimage` to a real Playwright-driven Chromium instance
partway through, after wkhtmltoimage's ancient WebKit engine was found
to silently not support `display: grid` at all (it rendered the API
Manager's two-column grid as fully stacked single-column, which looked
like it confirmed a layout bug that real measurement then disproved).
Every grid/flex layout claim in this entry was verified against the
Chromium render, not the wkhtmltoimage one.

## v0.9.2 — Forensic-audit pass 3: Parts 7, 9, 11-24 (large-batch performance, remaining race gaps, memory/leak audit)

Continuation of the v0.8.7 forensic-audit request, picking up everything
still open after v0.8.9's races/drop-target batch and v0.9.0/0.9.1's
UI work from other sessions. Nothing from those sessions was changed
or removed — verified via diff before starting (drag-scroll, viewport
scaling, animation system, per-card actions, P2P card grid all intact).

**Part 7 — Image-to-Prompt target length (`session.py`).** Hard max
was already enforced but there was no target-length guarantee: a
result well under ~85% of the requested word count was accepted as-is.
Added one bounded, image-grounded expansion retry (same shape as the
existing meta-mode keyword-undercount retry) before falling back to
the original. Verified: mocked a 10-word initial response against a
50-word target, confirmed exactly one retry call fires and the hard
cap still holds on the expanded result.

**Part 9 / Part 19 — duplicate imports within a single batch
(`session.py`, `prompt2prompt.py`).** Both `Session.add_paths` and
`P2PImageStore.add_paths` only deduped against *already-imported*
files — a path appearing twice in one incoming list (e.g. a folder
walk following a symlink back to itself) passed both copies through,
producing a real duplicate card and duplicate generation work. Fixed
both to track paths accepted earlier in the *same* call too. Verified
with a real duplicate-path test against both stores.

**Part 11 — large-batch DOM performance (`base.css`).** Added
`content-visibility: auto` + `contain-intrinsic-size` to `.card` /
`.card.has-desc` (fixed heights, safe) and `.p2p-card` (variable
height, using the `contain-intrinsic-size: auto <px>` progressive-
enhancement pattern so real card size is remembered after first
layout instead of a static guess), plus `contain: layout style` on
both grid containers and the embed log panel. Chosen over
virtualization per the spec's own "try low-risk options first"
guidance — every card stays a real, editable DOM node; off-screen
cards just stop costing layout/paint. Pure progressive enhancement:
unsupported engines silently ignore it and render normally, so it
doesn't create a new Windows/WebView2 vs Linux/WebKitGTK compatibility
risk (Part 28).

**Part 12/13/14 — forced-layout animation restarts + burst control
(`animate.js`, `app.js`, `promptgen.js`).** Three separate copies of
`void el.offsetWidth` (a synchronous forced-layout read used to
restart a CSS animation) existed — `Animate._restart`, and duplicated
inline in both app.js's and promptgen.js's per-card "updated-flash"
handling. On a large-batch completion burst this meant hundreds of
forced layouts back-to-back. Replaced with a double-`requestAnimationFrame`
restart (no layout read at all), consolidated the two duplicated
inline copies into `Animate.flash()`, and added a shared burst guard
(more than 12 animations within any 100ms window fall back to
applying the resting state instantly, no animation) so a fast
completion burst can't queue up animation backlog. The real state
change (text, status) is never delayed — only the cosmetic transition
is skipped under burst load.

**Part 15 — P2P result rendering (`p2p.js`).** `p2p_partial`/
`p2p_completed` used to call a full `renderP2pResults()` rebuild every
time (5 prompts → render 5, 10 → destroy 5 + create 10, etc.), losing
any checkbox state on already-settled cards. New `updateP2pResults()`
appends only the newly-arrived cards when the update is a pure append
(the normal case during generation), preserving existing checkboxes;
any non-append change (delete, reset) still uses the safe full
rebuild. Select All / Copy / Export all read the DOM live via
`querySelectorAll`, so none of them needed changes.

**Part 16 — embed log (`embed.js`).** Was `embedLog.textContent += ...`
plus a forced `scrollTop` read/write on every single log line — for a
large batch, hundreds of full-text-rebuild + forced-layout pairs in
rapid succession. Now buffers incoming lines and flushes them as one
real text-node append per animation frame; auto-scroll only continues
if the user was already near the bottom, so manually scrolling up to
read earlier lines doesn't get overridden by new lines arriving.

**Part 17 — event bridge payload flood (`bridge.py`).** The drain loop
already batched multiple queued events into one `evaluate_js` call per
tick (good foundation, kept as-is) — but a single tick's batch had no
upper bound, so a burst of `thumb_ready`/`p2p_image_thumb` events
(each carrying a base64 JPEG) landing in the same 60ms window could
still produce one very large `evaluate_js` call. Now chunks each
tick's batch into calls of at most 40 events, preserving the
coalescing benefit for the normal case while bounding worst-case call
size.

**Part 18 — thumbnail pipeline.** Audited: already background-threaded,
already size-bounded (160x160 JPEG q82), already cached
(`thumb_cache`), and `regenerate_one` correctly doesn't re-touch the
thumbnail cache for a metadata-only re-run. No duplicate-work bug
found beyond the Part 17 delivery fix above.

**Part 20 — embed match-count caching (`embedder.py`).** Real bug:
`preview_match()` (the live match-count shown while the user is still
picking the filename column / toggling extension-match) called
`build_file_index()` unconditionally on every single call — a full
folder rescan per keystroke/toggle, even though `_embed_thread` right
below it already correctly reused the cached index. Fixed
`preview_match` to reuse the cache the same way; added an explicit
invalidation in `set_folder()` so any explicit (re-)selection of a
folder — including re-picking the *same* folder after adding files —
always forces one fresh scan, never silently trusting a stale one.
Verified: 3 preview calls with only the ext-match toggle changing
produced exactly 1 scan; re-selecting the same folder produced exactly
1 more.

**Part 21 — API key validation blocking the bridge (`bridge.py`,
`settings.js`).** `validate_key_live()` ran a synchronous network
request (up to 12s timeout) directly on whatever thread pywebview
dispatches every js_api call through — any other bridge call made
during that window (Stop, Generate, a card edit) would queue up behind
it. Now returns immediately with a request_id and does the real
network call on a background thread, delivering the result via a
`key_validated` event; `settings.js` wraps this back into a
`requestValidateKey()` Promise so both call sites (blur-validate,
per-key Test button) keep their exact previous behavior and status
text. Verified: mocked a 1s-delay validation, confirmed the call
returns in under 1ms and the result event arrives ~1s later with a
matching request_id.

**Part 22/23 — navigation transitions / CSS containment.** Audited
`nav.js`: pages are hidden/shown, never destroyed or torn down and
rebuilt, and only the outgoing+incoming page animate on a page switch
(never more than two at once) — already matches the spec, no change
needed. Added `contain: layout style` to the embed log panel (grids
already covered under Part 11). No expensive animated `filter`/
`backdrop-filter`/`blur` effects found anywhere in the CSS.

**Part 24 — memory-leak audit.** Audited every `addEventListener`
call site across all 14 frontend JS files: every list/grid (card
grid, P2P image grid, P2P results) uses one delegated listener
registered once at module load, never per-item listeners re-attached
on re-render; `viewport-scale.js`'s resize listener and
`dragscroll.js`'s document-level drag listeners are correctly
singleton/paired (mousedown adds mousemove+mouseup, mouseup always
removes both). `cardEls`/`lastApplied`/`thumbCache` Maps are properly
cleared on Clear All and per-path on card delete. Backend: `TaskManager`
creates a fresh bounded `ThreadPoolExecutor` per batch and clears its
own reference once done; `Session.clear()` reassigns (not just
empties) `results`/`completion_order`/`thumb_cache`, letting old
generation state actually be garbage collected. No leaks found.

**Part 26 — feature preservation.** Confirmed via diff against the
previous delivered state before starting this batch, and again just
now: no existing feature, control, or visual behavior from any prior
session (this one's or others') was changed or removed.

**Not fully verifiable in this sandbox:** Part 28's Windows/WebView2
vs Linux/WebKitGTK compatibility can only be confirmed by inspection +
the progressive-enhancement design of every CSS/JS change above (each
one no-ops safely on an unsupporting engine) — there's no real
WebView2 or WebKitGTK renderer available under headless Xvfb to
exercise directly. Part 27 (CPU/RAM/GPU) untouched this batch, no
reported issue against it. A live 250-1000 image end-to-end run
(Part 30's stated testing bar) still needs a real machine with a real
AI API key; what's verifiable headlessly (the race conditions, dedup,
caching, and async-validation fixes) was verified with real
reproduction scripts, not just code reading.

## v0.9.1 — Multi-monitor/resolution scaling, Embed auto-import fix

**The app no longer renders "huge" on smaller/lower-resolution
monitors (1366x768 and other 720p-class screens).** Every fixed-pixel
value in `base.css` was tuned against the app's reference window size
(1300x900) -- correct on a 1080p+ display, but the same fixed pixels
eat up a much bigger share of a smaller screen, reading as an
oversized UI. Two-part fix:
- `app.py` now sizes the window itself down (proportionally, floored
  at 900x600) for screens smaller than the 1300x900 reference,
  instead of always requesting the full 1300x900 regardless of the
  monitor -- and never enlarges past that reference on bigger/4K
  screens either. `min_size` lowered from (1000, 700), which was
  already taller than a 1366x768 screen's usable (post-taskbar)
  height and could never actually be honored there.
- New `frontend/js/viewport-scale.js` applies one uniform CSS `zoom`
  (chosen over `transform: scale` specifically because it keeps this
  app's extensive `calc(100vh - ...)` layout and sticky/fixed
  positioning working correctly) so the whole UI's proportions stay
  pixel-identical to the current 1080p look, just scaled to fit
  whatever window size results -- capped at 100% so it only ever
  scales *down* to fit a smaller screen, never zooms in past the
  design's native size on a larger one. Recomputes on live resize too
  (debounced), so manually resizing/maximizing on any monitor is
  covered, not just the size at launch. Tested against the requested
  720p (1366x768) floor up through 1080p, 2K and 4K.

**Embed page's CSV/folder auto-import fixed.** Clicking the "Embed"
button on a completed Meta Generator batch is supposed to jump to the
Embed page with that batch's CSV and image folder already loaded --
this could silently fail to actually load anything on some installs.
Root cause: the working CSV that handoff depends on
(`session.py::_write_working_csv`) writes into a folder under
`core.config`'s shared `C:\MetaZone` location, which isn't guaranteed
writable on every Windows account (e.g. a standard/non-admin user
where that folder hasn't already been created with permissive
enough ACLs) -- and unlike `core.config.get_prefs_path` (which
already falls back to a temp directory for this exact reason), the
working-CSV path had no such fallback: a failed folder creation there
just gave up, leaving nothing for Embed to auto-load. Now falls back
to the OS temp directory the same way `get_prefs_path` does, so the
auto-import keeps working regardless.

## v0.9.0 — Click-and-drag scrolling in Meta Generator, P2P, and Image to Prompt Generator

**Grab-to-scroll for the results areas.** Press and hold the left
mouse button anywhere in Meta Generator's or Image to Prompt
Generator's results area (dropzone, action row, card grid) or P2P's
results panel, then move the mouse up/down to scroll -- like panning
a map -- instead of needing to land the cursor precisely on the
scrollbar. New `js/dragscroll.js` handles this generically via a
`drag-scroll-zone` class (added to `.meta-content`, shared by both
Meta Generator and Image to Prompt Generator, and to P2P's
`.p2p-right-panel`); any future page can opt in the same way. Only
real controls are excluded from the drag -- buttons, links, form
fields, and any text currently being edited -- everything else in the
zone is drag-and-scroll territory. A press that never moves more than
a few pixels is still treated as a plain click, so buttons, the
dropzone's click-to-browse, and everything else behave exactly as
before.

## v0.8.9.2 — Card text sizing, thumbnail action stack + colors, real page-fade fix, tighter nav rail, CSV naming fix

**Card char/word count font size.** `.field-count` (the "130 chars ·
20 words" text next to each field label) was 11.5px against the card
body text's 12px — close enough to read as an inconsistency. Matched
to 12px so every piece of text inside a card is the same size.

**Regenerate/Delete now stack under the thumbnail, full width.**
Previously the two buttons sat side by side under the thumbnail, each
about half its width. They're now stacked in the same column as the
thumbnail — thumb, then Regenerate, then Delete — each exactly as
wide as the thumbnail. Delete is a black button with a red icon at
rest, fading to a solid red button with a white icon on hover.
Regenerate keeps its normal button look but with an accent-colored
icon at rest, fading to a solid accent-filled button with a white
icon on hover. Both use the same fade timing/curve.

**Page transition: the actual remaining cause of the "old page
lingers" flash.** v0.8.9 added a pure-opacity `page-fade-in`/
`page-fade-out` pair specifically to stop pages sliding vertically —
but every `<section class="page ...">` in `index.html` still carried
a static `fade-target` class from before that change. Because that
class matches unconditionally, its own `translateY(6px)` keyframe
kept replaying on top of the new pure-fade animation every time a
page went from hidden to visible, so the incoming page's header
still briefly appeared low in the window before snapping into place.
Removed `fade-target` from all 7 page sections; only the intended
pure-opacity crossfade runs now.

**Nav rail narrowed, icons given more breathing room.** Sidebar width
72px → 62px. Also found the actual reason the icons looked like they
were hugging each other despite `.nav-item`'s own margin-bottom: a
later, equal-specificity rule (`.sidebar .nav-item { margin: 0 6px; }`,
added in v0.8.7 for the horizontal hover-inset) was silently zeroing
out that vertical margin. Fixed so the horizontal inset and vertical
spacing (now 10px between items) both apply.

**Auto-downloaded CSV filename.** `_auto_csv_path()` was building a
numbered prefix (`1_100 halloween flatlay.csv`) instead of the
originally-specified `#FolderName.csv`. Fixed to use a literal `#`
prefix for the first export in a folder; a `#Name (2).csv`-style
suffix only appears if that exact name is already taken, so repeated
exports still never overwrite each other.

## v0.8.9 — Page fade fix, per-card Regenerate/Delete, P2P card grid, count legibility, unified Clear-All cache wipe

**Page transition: pure fade, no more "slide down" feel.**
`nav.js`'s page crossfade previously used `fade-target`/`fade-out-target`,
which paired the opacity change with a `translateY` — the outgoing page
visibly drifted upward while fading out and the incoming one dropped in
from above, reading as one page sliding down as the next appeared.
Replaced with a dedicated `page-fade-in`/`page-fade-out` pair (pure
opacity, no transform) used only for top-level page switches; every
other component's translate-based fade/pop/panel animations are
untouched.

**Per-card Regenerate and Delete (Meta Generator + Image to Prompt
Generator).** Both card templates now have a small button row directly
under the thumbnail. Regenerate re-runs generation for just that one
image via a new `Session.regenerate_one()` (reuses the exact same
`_gen_thread`/`process_one` pipeline a full batch uses, targeting only
that path, so parsing/sanitization/retry logic can't drift from a full
run) and is disabled + spinning until that card's next `done`/`failed`
result arrives. Delete calls a new `Session.delete_card()` that removes
the path from results/completion-order/import-list/thumbnail cache
(and rewrites the working CSV) so it can't reappear on a reload or get
targeted by a later Regenerate; the card is removed from the DOM only
once the backend confirms via a new `card_removed` (`prompt_card_removed`
on the Prompt Generator page) event.

**Prompt-to-Prompt: results are now a card grid, not a stacked list.**
Matches the Metadata Generator's card-grid look per request — each
generated prompt is its own card with a live word count in the top-right
corner and its own delete button (bottom-right). Deletion is client-side
(P2P has no per-item backend/session state, just an in-memory prompt
list) — removing a card simply splices it out and re-renders.

**Metadata card counts: bigger, accent-colored, and title/description
now both show chars *and* words.** Previously Title showed only a
character count and Description only a word count, and both were 9px
low-opacity text-dim, easy to miss entirely. Both fields now show
`X chars · Y words` at ~11.5px in the accent color.

**Metadata Generator card view: copy/paste icons switched to flat,
mono SVG glyphs** (single-color, `currentColor`) in place of the
colorful ⧉/📋 emoji, for a more minimal look consistent with the rest
of the icon-only buttons in the app.

**Meta Generator "General" platform description cap: 250 → 500
characters** (`backend/core/constants.py`'s `PLATFORM_RULES`) — the
slider itself already went up to 500, but the default/no-named-platform
preset was still capping actual generation at 250.

**Clear All / Reset now wipes the same shared temp/cache folders no
matter which page's button is pressed.** Previously only Meta
Generator's (and, because it shares the same `Session` class, Image to
Prompt Generator's) Clear All wiped the generation-preview cache,
thumbnail cache, and working-CSV export folder — P2P's Reset button
only cleared its own in-memory reference-image list, leaving its share
of the same on-disk caches behind. Extracted the wipe into
`core.utils.clear_shared_temp_data()` and call it from all three.
Still never touches `prefs.json` or stored API keys anywhere — those
live outside every folder this function looks in.

**Version bumped to v0.8.9** (`backend/core/constants.py`'s
`APP_VERSION` and the topbar's version pill).

## v0.8.8 — Auto CSV toggle restyle, folder-picker memory, in-app logo, full animation system

**Auto Download CSV toggle (Meta Generator action row).**
Was a plain, unbordered label+switch pair sitting shorter than its
neighbors in the action row. Rebuilt as a real bordered `.btn-toggle`
box using the exact same background/border/radius/padding as Clear
All/Generate/Pause/Stop/Download CSV, so it's now perfectly height-
aligned with them and reads as one of the row's buttons rather than a
stray control panel row that wandered into the wrong place. The whole
box is clickable, not just the small switch inside it (with a guard so
clicking the switch itself doesn't double-toggle).

**Meta Embedder: "File Location" Browse now opens where the CSV is.**
`browse_csv()` previously only *returned* the CSV's guessed folder to
the frontend for display — it never actually set the backend's own
`EmbedSession.folder`, so the very next Browse-folder click still
opened the OS's default/last-used directory instead of the CSV's own
folder. Fixed: `browse_csv()` now adopts that guessed folder into
`EmbedSession.folder` immediately (mirroring what drag-and-drop's
`load_csv_dropped` already did), and `browse_embed_folder()` now opens
its native dialog with `directory=` pointed at that folder.

**In-app top-left logo now uses the real MetaZone icon.**
The topbar's brand mark was a hardcoded gradient div with a plain "M"
in it, unrelated to `icon.png`/`icon.ico` (which were already wired up
correctly as the *window/taskbar* icon, just never used anywhere in
the page itself). Copied `icon.png` into `frontend/assets/` (the root-
level copy isn't included in either build script's `--add-data` list,
so referencing it from there would silently break in a packaged
build) and swapped the div for an `<img>` pointing at it.

**Version bumped to v0.8.8** (`backend/core/constants.py`'s
`APP_VERSION` and the topbar's version pill, which had drifted out of
sync with each other before this pass — pill said v0.8.7, constant
said v0.8.9).

**New reusable animation system (UI-only, no functional/layout
changes).**
Added `js/animate.js`'s expanded `Animate` helper (fadeIn/fadeOut,
page crossfade, panel open/close, staggered batch entrances, update
pulses, drop-success flashes) and a full set of keyframes in
`styles/animations.css` (page transitions, panel/modal/dropdown/toast
primitives — the last three unused today but ready for any future
component that needs them). Wired throughout: sidebar page switches
now crossfade instead of hard-cutting; Advanced Options opens/closes
with a real slide+fade instead of an unanimatable `hidden` toggle;
buttons/nav items/tabs/swatches/theme buttons all got consistent
hover/press transitions; the Meta Generator and Meta Embedder drop
zones get a subtle highlight-in on drag and a confirmation pulse on a
successful drop; status text and match-count updates get a soft pulse
instead of jump-cutting; Dashboard's stat cards and stat rows fade in
with a slight stagger. All motion stays in the 120–260ms range using
only opacity/transform, per the "smooth, modern, professional, never
flashy" brief — nothing about generation, embedding, or any other
backend logic was touched.

## v0.8.9 — P2P image-grid drop target fix + option-tracing audit (Parts 1 & 10)

**Part 10 — P2P image grid never actually had its own drop target
(`app.py`).**
The existing comment claimed the P2P image grid already had a real
element-scoped drop handler alongside `#embedCsvDropzone`/
`#embedFolderDropzone` — it didn't; the `for selector, handler in (...)`
loop that does the actual binding only listed the two embed dropzones.
P2P image drops were instead handled entirely by the document-wide
`on_drop()`, keyed off whichever sidebar page was "active" — meaning
a drop *anywhere* on the P2P page, including while the "From Text" tab
was showing with no image grid visible at all, silently tried to add
reference images. Fixed: added a real `on_p2p_grid_drop()` handler
bound to `#p2pImageGrid` (mirrors the embed dropzones' pattern exactly
— `window.dom.get_element()` + `DOMEventHandler`), and the document-
level fallback now no-ops for the P2P page instead of routing every
page-wide drop into the image store. Confirmed `#p2pImageGrid` always
renders all 15 slot boxes (filled or empty "+"), so it stays a
real-sized drop target even with zero images — no CSS change needed.
Could not verify the live pywebview DOM-event binding itself in this
headless sandbox (no WebView2/WebKitGTK renderer available under
Xvfb) — verified by code inspection, `py_compile`, and matching the
now-identical pattern used successfully by the two embed dropzones.

**Part 1 — frontend→backend option-tracing audit.**
Traced every option in the request's checklist from its DOM element
through the bridge call to where the backend actually consumes it:
platform, file/content type, title/description length, keyword count,
description toggle, custom prompt, prefix/suffix, single-word
keywords, copyright avoidance, concurrency, auto CSV (Meta
Generator + `session.py`); max words, style (Image-to-Prompt +
`session.py`'s shared `mode="prompt"` path); count, creativity, style,
target words, concurrency, image mode (P2P + `prompt2prompt.py` /
`prompt_to_prompt/engine.py`). All values reach the backend correctly
and are actually applied (not just displayed) — no additional
option-plumbing bugs found. One thing worth knowing, not a bug:
"platform" itself is never sent to the backend as a string — selecting
a platform (`applyPlatformDefaults()`) pre-fills the title/desc/
keyword-count sliders and the description toggle from
`PLATFORM_RULES`, and it's *those* derived numeric values that get
sent and enforced server-side. There's no platform-specific prompt
wording sent to the AI (`build_meta_prompt`'s unused `themes=""` param
confirms this was never wired for platform text either) — this
matches the proven 0.7.5-era design (platform = constraints, not
prompt content) and was left as-is per Part 32.

## v0.8.8 — Race-condition pass: Meta Generator stop/clear, P2P stop/reset

Scoped, verified pass on the highest-priority item from the v0.8.7
forensic-audit request (race conditions), per the priority order in
that request (correctness/races above large-batch/UI/animation work).
**This batch does NOT cover Parts 7–31 of that request** (DOM/
animation/CSS performance, thumbnail/import/embed-index perf, memory-
leak audit, navigation transitions) — see "Not started" below. No
generation-quality code (`prompt_generator.py`, `parser.py`,
`ai_providers.py`) was touched; only timing/state-guard logic in
`session.py`, `prompt2prompt.py`, and `prompt_to_prompt/engine.py`.

**Root cause (both bugs below share one shape):** every async
generation path here checks its own cancellation state *before*
starting an API call, but several important commit points *after* the
API call returns had no check at all, or checked `gen_epoch` without
`stop_flag` ever bumping `gen_epoch`. A slow in-flight request could
therefore return after Stop/Clear/Reset and still write into shared
state or fire a "this is done" event.

**1. Meta Generator: Stop pressed while a request is in flight could
still commit the stale result (`session.py`).**
`stop()` previously only set `stop_flag`; it never bumped `gen_epoch`.
Every post-API-call check in `process_one` compared against
`gen_epoch` only, so a request already running when Stop was pressed
would return, find `epoch == self.gen_epoch` still true, and commit a
"done" card anyway — reproduced with a mocked 1s-delay `call_with_failover`
(retry path makes this ~2s for undercount batches) and a `stop()` at
0.2s: 3/3 paths ended up `"done"` with stale AI content instead of
`"stopped"`. Fix: `stop()` now bumps `gen_epoch` too, so Stop uses the
exact same invalidation path as Clear All and a new Start. Added
re-checks at every commit point that was missing one: right before the
final `"done"` write in both meta and prompt modes (the undercount-
keyword retry makes a second slow call between the existing mid-flight
check and the final commit), in the exception handler (a stale
worker's request can also fail), and before `completion_order`/`emit`
so a stale worker can never touch shared state at all past that gate.

**2. Meta Generator: `_on_all_done` fired `task_completed` for a
stopped batch (`session.py`).**
`TaskManager.run_batch`'s watcher thread always calls `on_all_done`
once every submitted future resolves — including ones in flight when
Stop was pressed — so a stopped batch that later finished its
in-flight requests would flip `running`/`batch_complete` back on and
emit `task_completed` as if it had completed naturally (confirmed via
the same reproduction: `task_completed` was emitted after `stop()`).
Fixed: `_on_all_done` now returns immediately if its captured `epoch`
no longer matches `self.gen_epoch`, so only a genuinely current,
non-stopped, non-cleared generation can ever reach "natural
completion".

**3. Meta Generator: Clear All during active generation let old
workers repopulate the just-cleared UI (`session.py`).**
`clear()` reset `all_paths`/`results`/`completion_order` but never
stopped generation or invalidated `gen_epoch` — a still-running
batch's workers would keep writing into the (now shared-reference)
dicts/lists and re-append to `completion_order`, so cleared cards
could reappear. Reproduced: cleared during an active 2-file batch,
both files reappeared as `"done"` ~1s later. Fixed: `clear()` now
bumps `gen_epoch` and sets `stop_flag=True`/`running=False` before
resetting state, using the same epoch mechanism as #1/#2 above.

**4. Prompt-to-Prompt: Stop/Reset during an in-flight batch could
still fire `p2p_partial`/`p2p_completed` (`prompt_to_prompt/engine.py`,
`prompt2prompt.py`).**
`PromptToPromptEngine`'s per-batch `worker()` checked `stop_flag`
before the API call but not after, and `_run()`'s final
`on_complete`/`on_error` fired unconditionally regardless of
`stop_flag`. Reproduced: mocked 1s-delay `call_with_failover`, `start()`
then `stop()` at 0.2s → `p2p_partial` and `p2p_completed` both still
reached the event bus. Fixed at two layers: (a) `engine.py` now
re-checks `stop_flag` after each API call returns and before firing
`on_progress`/`on_partial`, and gates the end-of-run
`on_complete`/`on_error` behind `not stop_flag`; (b) `prompt2prompt.py`'s
`PromptToPromptSession` adds a `run_token` counter (same role as
`gen_epoch`) bumped on every `start()` and `stop()` — every callback
handed to the engine re-checks its captured token against the
session's current one at emit time, so even a batch the engine-level
check somehow missed can never reach the UI once the run is stale.
Also added `PromptToPromptSession.reset()` (stop, in the correct
token-bump-before-clear order, then clear images) as an available
single call, though the current frontend already calls
`stop_prompt_to_prompt()` then `clear_p2p_images()` separately in that
same safe order, so no frontend change was required for this fix to
take effect.

**Verified:** all 4 fixes reproduced against the original v0.8.7 code
first (confirmed each bug is real, not theoretical) via headless
scripts that mock `call_with_failover` with an artificial delay and
press Stop/Clear mid-flight, then re-ran the identical script against
the fixed code to confirm the stale write/event no longer occurs.
`py_compile` + `pyflakes` clean on all 4 changed files
(`session.py`, `prompt2prompt.py`, `prompt_to_prompt/engine.py`,
`bridge.py` unchanged but re-checked for consistency).

**Not started (still open, in priority order from the request):**
Part 1 (full frontend→backend option-tracing audit), Parts 7–9
(Image-to-Prompt target-length retry, grounding/accuracy prompt work,
P2P image-mode edge cases), Part 10 (P2P image-grid native drop
handler), Parts 11–23 (large-batch DOM/virtualization, animation
system rebuild, P2P incremental result rendering, embed-log batching,
event-bridge/thumbnail/import/embed-index performance, API-validation
async safety, navigation transitions, CSS containment), Part 24
(memory-leak audit), Parts 26–28 (feature-preservation re-audit,
CPU/RAM/GPU, Windows/Linux compatibility re-check). These are
substantial, mostly-frontend/JS pieces of work needing real
pywebview+browser verification (Xvfb alone doesn't cover WebView2 vs
WebKitGTK differences), not something to batch into the same pass as
the race-condition fixes above without risking a rushed, unverified
result.

## v0.8.7 — P2P rebuild (both modes wired), embed CSV/folder drag-drop + match count, prompt accuracy/word-cap fixes, platform toggle bug, light theme swatches, dashboard CPU/RAM, flat nav icons

Addresses all 7 items from Hasib's latest numbered list. Real
verification performed where the sandbox allows it (no GUI/Xvfb+
pywebview available this session — see "Not verified" below); icons
were rendered with cairosvg and visually inspected before shipping,
backend logic was exercised with real function calls (not just
`py_compile`), per item below.

**1. Prompt-to-Prompt Generator — full rebuild, both "From Text" and
"From Image" modes now real.**
`prompt2prompt.py`: `PromptToPromptEngine` (the real generation logic
in `prompt_to_prompt/engine.py`) already supported `source_image=`/
`target_words=` — it was never being passed through from
`PromptToPromptSession.start()`, so Image mode was silently
unreachable. Fixed, and added `P2PImageStore` (add/remove/clear, up
to 15 images, background-thread thumbnails via the same
`make_thumb_b64` helper Meta/Prompt use) since this is a shared
reference set, not a per-file `Session` batch. `bridge.py`: new
`start_prompt_to_prompt(..., use_image=)`, `browse_p2p_images`,
`get_p2p_image_thumb`, `get_p2p_images`, `remove_p2p_image`,
`clear_p2p_images`, `export_p2p_prompts(prompts, fmt)` (TXT/CSV, plain
file-save, no Session involved). `index.html`: `#page-p2p` rebuilt to
match the reference screenshots — From Text/From Image tabs, 15-slot
image grid, Count/Creativity segmented buttons, Prompt Style dropdown
(same 5 styles as the backend's `style_note` dict — verified exact key
match), Prompt Length slider (10–500 words), Generate/Pause/Cancel,
progress bar + status, and a results panel with Select All/Copy
All/Export TXT/Export CSV. `p2p.js` rewritten to match. New CSS block
in `base.css` for the two-column layout, choice-buttons, and image
slot grid.
*Verified*: `bridge.Api()` instantiates cleanly with the new session
graph; `P2PImageStore.add_paths/remove/clear` exercised against real
on-disk JPEGs (accept, thumbnail-cache population, removal, clear all
confirmed via direct calls); `start_prompt_to_prompt(..., use_image=True)`
with zero images added correctly returns an error instead of silently
running. *Not verified*: the actual AI call path end-to-end (needs a
real API key + network) and the on-screen layout (needs
Windows/Xvfb+pywebview rendering — not available this session).

**2. Meta Embedder — CSV/folder drag-and-drop + live match count.**
Root cause of "not drag-and-drop enabled": there was no drop target at
all on the Load CSV / File Location steps, only the Browse buttons.
`app.py`: two new element-scoped `DOMEventHandler` bindings via
`window.dom.get_element('#embedCsvDropzone' / '#embedFolderDropzone')`
— same `pywebviewFullPath` mechanism as every other real drop target
in this app, just element-scoped instead of document-wide (needed
here since these boxes share a page with other content, unlike the
Meta/Prompt pages' full-page dropzones). Dropping a CSV auto-grabs its
own folder via the existing `guessed_folder` logic in
`embedder.load_csv` (already there, just never reachable without a
drop target); dropping a folder — or a file, using its parent — sets
the folder directly. `bridge.py`: `load_csv_dropped`,
`set_embed_folder_dropped`. Match count: `embedder.preview_match`
already existed but was never called from the UI; now wired to fire
whenever CSV + folder + Filename column are all present, and again on
any Filename-column/subfolder/extension-match change, rendered under
File Location as "N of M CSV rows matched in this folder".
*Verified*: `load_csv_dropped` against a real temp CSV + matching
image file — confirmed folder auto-grab and correct `preview_match`
counts (1 of 2 matched, as expected from the fixture);
`set_embed_folder_dropped` tested against a real folder path, a file
path within it (parent-dir fallback), and a nonexistent path (correct
error). *Not verified*: the real pywebview drop event firing on
Windows (mechanism is proven elsewhere in this codebase, but not
independently re-tested here).

**3. Image to Prompt Generator — root causes found and fixed for all
four sub-issues.**
- *"Clear All doesn't remove images" / dropzone text stuck on the
  left*: **not** a Clear All bug — `clear_prompt_batch()` already
  fully clears server-side state. The actual bug was CSS: `base.css`'s
  `#importGrid[hidden] { display: none !important; }` only ever
  targeted the Meta Generator's own grid id, never
  `#importGridPrompt`, so the Prompt page's grid never actually
  collapsed to `display:none` — leaving it visually squeezed into a
  sliver on the right and the "click here" text stuck on the left
  instead of centered. Generalized to the `.import-grid[hidden]` class
  selector (both grids already carry that class) so this can't
  silently regress again for a third grid later.
- *Inaccurate prompts (a screenshot of this app producing "fisherman
  with a boat")*: the prompt template itself never told the model to
  ground its description in the actual image content, so it was free
  to default to generic stock-photo tropes. Rewrote
  `build_prompt_prompt` and `build_image_to_prompts_prompt` in
  `prompt_generator.py` to explicitly require describing what's
  literally visible (and to describe screenshots/UI/diagrams as what
  they are, not force them into a photography frame).
- *Word cap not respected / not finishing sentences*: `max_words` was
  previously only ever mentioned in the prompt text sent to the model
  — nothing on the Python side enforced it, so a model running long
  produced a prompt over the stated cap. Added `enforce_word_cap()` to
  `parser.py` (word-count counterpart to the existing character-based
  `smart_trim`) and wired it into both `session.py`'s prompt-mode path
  and `prompt_to_prompt/engine.py`'s per-prompt cleanup — same
  sentence-boundary-first, then clause-boundary fallback approach, so
  a trim never leaves a dangling fragment.
- *Max cap raised to 500*: `optMaxPromptWords` slider's `max` attribute
  bumped 200 → 500 in `index.html` (was already correctly read into
  `options.max_words` by `promptgen.js`, only the range needed
  changing); P2P's new Prompt Length slider uses the same 10–500
  range.
*Verified*: `enforce_word_cap` exercised directly against real text at
caps of 5, 20, and 500 words — confirmed it never exceeds the cap and
always ends on a complete sentence/clause, never mid-word.
*Not verified*: actual output quality from a real AI provider call
(needs a live API key) — the prompt-template and enforcement fixes are
the two concrete, verifiable levers available without one; genuine
model-level accuracy on a specific image can't be fully guaranteed by
prompt wording alone.

**4. Platform description toggle re-enable bug — fixed.** Root cause:
`applyPlatformDefaults()` in `app.js` correctly turned the toggle
*off* for a no-description platform (Adobe Stock) but the "has
description" branch never touched `.checked` at all — only
`.max`/`.value` — so switching to a platform that does support
descriptions (Shutterstock etc.) left the toggle off until manually
flipped. Now explicitly sets `.checked = true` in that branch.

**5. Light theme background swatches — added.** Root cause: the 3
background swatches in `appearance.js` were a single hardcoded
dark-only array, and `theme.js`'s `applyBgOverride()` was a deliberate
no-op outside dark mode — so White mode showed no usable swatches at
all. Added a separate light-mode preset array (Pure White / Warm Ivory
/ Cool Light Gray, mirroring the dark set's Vantablack / Dark Charcoal
/ Dark Gray), made `applyBgOverride` mode-agnostic, and — to avoid a
new bug where a dark override would get applied as White mode's
background on switch — split the saved preference into
`theme_bg_base_dark` / `theme_bg_base_light` keys instead of one
shared `theme_bg_base` (falls back to the old shared key for dark mode
only, so existing saved prefs aren't lost).

**6. Dashboard CPU/RAM — added; GPU intentionally not attempted.**
`dashboard.py`: new `_resource_usage()` using `psutil` (already listed
in `requirements.txt`), fails soft to `None`/"N/A" per-field rather
than crashing the dashboard. This was removed once before in the CTk
version after reliably showing N/A there — root cause was never
confirmed (possibly PyInstaller not bundling psutil's compiled
backend), so whether it holds up in a real Windows EXE build of this
pywebview version genuinely can't be confirmed from this sandbox; flag
it if it comes back broken. GPU was **not** attempted — there's no
single library that reads usage across NVIDIA/AMD/Intel without an
extra vendor-specific dependency (e.g. `pynvml`, NVIDIA-only), which
felt disproportionate to add for one dashboard field; left out rather
than shipped half-working.
*Verified*: `dashboard._resource_usage()` and the full
`bridge.Api().get_dashboard_data()` path both called directly in this
sandbox — returned real, current CPU%/RAM% values (unfrozen Python,
not a frozen EXE — see caveat above).

**7. Nav icons + border.** All 7 sidebar icons replaced with flat
single-color fill glyphs (home, tag, hexagon, image, swap-arrows, key,
sliders) — rendered with `cairosvg` and visually inspected as PNGs
before committing to the markup, not just eyeballed as raw SVG path
data. "Thinner horizontally" was ambiguous (no border was actually
present in the CSS before) — interpreted as: the active/hover
highlight shape previously spanned the sidebar's full width
edge-to-edge; added a horizontal inset (`margin: 0 6px`) so it hugs
each icon instead, without changing the sidebar's own width. Flag if
this isn't the intended reading once you see it rendered.

**Not done this batch / open items:**
- No real GUI verification was possible this session (no
  Xvfb+pywebview backend set up) — every frontend change above is
  verified only by syntax-checking (`node --check`), HTML
  well-formedness, and cross-referencing every `getElementById` call
  against the actual markup (zero missing ids found), plus real
  backend-side exercise of the underlying logic. Please screenshot-
  verify the rebuilt P2P page and the embed drag-drop against the
  reference screenshots before relying on the visual layout.
- P2P's "From Image" mode has no per-slot drag-and-drop reordering —
  only add (click "+") and remove (✕); slots fill in the order images
  are added.
- License/Help nav items visible in the old Python app's screenshots
  were not added — out of scope of the numbered list, flagging in case
  they were assumed included.

APP_VERSION bumped to v0.8.7 in `core/constants.py`.


## v0.8.6 (batch 2) — Image to Prompt Generator page built (handoff item 1, done); real drag-drop routing bug found and fixed

Continuing straight from batch 1 of this same version (below) in the
same session. Delivers handoff item 1 in full: the Image to Prompt
Generator page now exists and works end-to-end using the same
Session/session.py pipeline Meta Generator already runs, per the
v0.8.5 groundwork. Items 2 and 3 (Prompt-to-Prompt redesign, Embed
fixes) are still not started — see "Not done yet" below.

**Frontend:** `<section id="page-prompt">` added to `index.html`,
built on the same dropzone/import-grid/card-grid pattern as
`#page-meta` but with its own DOM ids throughout (`dropzonePrompt`,
`cardGridPrompt`, `controlPanelPrompt`, etc — both pages coexist in
the DOM, checked for zero id collisions against the rest of the file).
Control panel: API INFO summary + "Check" link (same pattern as Meta
Generator's, added earlier in this version), Concurrent Generations
slider, PROMPT SETTINGS section (Max Prompt Words slider, default 60;
Prompt Style dropdown), Custom System Prompt textarea + Reset. Header
row: Clear All / Generate (N) / Export CSV / Save, matching the
layout in Hasib's screenshot 3. New `cardTemplatePrompt` template: a
single Prompt field with copy/paste/edit, no Title/Description/
Keywords. New `frontend/js/promptgen.js` (added to `index.html`'s
script list) — structurally a copy of `app.js`'s Meta Generator
wiring with the platform/file-type/prefix-suffix logic stripped out,
listening for `prompt_card_update`/`prompt_task_progress`/
`prompt_status_text`/`prompt_task_completed`/`prompt_thumb_ready`
(the `prompt_` prefix session.py already emits, verified in v0.8.5).

**Backend (`bridge.py`):** added `get_prompt_options()`,
`browse_prompt_images()`, `get_prompt_thumb()`, `clear_prompt_batch()`,
`get_prompt_batch_state()`, `update_prompt_card_field()`,
`start_prompt_generation(options)` (hardcodes `mode="prompt"`),
`pause_prompt_generation()`, `stop_prompt_generation()`,
`export_prompt_csv(auto)` — all thin wrappers around
`self.prompt_session` mirroring `self.session`'s existing methods 1:1,
exactly as the handoff note specified, no new generation logic.
`export_prompt_csv`/`export_csv` (Meta's, added earlier this version)
both now go through the one shared `_export_csv_session(session,
auto)` helper, as planned when that helper was first written.

**New constant:** `core/constants.py` gained `PROMPT_GEN_STYLES`, a
small dict of image-generation style labels ("Realistic Photography",
"Cinematic", "Digital Art", "Illustration", "Anime", "3D Render",
"Product Photography", "Minimalist", plus an Auto default) feeding
`build_prompt_prompt(styles=...)` via the new dropdown. This is a new
list, separate from the existing `CONTENT_SUFFIXES` (which describes
what the *source image* is, for metadata generation, not what style
the *generated prompt* should ask for) — **the exact style set/labels
were not specified anywhere in the handoff, this is my own reasonable
default list, not something Hasib asked for by name.** Easy to edit
in one place if he wants different/more options.

**Real bug found while building this (not guessed):** `app.py`'s
`_bind_real_drag_drop`/`on_drop` was hardcoded to always add dropped
files into `bridge.api_instance.session` (Meta Generator) regardless
of which page was actually showing — harmless while only one page had
a dropzone, but a real silent-misroute bug now that the Prompt page
has its own. Fixed by reading the currently active sidebar page via a
synchronous `window.evaluate_js("document.querySelector('.nav-item.
active')?.dataset.page || 'meta'")` inside `on_drop` and routing to
`prompt_session`/`prompt_import_completed` when it's `"prompt"`,
`session`/`import_completed` otherwise (including the fallback path
if that read fails, same fail-soft spirit as the rest of that
function).

**Assumption flagged, not a confirmed spec:** the "💾 Save" button in
the new page's header row (present in Hasib's screenshot 3 reference
but never defined anywhere in the handoff note or existing code —
Meta Generator itself has no equivalent button, only an unrelated
`apiSaveKeyBtn` in the API key modal) was implemented as: push
whatever's currently displayed for every card back to the backend via
`update_prompt_card_field` (covers edits left mid-type without
leaving edit mode), then show a "Saved N prompt(s)" status line. If
Hasib means something else by that button (e.g. writing prompts back
into the image files' own metadata, or saving control-panel settings
as new defaults), this needs revisiting — flagging honestly rather
than guessing silently.

### Verification note
Same environment limitation as batch 1 above: no network in this
sandbox, so `pywebview` can't be installed and the full `import
bridge, session, embedder, settings, prompt2prompt, dashboard` smoke
test / an actual Xvfb launch+screenshot could not be run. What *was*
verified this batch:
- `python3 -m py_compile` clean on every backend `.py` file
  (including the changed `app.py` and `bridge.py`), from a **freshly
  re-extracted copy of the delivered zip**, not just the working
  directory.
- `node --check` clean on every frontend `.js` file, including the
  new `promptgen.js`.
- Zero duplicate DOM `id` attributes anywhere in `index.html` after
  the new section was added (checked across the whole file, not just
  the new section).
- `<div>` open/close tag count balanced (22/22) inside the new
  `#page-prompt` section specifically.
- `bridge.py`'s new prompt_* methods checked by eye against
  `session.py`'s real method signatures (`add_paths`, `thumb_cache`,
  `clear`, `completion_order`/`results`, `update_field`,
  `start_generation`, `pause`, `stop`) — all exist with the signatures
  assumed here.

Not independently confirmed: actually running the page, generating a
real prompt end-to-end, or seeing the control panel/card grid render
correctly. Treat as "should work, matches the real backend contract
and the existing page's pattern by inspection" rather than "seen
working" until Hasib runs it.

### Not done yet (still open from the v0.8.5 handoff)
- Prompt-to-Prompt redesign to match Hasib's two reference screenshots
  (tabs, 5/10/20/50/100/200 buttons, Low/Medium/High buttons, Prompt
  Style dropdown, Prompt Length slider, 15-image reference grid,
  Select All/Copy All/Export TXT/Export CSV toolbar) — `page-p2p`/
  `p2p.js` are still the old plain-controls version; `start_prompt_to_
  prompt()`'s signature still needs checking/extending for
  `source_image`/`target_words`.
- Embed page: no Reset button; `browse_csv`/`browse_embed_folder`
  still don't accept a `start_dir` param; `EmbedSession` doesn't store
  `csv_path` yet.

## v0.8.6 (batch 1, PARTIAL — nav/panel visual fixes + Meta Generator control panel tweaks done; Image to Prompt page, P2P redesign, Embed fixes not started)

Hasib reported 3 visual problems plus asked for item 4 from the
v0.8.5 handoff (Meta Generator control panel tweaks). This batch did
the visual fixes and item 4; items 1-3 from the handoff (Image to
Prompt Generator page, Prompt-to-Prompt redesign, Embed page fixes)
were **not started** — flagging honestly rather than claiming partial
credit on work not touched.

**Nav icons/rail (Hasib's report: icons deformed, rail too wide):**
`.nav-icon` 26px→20px, `.sidebar` width 88px→72px (padding tightened
to match), `.sidebar .nav-item` padding/gap reduced, label font-size
15px→12px so the smaller icons don't look lost. All icons were
already square viewBoxes (`0 0 24 24`) rendered into a square CSS box,
so there was no actual stretch/aspect-ratio bug in the SVGs
themselves — the "deformation" read is consistent with icons simply
being oversized for a compact rail at 26px; sizing down is the fix
applied. Not independently confirmed against a screenshot (see
Verification note below).

**Panel collapse button (`.panel-collapse-btn`) taller + more
roundish:** height 40px→56px, border-radius 6px→16px. Position/width
unchanged.

**Meta Generator control panel (v0.8.5 handoff item 4), now done:**
- `btnCheckKeys` removed from the bottom `meta-action-row`, replaced
  with a small "Check" text link directly beside the "🔑 API INFO"
  label (`.key-summary-header-row` flex wrapper, `.key-check-link`
  style) — same click handler/id, same `get_active_keys_summary()`
  call, just relocated in the DOM and restyled.
- Auto Download CSV toggle added beside Stop in the action row,
  persisted via `save_prefs({meta_auto_download_csv})` /
  `get_prefs()` on load (same pattern as `optConcurrency`), and now
  included as `auto_download_csv` in the `options` object
  `btnGenerate` sends to `start_generation('meta', options)` —
  `session.py` already read this key and handled the auto-export
  (verified in v0.8.5), this batch only added the UI + wiring.
- Manual "⬇ Download CSV" button added next to it, calling a new
  `pywebview.api.export_csv(auto=false)` bridge method. Implemented a
  shared `Api._export_csv_session(session, auto)` helper in
  `bridge.py`: `auto=True` calls `session.export_csv()` directly
  (writes into the batch's common folder, `#_FolderName.csv` naming,
  no dialog); `auto=False` opens a `webview.SAVE_DIALOG` defaulting
  `directory` to `session._common_folder()` and `save_filename` to
  `os.path.basename(session._auto_csv_path(folder))`, then calls
  `session.export_csv(dest)` with the chosen path. `Api.export_csv()`
  currently wires this only to `self.session` (Meta Generator); the
  same helper is written to also take `self.prompt_session` once the
  Image to Prompt Generator page exists (handoff item 1), no rework
  needed there.

**Version bumped to v0.8.6** in both places that matter
(`frontend/index.html`'s `#versionPill`, `backend/core/constants.py`'s
`APP_VERSION`), per Hasib's explicit ask this batch — not a routine
bump.

### Verification note (read before trusting "done" above)
This sandbox has **no network access** this session (`apt-get`/`pip`
both hit `403 Forbidden` trying to fetch `unrar`/`pywebview`/etc), and
`pywebview` isn't already installed here, so:
- `python3 -m py_compile` on every backend `.py` file: **clean.**
- `node --check` on every frontend `.js` file: **clean.**
- The full `import bridge, session, embedder, settings, prompt2prompt,
  dashboard` smoke test from a freshly-extracted zip that v0.8.4/
  v0.8.5 both ran: **could not run** — `bridge.py` imports `webview`,
  which isn't installable here without network. Not run, not faked.
- Actually launching the app under Xvfb and screenshotting the
  changed pages (as v0.8.4/v0.8.5 did to catch real rendering bugs):
  **not done this batch**, same root cause. The CSS/HTML/JS changes
  above are syntax-clean and reviewed by eye against the existing
  patterns in this file, but **not visually confirmed** — treat the
  nav icon sizing and collapse-button shape as "should be right,
  unverified on a real render" until Hasib confirms on his machine.
- `webview.SAVE_DIALOG`'s exact return shape (single string vs a
  1-tuple) varies by pywebview version/platform in ways I couldn't
  check against the installed version here; `_export_csv_session`
  handles both (`result[0] if isinstance(result, (list, tuple)) else
  result`), matching the same defensive pattern already used for
  `browse_csv`'s `OPEN_DIALOG` result — but this exact code path
  (`export_csv(auto=false)`) has not been exercised end-to-end.

### Not done yet (still open from the v0.8.5 handoff)
- Image to Prompt Generator page (handoff item 1): sidebar button and
  backend (`prompt_session`, `mode="prompt"`) exist per v0.8.5, but
  `page-prompt` still doesn't exist in `index.html`, no
  `promptgen.js`, no dedicated card template, no
  `browse_prompt_images`/`start_prompt_generation`/etc bridge methods.
- Prompt-to-Prompt redesign to match Hasib's reference screenshots
  (tabs, 5/10/20/50/100/200 buttons, Low/Medium/High buttons, Prompt
  Style dropdown, Prompt Length slider, 15-image reference grid,
  Select All/Copy All/Export TXT/Export CSV toolbar) — `page-p2p`/
  `p2p.js` are still the old plain-controls version; `start_prompt_to_
  prompt()`'s signature still needs checking/extending for
  `source_image`/`target_words`.
- Embed page: no Reset button; `browse_csv`/`browse_embed_folder`
  still don't accept a `start_dir` param; `EmbedSession` doesn't store
  `csv_path` yet.

## v0.8.5 (batch 1, PARTIAL/INCOMPLETE — see "Not done yet" below) — Taskbar icon real fix, nav icons, backend groundwork for Image to Prompt Generator

This batch ran out of turns before finishing everything Hasib asked
for in one go. What's below is real and verified (syntax-checked +
a clean `import bridge, session, embedder, settings, prompt2prompt,
dashboard` from this exact backend/ folder, `Api()` constructs and
`prompt_session.event_prefix == "prompt_"` as expected) — nothing here
is guessed. See HANDOFF-NOTE.md for the full remaining task list,
written specifically for whichever Claude session picks this up next.

**Taskbar icon — real root cause found (not guessed):**
`icon.ico` only had a single embedded 256×256 frame (checked with
`PIL.Image.open('icon.ico').info['sizes']` → `{(256,256)}`). Windows
picks the closest embedded resolution for the taskbar/title bar
(usually 32px/16px at 100% DPI) and some shell versions silently fall
back to the generic exe icon instead of downscaling a 256px-only ico.
Regenerated `icon.ico` from `icon.png` with the full
16/24/32/48/64/128/256px size set. Also added a belt-and-suspenders
Win32 `WM_SETICON`/`SetClassLongPtrW` call in `app.py` (via ctypes,
`_force_windows_icon()`, run on a background thread that polls for the
window by title) — `webview.start(icon=...)` isn't reliably reaching
the native win32 window's icon on every pywebview/edgechromium build,
so this sets it explicitly as a supplement, never a replacement. Both
changes are additive; neither can be verified on real Windows from
this Linux sandbox, so treat as "the actual, confirmed bug is fixed
and a documented known workaround is layered on top" rather than
"guaranteed fixed" until Hasib confirms on his machine.

**Nav icons replaced (Hasib's request):** all 6 sidebar emoji glyphs
swapped for inline single-color SVG line icons using `currentColor`,
so the existing `.nav-item`/`.nav-item.active` hover/color rules keep
working with zero extra CSS beyond a new `.nav-icon { width/height:
26px }` rule. A 7th nav item (`data-page="prompt"`) was added for the
still-unbuilt Image to Prompt Generator page — the button/icon exists
in the sidebar now, but `page-prompt` doesn't exist in index.html yet
(see handoff note), so this button currently does nothing when clicked.

**Backend groundwork for the Image to Prompt Generator page:** confirmed
`session.py`'s `start_generation(mode, options, prefs)` already fully
supports `mode="prompt"` end-to-end (`engine/prompt_generator.py`'s
`build_prompt_prompt()` was already there, already wired into
`session.py`'s `_gen_thread`, just never exposed on any frontend page)
— this means the new page needs frontend + bridge wiring only, no new
AI/generation logic. Refactored `Session.__init__` to take an
`event_prefix` param (default `""`, so Meta Generator's existing
event names — `card_update`, `task_progress`, etc — are byte-for-byte
unchanged, zero risk to the working Meta Generator page) so a second,
fully independent `Session` instance can push its own
`prompt_card_update`/`prompt_task_progress`/etc events without
colliding with Meta Generator's. `bridge.py`'s `Api.__init__` now
constructs `self.prompt_session = Session(event_prefix="prompt_")`,
completely separate imported-files/results/running state from
`self.session`. `update_field()` now also accepts `field="prompt"`
(previously only title/desc/kw), needed so a Prompt Generator card's
pencil-edit can push back to the backend. Added `Session.export_csv()`
and `Session._auto_csv_path()` implementing the requested
`#_FolderName.csv` naming (numbered, never overwrites an existing
file in the target folder) and wired `export_csv()` into
`_on_all_done()` behind a new `self.auto_download_csv` flag (read from
`options.get("auto_download_csv")`) for the requested Auto Download
CSV toggle — **the toggle itself and the manual Download CSV button do
not exist in the frontend yet**, only the backend plumbing they'll
call.

**Version bumped to v0.8.5** in both places that actually matter
(`frontend/index.html`'s `#versionPill` text and
`backend/core/constants.py`'s `APP_VERSION`) — per Hasib's explicit
instruction, nowhere else auto-bumps or displays a version.

### Not done yet in this batch (see HANDOFF-NOTE.md)
- Image to Prompt Generator page: no `frontend/index.html` `page-prompt`
  section, no `frontend/js/promptgen.js`, no dedicated card template yet.
  The sidebar button exists but goes nowhere.
- Prompt-to-Prompt page redesign to match Hasib's two reference
  screenshots (tabs, 5/10/20/50/100/200 count buttons, Low/Medium/High
  creativity buttons, Prompt Style dropdown, Prompt Length slider,
  15-image reference grid for Image mode) — `p2p.js`/the `page-p2p`
  markup are still the old plain-controls version.
- Embed page: no Reset button yet; `browse_csv`/`browse_embed_folder`
  in `bridge.py` don't yet accept/pass a starting directory, so the
  native dialog still doesn't open at the currently-selected
  folder/CSV location.
- Meta Generator: `btnCheckKeys` is still in the bottom action row
  (not yet moved into the control panel next to "🔑 API INFO"); no
  Auto Download CSV toggle or manual Download CSV button next to Stop
  yet (backend support for both exists now, per above — just not
  called from anywhere in the frontend).

## v0.8.4 (batch 2) — App icon: real bug found and fixed (icon.ico/icon.png were never actually wired to the window)

Hasib asked why `icon.png`/`icon.ico` in the root folder weren't
showing as the app icon.

**Root cause:** the only icon-related code in the whole project was
`core/utils.py`'s `set_window_icon()` — a leftover from the old
CustomTkinter app. It calls `window.iconbitmap()`/`window.iconphoto()`,
methods that only exist on `tk.Tk`/`ctk.CTk` windows, and it's **never
called anywhere in this codebase** (`grep -rn "set_window_icon("`
turns up only its own definition). This pywebview build has no Tk
window at all, so that function was always fully dead code — `icon.
ico`/`icon.png` were being *resolved* correctly by the existing
`_icon_paths()` helper (same root-folder-next-to-app.py logic that
already works for `exiftool.exe`), just never *applied* to anything.

**Fix:** pywebview's real icon hook is the `icon=` keyword on
`webview.start()` (added in pywebview 6.x — `requirements.txt` already
pins `pywebview>=6.2`, so no dependency bump needed), not a per-window
call. `app.py`'s `main()` now resolves `icon.ico`/`icon.png` via the
existing `_icon_paths()` and passes the right one to `webview.start
(icon=...)` — `.ico` preferred on Windows (native taskbar icon
format), falling back to `.png` otherwise or if only one file exists.

**Verified:** `python3 -m py_compile app.py` clean; confirmed
`_icon_paths()` correctly finds `icon.ico`/`icon.png` when they're
dropped in the app root (tested by placing dummy files next to
`app.py` and re-resolving) and returns `(None, None)` when they're
absent, so the fallback path (no icon file — just whatever the OS
default is) doesn't break anything either way.
**Not verified:** the actual rendered taskbar/titlebar icon on a real
Windows run — no GUI environment was launched this session. Please
confirm on your machine that both `icon.ico` and `icon.png` are
sitting directly in the same folder as `app.py` (not inside
`backend/` or `frontend/`), then run and check the taskbar/titlebar.

## v0.8.4 — Nav icons bigger, Browse repositioned, API info header, platform-rules bug fixed, Embedder rebuilt to match original layout, Embed button now in-page (no popup), status bar removed

Batch scoped down mid-session at Hasib's request: **Prompt-to-Prompt's
old-style rebuild (tabs, count/creativity button groups, 15-slot image
grid) was NOT done in this batch** — deliberately skipped to get a
smaller, real batch packaged instead of a half-finished P2P page. It's
still on `frontend/index.html`'s current (working, just not
old-style-matched) P2P markup from v0.8.3. Do this next.

**1. Sidebar nav icons ~50% bigger.** `.sidebar .nav-item` font-size
18px→27px, label span 10px→15px, sidebar width 72px→88px and padding
bumped so the bigger glyphs don't clip.

**2. Browse button moved to the far right** of Meta Generator's action
row, separated from Embed/Clear/Generate/Pause/Stop/Check-keys by
`justify-content:space-between` (wrapped the other 6 buttons in their
own `.meta-action-group` div so they stay clustered together on the
left).

**3. API key summary box now has a header** ("🔑 API INFO") — those 3
numbers (Active/Stored/Providers) had no label explaining what they
were.

**4. Real bug found and fixed: platform switching was silently doing
nothing.** `core/constants.py`'s `PLATFORM_RULES` used keys `kw`/
`title`/`desc`, but `app.js`'s `applyPlatformDefaults()` was reading
`rule.title_chars`/`rule.desc_chars`/`rule.kw_count` — always
`undefined`, so every platform dropdown change was a no-op before this
fix. Renamed the dict keys to match, and:
  - Added `has_desc` per platform (Adobe Stock = `False` — checked
    against Adobe's current contributor docs Sep 2026: Title (≤200
    chars) + Keywords (≤49) only, no separate description field).
    Selecting Adobe Stock now disables the Description toggle/slider
    in the control panel instead of just capping its length.
  - `applyPlatformDefaults()` now also updates the sliders' `max`
    attribute, not just their starting value, so you can't drag past a
    platform's real limit after switching to it.
  - **Caveat:** the other 7 platforms' numeric limits (Shutterstock,
    Getty, Freepik, Pond5, iStock, Vecteezy) are carried over unchanged
    from before this batch — they're working figures from public
    contributor guides, not pulled from an official rate-limit API.
    Worth a periodic recheck, same as Adobe Stock.
  - **Concurrent Generations now defaults to 10** on a fresh install
    (was 4), and is saved/restored via the existing real
    `get_prefs`/`save_prefs` merge bridge (`meta_concurrency` key),
    saved on slider release (`change`), not every drag tick.

**5. Meta Embedder rebuilt to match the original CTk app's exact
fields and positions** (Hasib's screenshot, "no exception"):
  - Numbered "1 Load CSV" / "2 File Location" steps, each with its own
    Browse button and a status line under it.
  - FILENAME / TITLE / KEYWORDS / DESCRIPTION column-mapping dropdowns
    in a 2×2 grid (was a single row of 4 labeled selects before).
  - Exactly 4 toggles, relabeled to match the original app's actual
    wording — traced each one against what it really does in
    `embedder.py`/`core/utils.py` before relabeling, not guessed:
    - "Match Filename Only" = `optMatchExt` (`match_ext_only`) — despite
      the old JS-build label "Match extension only", this flag actually
      means *fall back to matching by filename stem, ignoring a
      different extension* (see `index_lookup()`), which is what "Match
      Filename Only" describes.
    - "Include Sub-Folders" = `optSubfolders` (was "Search subfolders").
    - "Remove Program Name" = `optRmProgressive` (`remove_progressive`)
      — this strips `Software`/`CreatorTool`/`HistorySoftwareAgent` EXIF
      fields, i.e. the program name, despite its internal option name.
    - "Replace Filename" = new `optReplaceFilename` checkbox, now wired
      to the real `replace_filename` option (`embedder.py` already
      supported this — it was just hardcoded to `false` from the
      frontend before, never exposed).
  - **Removed from this page's UI** (present before, not in the
    original screenshot, dropped per Hasib's "no exception" ask):
    the Concurrent slider (embed now runs at a fixed default of 6,
    `EMBED_CONCURRENCY` in `embed.js`) and the Preview Match button/
    "Remove copyright" toggle (`remove_copyright` still runs, hardcoded
    `true`, just not exposed). Backend methods for both are untouched
    in case either is wanted back later.
  - **Did not add** a stop/cancel button next to Start Embedding even
    though the reference screenshot shows one — `embedder.py`'s
    `_embed_thread` has no cancellation hook, so a button there would
    look real but do nothing. Flagging this rather than shipping a
    fake control; happy to wire real mid-run cancellation as a
    follow-up if wanted.
  - Layout: left column (steps/mapping/toggles/start/progress) +
    fixed-width Activity Log column on the right, replacing the old
    stacked single-column layout.

**6. Embed button: no more popup window.** Previously clicked through
to `Api.open_embed_popup()`, a separate 560×700 pywebview window.
Per Hasib's explicit "no pop-up" request, it now calls `goToPage
('embed')` (in-app nav) and `embed.js`'s new `autoLoadEmbedBatch()`
function — same real `auto_load_embed()` bridge call the popup used,
just triggered in the main window instead. The old `?popup=embed&auto=1`
URL path in `bridge.py`/`nav.js` still works (harmless, unused by the
frontend now) in case the popup approach is wanted again later.

**7. Bottom status bar removed.** The `<footer class="statusbar">`
(done/failed/pending pills + ExifTool/Drag&Drop line) is gone from
`index.html`. `chrome.js` rewritten to drop the now-nonexistent
`pillDone`/`pillFailed`/`pillPending`/`exifStatus` element lookups
that would otherwise throw on load; `btnStopAll`'s visibility logic
(topbar) is untouched. Height `calc()` formulas that subtracted the
removed 30px bar (`.embed-page`, `.control-panel`) updated to match.

**8. Version bumped to `v0.8.4`** (`core/constants.py`'s
`APP_VERSION` + the topbar version pill) — explicitly requested this
batch, not an auto-increment.

**Verification done this batch:** `python3 -m py_compile` on every
touched backend file; a real import of `bridge`, `session`, `embedder`,
`settings`, `dashboard`, `prompt2prompt` after installing `pywebview`
fresh in the sandbox (all import cleanly, no missing-name errors);
`node --check` on every touched frontend JS file; a fresh-extract
`pip`/import check of the whole package before zipping.

**Not verified this batch (be aware before assuming solid):** nothing
was visually rendered — no Xvfb/GTK launch was attempted this session,
so none of items 1–7 above have been seen on screen, only read/
syntax-checked/cross-referenced against the code that consumes them.
The v0.8.2/v0.8.3 fixes this batch builds on (page-stacking CSS bug,
popup mechanics, collapse toggle, import grid, theme colors,
drag-and-drop) were also still awaiting your real-machine confirmation
as of the last handoff — please test both together on your next run
and report back what you see, especially the Embedder page (biggest
structural change this batch) and the Adobe Stock platform switch
(disables Description — confirm it visually greys out/unchecks, not
just that generation behaves correctly).

## v0.8.3 (batch 3) — CI: retry ExifTool install on transient Chocolatey outage

Hasib hit this on a real CI run:
```
Failed to fetch results from V2 feed at 'https://community.chocolatey.org/api/v2/Packages(Id='exiftool',Version='13.59.0')'
with following message : Response status code does not indicate success: 503 (Service Unavailable).
Unable to find package 'exiftool'. Existing packages must be restored before performing an install or update.
```
This is Chocolatey's own community feed returning a 503 — not an app
bug or a mistake in the workflow's logic. `choco install` doesn't
retry on its own, so a single transient blip on their end fails the
whole Windows build. `.github/workflows/build_js.yml`'s "Install
ExifTool" step now retries up to 5 times with exponential backoff
(5s/10s/20s/40s/60s) before giving up, and the final error message
says plainly that it looks like a Chocolatey outage (with a link to
their status page) rather than pointing at the app.

**Honesty note:** this workflow has still never actually been run
(see the file's own top-of-file note — it was UNTESTED before this
change too). I can't trigger a GitHub Actions run or reach
Chocolatey's servers from this sandbox, so this fix is verified only
as: valid YAML (parses cleanly), and the retry logic itself is a
standard, well-understood pattern for transient HTTP 503s — not
confirmed to actually get past a real outage on Hasib's next run.
Please re-run the workflow and report back what happens.

## v0.8.3 (batch 2) — Clear All import-grid bug fixed, dropzone redesigned, topbar refresh button re-centered, control panel key summary, modern Embed page + concurrency

**Version intentionally NOT bumped** (still v0.8.3, per the standing
instruction to stop auto-incrementing until explicitly asked).

**1. Real bug found and fixed: Clear All didn't actually clear the
import grid.** Root cause was the exact same class of bug as the
`.page[hidden]` fix earlier in this file: `#importGrid`'s own
`display: grid` rule in `base.css` always wins over the browser's
built-in `[hidden] { display: none }` rule, because author stylesheet
rules outrank user-agent rules regardless of selector specificity or
order. So `Clear All` correctly reset `importedPaths` and set
`importGrid.hidden = true`, but the grid never actually disappeared —
it stayed laid out in the same flex row as the now-visible
instructional text, got squeezed into a thin sliver on the right side
of the box, and its square cells got crushed into a tall, cropped
shape. That matches exactly what was reported: old thumbnails
"compressing on the right in a portrait crop" while the drag-and-drop
text reappeared on the left. Fixed with `#importGrid[hidden] {
display: none !important; }`.

**2. Dropzone redesigned per request:**
- Removed the old fixed "Browse images…" button column from inside
  the dropzone box entirely.
- The whole dropzone box is now itself the browse trigger: clicking
  anywhere in it opens the native file picker, but only while it's
  still empty (`.dropzone.clickable`, toggled off the instant anything
  is imported) — so clicking on a full grid of thumbnails doesn't
  re-open the picker.
- A small standalone "📁 Browse" button was added to the action row,
  aligned with Clear All / Generate / Pause / Stop / Check active
  keys, as the fallback way to browse once the box is full.
- The instructional text and the import grid remain mutually
  exclusive and toggle correctly now that bug #1 above is fixed.

**3. Topbar Refresh button no longer sits high in its row:** `.btn`'s
default margin is bottom-only (`0 8px 8px 0`), which is fine in a
wrapping button row but, inside the topbar's single-row flex,
`align-items: center` centers the button's *margin box* — 8px taller
on the bottom than the top — so the button itself landed a few pixels
above true center. Fixed with `.topbar-right .btn { margin: 0; }`
(the row's own `gap: 14px` already handles spacing).

**4. Control panel: API Manager button removed, counts-only summary
kept.** The control panel's own "🔑 API Manager" button (which opened
the small popup window) is gone — API Manager is still reachable from
the sidebar's API nav item and the Dashboard's quick-launch tile. The
panel now shows three counts: active keys, stored keys, and providers
with at least one stored key. `bridge.py`'s `get_active_keys_summary`
now also returns `stored_count`/`provider_count`, computed from the
same real `settings.get_provider_summary()` the API Manager page
itself is built from, so these can't drift out of sync with it.

**5. Embed page redesigned, with a new Concurrent control and a
full-height activity log:**
- Controls are now grouped into labeled sections (Source, Column
  Mapping, Options) instead of one flat stack of rows.
- New "Concurrent" slider (1–20x, default 6x) — same pattern as Meta
  Generator's "Concurrent Generations." `embedder.py`'s
  `_embed_thread` previously hardcoded `max_workers=6` in its
  `TaskManager().run_batch(...)` call; it now reads
  `options.get("concurrency")`, falling back to 6 if not sent.
- The Activity Log panel is now a separate panel below the controls
  that flexes to fill the rest of the window height
  (`.embed-page`/`.embed-log-panel`, same height formula already used
  by `.control-panel`'s sticky sizing) instead of being capped at a
  fixed 260px.

**Honesty note — what's verified here vs. still open:** every JS file
syntax-checked clean (`node -c`), every `getElementById`/`querySelector`
reference used by `app.js`/`embed.js`/`chrome.js` was cross-checked
programmatically against the actual ids/classes in the rewritten
`index.html` (no dangling references), both modified Python files
compile clean, and the zip re-imports cleanly from a fresh extract.
**Not visually confirmed on a real screen**: this sandbox has no
GTK/WebKit or browser engine available this round (and no network
access to install one), so unlike some earlier batches this one
could not be screenshot-verified end to end — please test on your
machine, especially the Clear All fix and the new dropzone click
behavior, before anything further is built on top of it. The root
cause and fix for bug #1 are the same well-established mechanism
(author-vs-user-agent stylesheet origin) already proven correct by
the identical `.page[hidden]` fix earlier in this file, which *was*
screenshot-verified at the time.

## v0.8.3 — Import grid rework, White theme, Clear All temp-wipe, collapse-button fix, fixed 3-column cards, per-field copy/paste/edit, Embed button restored

**Scope: a requested batch of 6 fixes/features on top of v0.8.2. None of
this has been visually confirmed on Hasib's real Windows machine yet —
see the honesty note at the end of this entry for exactly what's been
verified here vs. what still needs his eyes.**

**1. Import grid / dropzone rebuilt (was growing vertically without bound):**
- `.dropzone` is now a fixed-height (258px) two-column box, not a
  shrink-to-fit block that got taller and taller as it stacked "text
  above button above grid" vertically.
- Right column (`.dropzone-browse`) is a fixed-width strip that holds
  only the Browse button — it never moves, regardless of import state.
- Left column (`.dropzone-media`) holds the instructional text OR the
  import grid, mutually exclusive: the text vanishes the instant
  anything is imported/dropped, and the grid takes its place.
- Import grid enlarged from 8×2 (16 slots) to **10×3 (30 slots)**, with
  the same "+N more" overflow cell in the last slot once you exceed 30.
- The dropzone itself no longer expands/collapses — if the rest of the
  page (action row + card grid below) doesn't fit the window, `.content`
  scrolls as a whole, same as it already did.
- Scrollbars (page, control-panel, key list, embed log, etc.) are now
  styled via `::-webkit-scrollbar` + `scrollbar-color`, both driven off
  the same CSS vars as everything else — so they repaint automatically
  to match whichever theme is active, dark or white.

**2. New White theme, and themes now actually persist:**
- New `frontend/js/theme.js`: a real per-mode palette (`--bg1`, `--bg2`,
  `--nav-bg`, `--text`, `--text-dim`, `--border`) for Dark and White,
  applied to `:root` — every panel/card/border/scrollbar in `base.css`
  already keys off these vars, so nothing else needed to change to
  "become" a white theme.
- Settings → new "Theme" panel with Dark/White buttons, above the
  existing Background Color (now explicitly scoped as "fine-tunes the
  Dark theme's base shade") and Accent Color panels.
- **Real bug found and fixed while building this:** `save_prefs` was
  already writing `theme_bg_base`/`theme_accent_base` to disk, but
  nothing ever read them back — the app always booted into the
  hardcoded dark `:root` defaults no matter what was saved. `theme.js`
  now loads and re-applies the saved theme (mode + bg override + accent)
  on every page load, including popup windows, so a choice actually
  survives a restart.

**3. Clear All now wipes the imported images/cards too, and cleans temp
folders (never touches API keys/settings):**
- `Session.clear()` now also calls the original app's own
  `clear_gen_preview_cache()` / `clear_thumb_cache()` (unmodified,
  already existed in `core/utils.py`, and already documented there as
  never touching `prefs.json` by construction — only ever look inside
  their own `.cache/*` subfolders) plus deletes the new working-CSV
  export folder (see item 5). API keys and every other setting live in
  `prefs.json`, which none of this code path ever opens.
- Verified directly in this session (not just read): wrote a real
  working CSV to disk, confirmed it existed, called `clear()`, confirmed
  the file was actually gone and `batch_complete` reset to `False`.

**4. Collapse/expand button no longer drifts vertically:**
- Root cause: `.panel-collapse-btn`'s `top: 50%` was relative to
  `.control-panel`'s own height, which changed every time panel content
  changed size (Advanced Options open/close, prefix/suffix fields
  appearing) — so 50% landed at a different pixel each time.
- Fix: `.control-panel` now gets a fixed, viewport-relative height
  (`position: sticky` + `height: calc(100vh - …)`), with its own content
  scrolling internally (`.control-panel-inner { overflow-y: auto }`)
  instead of growing the box. The button's `top: 50%` is now always the
  same spot, expanded or collapsed.

**5. Card grid: fixed 3-column layout, cards no longer reshape as a
batch streams in:**
- `.card-grid` changed from `repeat(auto-fill, minmax(280px,1fr))`
  (however many columns fit) to a fixed `repeat(3, 1fr)` — always
  exactly 3 across. Collapsing the left control panel gives `.meta-content`
  more width, which these 3 columns divide up automatically — same 3
  cards per row, each one visibly wider, no separate code path needed.
- `.card` gets a fixed `min-height` set from the start (176px, or 232px
  via a `.has-desc` class when Description is on) instead of an
  intrinsic height that could shift as content changed.

**6. Per-card copy/paste/count/edit controls added to every card:**
- Title/Description/Keywords each get a small copy icon button and a
  paste icon button, plus a live count next to the field label: Title
  shows a character count, Description shows a word count, Keywords
  shows how many keywords were actually generated (comma-split, empties
  ignored).
- New pencil (✎) button, bottom-right of each card: toggles that ONE
  card into an editable state (`contenteditable` on its three text
  fields) — every other card on the grid is untouched. Toggling edit
  off (or pasting into a field) pushes the change to a new
  `Api.update_card_field(path, field, value)` bridge method, which
  updates the in-memory result and rewrites the working CSV if one
  exists — so an edit made here is reflected if you then click Embed.

**7. Embed button restored (confirmed dropped during the JS migration):**
- Traced against `CHANGELOG.md`'s own pre-migration history: the
  original CTk app had an "Embed" button, to the left of Clear All,
  shown only after a full **natural** generation completion (never
  through Stop/Pause), that opened a small popup pre-loaded with the
  batch's own working CSV + folder. This never got ported when the UI
  moved to JS — `backend/embedder.py`'s `EmbedSession` and all of
  `bridge.py`'s `browse_csv`/`start_embed`/etc. were already fully
  wired from v0.8.2, just nothing on the Meta Generator page ever
  called them together.
- `session.py`: results are now auto-written to a working CSV
  (`Filename, Title, Description, Keywords`) the moment a batch
  finishes naturally (`_write_working_csv`, called from `_on_all_done`)
  — same intent as the original app's always-on-disk working CSV,
  described in this changelog's own v0.7-era "Save button" entry.
  Tracks the batch's common folder alongside it.
- `bridge.py`: new `open_embed_popup()` (same real-secondary-window
  pattern as `open_api_manager_popup()`, sharing the same `Api`
  instance/session) and `auto_load_embed()` (loads that working CSV +
  folder straight into the shared `EmbedSession`, no manual "Load
  CSV…"/"Select folder…" click needed).
- Frontend: new `#btnEmbedBatch` button, left of Clear All, hidden by
  default; shown on `task_completed` (natural completion only), hidden
  again the moment a new generation starts or Clear All runs. Clicking
  it opens the popup at `?popup=embed&auto=1`; `embed.js` detects that
  and calls `auto_load_embed()` on load, filling in CSV rows/columns
  and the folder exactly like a manual "Load CSV…" would.

**Honesty note — what's actually verified here vs. still open:**
- Every backend change (`session.py`, `bridge.py`) was exercised for
  real in this sandbox: imported cleanly from a freshly-copied tree,
  instantiated `Api()`/`Session()`, and the working-CSV
  write/edit/Clear-All-wipe sequence was run end-to-end with real file
  I/O (see the commands, not just a read-through) — `pywebview` itself
  isn't installable here (no network egress in this sandbox), so a
  minimal stub stood in for it purely to let the rest of the real code
  import and run; that stub is **not** part of this zip.
- Every JS file was syntax-checked, and every `getElementById`/`.card-field`
  reference used by `app.js`/`embed.js`/`appearance.js`/`theme.js` was
  cross-checked against the actual IDs/classes in the rewritten
  `index.html` — no dangling references.
- **Not visually confirmed on a real screen**, dark or light: the new
  dropzone layout, the White theme's actual look, the collapse button's
  now-fixed position, the 3-column card grid at real card content
  sizes, the per-card copy/paste/edit controls, or the Embed popup's
  auto-load. This sandbox's GTK/WebKit environment wasn't used this
  round (kept the session focused on getting all 6 changes done inside
  the available time) — please test this batch on your machine and
  report back before anything further is built on top of it.

## v0.8 — JS frontend migration, Stage 3: verified pywebview shell

**Scope note: this is Stage 3 of an 8-stage migration plan (see
README_JS_MIGRATION.md), not a rebuilt app.** No screens are recreated
yet. This batch exists to prove the new architecture's core seam works
with real code before committing to rebuilding every screen on top of
it — per the "don't attempt a rushed full version" principle already
established for this project.

**What changed:**
- New top-level shell: `app.py` launches a pywebview window (GTK+WebKit
  on Linux, WebView2 on Windows) instead of `App(DnDCTk).mainloop()`.
- New `backend/bridge.py`: exposes an `Api` class to JS as
  `pywebview.api.*`, each method a thin wrapper calling real existing
  backend functions directly (`core/config.py`, `engine/ai_providers.py`)
  — no reimplemented logic.
- New push-event seam: `bridge.ui_event_queue` + `start_event_drain()`
  replace the five `self.after()` poll loops in `main_window.py` with
  one drain loop that batches queued events and delivers them to JS via
  `window.evaluate_js()`. This preserves the project's core
  thread-safety rule ("no Tk call ever originates on a background
  thread") in its new form: no `evaluate_js` call originates on a
  background thread either — workers only ever touch the queue.
- New minimal frontend (`frontend/`): sidebar nav shell, a drop zone
  with real drag-enter/leave visual feedback (file handling not wired),
  a demo panel proving three real round trips (load prefs, check active
  keys, run a demo batch whose progress bar is driven entirely by real
  backend-pushed events), and a small reusable CSS animation system
  (`fade-target`, `pop-in`, `slide-in-right`) plus a JS helper
  (`animate.js`) instead of one-off per-component animations.
- `backend/` contains **copies** of `core/`, `engine/`, `workers/`,
  `smart_workflow/`, `prompt_to_prompt/` — the original CTk app in the
  root of this delivery is untouched and still fully functional on its
  own.

**Real findings from doing the integration (not from re-reading docs):**
- `core/utils.py` imports `customtkinter` at module level for two
  functions (`make_thumb`, `make_thumb_min_edge`) and `set_window_icon`
  — previously invisible because CTk was always present in the old
  app. Made the import defensive (try/except) in the backend copy so
  the rest of the file (image validation, downscaling, exiftool, file
  indexing — all pure) works without CustomTkinter installed. The two
  CTk-coupled functions are flagged as unusable until Stage 4/5
  replaces them with a plain-PIL + base64 `<img>` path.
- `smart_workflow/panel.py` and `prompt_to_prompt/panel.py` both import
  `tkinter`/`customtkinter` despite living in otherwise-logic packages
  — excluded from the backend copy for that reason; their `engine.py`/
  `pipeline.py`/etc. counterparts (pure) were kept.

**Verified (actually executed under Xvfb + real GTK/WebKit backend,
this session, not asserted from reading code):**
- Window boots, loads the frontend, `pywebview.api` bridge responds.
- `get_prefs()` returns a real dict from the real `core/config.py`.
- `get_active_keys_summary()` calls the real `engine/ai_providers.py`
  key-resolution logic and returns real structured data.
- A real background thread driving `task_progress`/`task_completed`
  through the queue correctly animates the DOM progress bar to 100%
  with zero dropped or reordered events, while the Start button never
  blocked.
- Drag-enter/leave toggles the dropzone's visual state.

**Not done / explicitly deferred (see README_JS_MIGRATION.md for full list):**
- No Meta Generator card grid, Dashboard, Embedder, Settings, or
  Prompt-to-Prompt screens rebuilt yet — Stage 4/5.
- No real file-drop import wiring yet — only the hover visual.
- PyInstaller packaging for the new shell on Windows/Linux — Stage 8.
- WebView2 runtime bundling risk on Windows — not addressed yet.

`core/constants.py` `APP_VERSION` bumped to `v0.8` (minor bump — new
architectural surface, not a bugfix batch).

## Unreleased — GitHub Actions Windows build workflow (untested)

**Update:** added a "Create GitHub Release" step, matching the
original app's `build.yml` pattern (tag from `APP_VERSION`, uploads
the exe, auto-generated release notes). Two deliberate differences
from the original, worth knowing about:
- **Tag is prefixed `js-`** (e.g. `js-v0.8.4`) instead of reusing the
  original app's bare version tags, so this experimental build's
  releases can never collide with your existing MetaZone releases if
  both workflows live in the same repo.
- **`make_latest: false`** — since this build has never been manually
  verified on real Windows, it deliberately does NOT get marked as
  the repo's "Latest release" (which would otherwise show above your
  actual working app on the repo's main page). Flip this to `true`
  once you've confirmed a build actually works.

**Added `.github/workflows/build_js.yml`** — a Windows EXE build for
this JS-frontend app, adapted from the original app's proven
`build.yml`: same real-ExifTool-not-Chocolatey-stub extraction logic,
same `exiftool_pkg` bundling path that `core/utils.py`'s
`find_exiftool()` (unmodified, copied file) already checks for when
frozen — verified by reading that function's actual resolution code,
not guessed.

**This workflow has never actually been run.** Unlike everything else
in this CHANGELOG, this is not "verified by running it" — it's
"written by close adaptation of a workflow that's already proven to
work for the original app," which is a materially weaker claim. Real
open questions this will actually answer once it runs:
- Whether `pip install -r requirements.txt` alone gets pywebview
  working on `windows-latest` (it may need extra Windows-specific
  dependencies pywebview pulls in automatically — untested).
- Whether the WebView2 runtime is present on `windows-latest` runners
  by default (usually is, per GitHub's runner images, but not
  confirmed for this specific setup).
- Whether the exact PyInstaller flags (`--windowed`, `--collect-all
  Pillow`, `--hidden-import sqlite3`, the `exiftool_pkg` add-data
  paths) succeed the same way on Windows as they did in this session's
  verified Linux build.

Expect to iterate on this workflow after its first real run's logs
come back — that's the normal, expected next step, not a sign
something was done wrong here.

## v0.8.2 (continued) — real bug fixes from live Windows/screenshot feedback

**Version note:** staying at v0.8.2 as instructed — no more auto-
incrementing the version on every delivery until this round of fixes
is confirmed actually working. The previous delivery was mislabeled
v0.9; that was a mistake, not an intentional jump, and is corrected
here.

**1. The actual biggest bug: pages stacking on top of each other.**
Real root cause, found and fixed, not patched around: `.meta-page {
display: flex; ... }` had the exact same CSS specificity as the
browser's own `[hidden] { display: none }` rule, and mine loaded
later in the stylesheet — so on every page (Home, API, Settings,
P2P), the Meta Generator page never actually hid, it just sat
stacked underneath/behind whatever page was "active." Fixed with an
explicit `.page[hidden] { display: none !important; }` rule that wins
regardless of any other page's display override, present or future.

**2. API Manager now opens as a real separate popup window**, not a
same-window tab switch. `Api.open_api_manager_popup()` calls
`webview.create_window()` for a genuine second native window (480×720),
loading the same `index.html` with `?popup=api` in the URL — the page
detects that flag and hides the topbar/sidebar/statusbar, showing only
the Settings page full-size. The popup shares the same `Api` instance
(same `Session`, same everything) — it's a smaller view onto the same
running app state, not a second app.

**3. Removed the left control panel's own scrollbar.** It previously
had `overflow-y: auto` with a capped height, creating an awkward
nested scrollbar. Now the whole page scrolls as one (mouse wheel
anywhere works), matching the request directly.

**4. Added a collapse/expand toggle** on the control panel's
right edge (vertically centered) — click to hide the panel entirely
(Meta Generator's content area expands to fill the freed space) or
bring it back.

**5. Reduced the page padding** (top/right of content area) from
`24px` down to `14px 16px` — matches the tighter original layout
instead of the earlier build's oversized margins.

**6. Real image grid view after import.** The dropzone now shows an
8×2 thumbnail grid once images are imported (via Browse or real
drag-drop) — populated from the same thumbnail cache the card grid
already uses, so no extra backend work was needed. When more than 16
images are imported, the last cell shows `+N` for the remainder
instead of a 17th thumbnail. The existing numeric counter next to the
Generate button is unchanged and still shows the exact total.

**7. Theme colors made genuinely distinct**, not three near-identical
darks: Jet Black (`#000000`), Charcoal (`#1c1c1c`), Gray (`#4a4a4a`) —
each a clearly different step instead of the previous set which was
too close together to tell apart at a glance.

**Not addressed this batch (not requested, flagging so it's not
assumed done):** Prompt-to-Prompt visual rebuild, Smart Workflow,
License, Help. Real per-image drag-and-drop still needs confirmation
on an actual Windows run — the popup window and grid-view features
above are new since the last drag-drop test and haven't been
exercised together with it yet.

## v0.8.2 — UI/feature-parity rebuild, matching original screenshots

**Context:** after real Windows testing confirmed the JS shell runs
lag-free (the whole point of this migration), the person shared 7
screenshots of the actual original app UI and flagged that this
build's UI was a bare functional shell missing most of the original's
real controls, plus that drag-and-drop wasn't actually working. This
batch is a direct response: closing that gap page by page, verified
against the actual original code (`ui/dashboard.py`, `ui/main_window.py`,
`ui/api_dialog.py`), not guessed from the screenshots alone.

**Real drag-and-drop, finally working (not visual-only):** found the
actual correct API — plain browser File objects never expose a real
filesystem path (true on every renderer, Windows WebView2 included,
confirmed by reading pywebview's own docs/examples, not assumed).
Bound real drop handling on the Python side via pywebview's DOM event
API (`window.dom.document.events.drop`, pywebview>=5.0), which exposes
`event['dataTransfer']['files'][i]['pywebviewFullPath']`. Calls the
same `session.add_paths()` Browse already uses. Fails soft (try/except)
if `window.dom` isn't available on a given renderer.

**Two real bugs caught and fixed before shipping, not shipped and
found later:**
1. `save_prefs` was overwriting the *entire* prefs file with whatever
   partial dict was passed in — the new Appearance page's theme save
   would have silently wiped every stored API key. Fixed to always
   merge into existing prefs.
2. `pywebview.api.*` calls made at page-load time (Dashboard's initial
   stat load, Settings' initial key list, Meta Generator's new
   Platform/File Type dropdowns) raced against pywebview's own async
   API injection and silently never resolved — confirmed by testing,
   not assumed. Fixed with a shared `onPywebviewReady()` helper using
   pywebview's documented `pywebviewready` event, applied to all three
   pages.

**Global chrome added (present on every original screenshot, absent
before this batch):** top bar (logo mark, version pill, Stop All,
Refresh, Online status, copyright), bottom status bar (real done/
failed/pending counts driven by the same `card_update` events the
card grid uses, real ExifTool-found status via `find_exiftool()`, Drag
& Drop status). Sidebar rebuilt as an icon rail (Home/Meta/Embed/P2P/
API/Setting) instead of the old full-width text-label nav.

**Dashboard — full rebuild** (`backend/dashboard.py` rewritten): all
6 stat cards, Lifetime Statistics, AI Usage (now includes Current
Provider/Model, tracked via new `Session.last_provider`/
`last_model`, set on generation success — ported from the original's
`app._last_ai_provider`/`_last_ai_model`), 4 quick-launch buttons,
Recent Activity, Productivity Insights (images this week, avg speed
in img/min computed from real `lifetime_summary()` seconds/count),
System Status (worker/queue derived from real `Session.running`), and
the 7-day activity chart — now genuinely multi-series (4 lines +
legend, matching the original) instead of the single-series bar chart
from the previous batch. Verified via real screenshot with seeded
stats data: all panels present and correctly populated.

**Meta Generator — full control-panel rebuild**, moved from a flat
top-row of inputs to the original's left sidebar layout: real
Platform dropdown (`PLATFORM_RULES` from `core/constants.py` — 8 real
platforms, selecting one now auto-applies its title/desc/keyword
defaults, matching `_on_platform_change`), real File Type dropdown
(`CONTENT_SUFFIXES`, feeds into `content_phrase` exactly like the
original's `build_meta_prompt` call), Title/Description Length and
Keywords Count as real sliders with live value labels, Generate
Description toggle, Custom System Prompt textarea, Reset to Default,
and a collapsible Advanced Options section (Prefix/Suffix with reveal-
on-toggle text inputs, Single Word Keywords, Avoid Copyright) — all
wired into `start_generation`'s real options. Verified via real
screenshot, both collapsed and with Advanced Options expanded.

**API Manager — full rebuild** (`backend/settings.py` rewritten):
provider tabs with live active-key counts, Model Selection dropdown +
"Apply to All Keys", per-key cards matching the original's exact
mask format (`"..." + key[-10:]`), with working Eye (reveal raw key),
Copy, Test (real `validate_key_live` call), Activate/Deactivate, and
Delete — plus bulk Activate All/Deactivate All. **Deliberate design
choice, not an oversight:** raw keys are sent to the frontend for
reveal/copy, matching the original CTk app's trust model — this is a
local single-user desktop app, not a hosted service, so the same
trust boundary applies.

**New Appearance/Setting page:** background and accent color swatches
+ hex inputs, applying live via CSS custom properties — actually
better than the original here, which required a full app restart to
apply a theme change; this doesn't need one.

**Honest gap — this batch's one unverified piece:** API Manager's
visual layout was built and syntax/wiring-checked (every DOM ID and
class the JS references was confirmed present exactly once in the
HTML), but **not screenshot-verified** like Dashboard and Meta
Generator were. The sandbox's X11/GTK environment became unresponsive
late in this session after many repeated test launches (a resource-
exhaustion issue in this sandbox, not a code bug — confirmed because
plain shell commands kept working fine while anything touching Xvfb
started hanging). Real Windows testing will be the actual
confirmation either way.

**Still not built:** Prompt-to-Prompt's visual rebuild (From Text/
From Image tabs, live word counter — currently still the plainer
Stage 5 version), Smart Workflow, License, Help. Real per-image drag-
drop has not been tested on an actual Windows machine yet (only the
correct API usage has been confirmed via documentation).

## v0.8.5 — real drag-and-drop file import

**Real bug fixed:** drag-and-drop previously only toggled a visual
hover state — dropped files were never actually imported, because
the standard browser File API never exposes a real filesystem path
(confirmed this is a deliberate security decision in all renderers,
not a WebKitGTK-specific limitation — same is true of WebView2 on
Windows).

**Fix:** bound real drop handling on the Python side using
pywebview's DOM event API (`window.dom.document.events.drop +=
DOMEventHandler(...)`, pywebview>=5.0), which exposes the actual path
via `event['dataTransfer']['files'][i]['pywebviewFullPath']`. This
calls `session.add_paths()` directly (the same real validation path
Browse already uses) and emits an `import_completed` event that the
frontend listens for to update the UI — the drop itself never
round-trips through page JS at all, avoiding the security restriction
entirely rather than working around it.

**Fails soft by design:** if `window.dom` isn't available on a given
platform/renderer, binding is wrapped in try/except and silently no-ops
— drag-and-drop stays visual-only and Browse remains the working
import path, rather than crashing the app. Confirmed this fallback
doesn't crash under Xvfb + GTK (this sandbox's renderer) with
`PYWEBVIEW_LOG=debug`, no exceptions logged.

**Honestly unverified:** the actual real-path drop behavior on Windows
(WebView2/edgechromium, which is what pywebview's own official example
targets for this exact feature) has not been tested — no Windows
environment available here. This is now the responsibility of the
next real-machine test.

## v0.8.4 — Stage 8 (Linux only): real PyInstaller onefile build, verified launching

**Scope note:** this is Linux-only. Windows packaging (WebView2
runtime, `exiftool.exe` bundling) is untestable in this sandbox and
remains an open risk — see "Not verified" below.

**What changed:**
- `app.py`: resource resolution now checks `sys._MEIPASS` (where
  PyInstaller's onefile bootloader extracts bundled data at runtime)
  before falling back to the source-tree path, so the same file works
  both `python app.py` (dev) and frozen.
- `app.py`: added two explicit, otherwise-unused imports —
  `import sqlite3` and `import PIL.Image` — purely so PyInstaller's
  static analyzer sees them and bundles their compiled extensions.
  `backend/` is bundled as plain `--add-data`, not analyzed as real
  imports (see below for why), so compiled-extension modules used only
  inside `backend/` are otherwise invisible to PyInstaller's dependency
  graph and silently excluded from the build.
- New `scripts/build_linux.sh`: the actual verified build command
  (`--onefile --add-data frontend:frontend --add-data backend:backend
  --collect-all Pillow`).
- `requirements.txt`: added `pyinstaller` under a build-only section.

**Why `backend/` is bundled as data instead of analyzed:** `app.py`
inserts `backend/` into `sys.path` at runtime and then does plain
`from bridge import Api` — a dynamic, runtime path manipulation
PyInstaller's static analysis can't follow. Bundling `backend/` as
literal data files and importing them by path at runtime (same
mechanism used in dev mode) sidesteps that entirely, at the cost of
needing to manually flag any compiled-extension dependency used only
inside `backend/`, as the sqlite3 bug below shows.

**Two real bugs found and fixed by actually running the frozen binary
(not by reading the build log — the build itself succeeded both times
before either fix):**
1. First run crashed on launch: `ModuleNotFoundError: No module named
   'sqlite3'` — `core/stats_db.py`'s `import sqlite3` was invisible to
   PyInstaller for the reason above, so `_sqlite3.so` wasn't bundled.
   Fixed via the explicit `import sqlite3` in `app.py` described above.
2. Same root cause suspected for Pillow's compiled extensions and
   `socket`; added explicit imports for both defensively, then
   confirmed no further crashes on rebuild.

**Verified (real PyInstaller build, real binary, run under Xvfb, this
session):**
- `pyinstaller --onefile` completed successfully, producing a single
  64MB self-contained Linux ELF binary.
- Launched the binary directly (no `python`, no source tree needed) —
  confirmed via `xwininfo` that a real 1300×900 window titled
  "MetaZone" existed, and via a real screenshot
  (`import -window <id>`) that the actual Meta Generator UI rendered
  correctly (sidebar nav, controls, styling all present).
- Clicked the Settings nav item via `xdotool` (real synthetic mouse
  event, not JS injection) and screenshotted again: the real
  `get_provider_summary()` backend call fired and rendered all 4
  `VISIBLE_PROVIDERS` correctly (Gemini, Mistral, OpenAI, OpenRouter),
  proving the frozen binary's backend calls work, not just its static
  UI shell.
- Copied the binary alone into an empty directory with **no source
  tree present at all** and launched it from there — ran cleanly,
  proving it's genuinely self-contained and not accidentally reading
  from the dev source path.

**Not verified / explicitly out of scope for this batch:**
- Windows build entirely untested (no Windows environment available in
  this sandbox). WebView2 runtime presence/bundling and
  `exiftool.exe` bundling remain real open risks flagged since the
  original Stage 1 analysis.
- GTK/WebKitGTK themselves are **not bundled** — the built binary
  still expects them installed on the target Linux system (same as
  any GTK app; bundling a full GTK+WebKit stack into a single
  onefile binary is a much larger undertaking not attempted here).
- Embedder was not exercised in the frozen binary this session (no
  `exiftool` was placed next to the test binary) — the resolution
  logic is unchanged from the already-verified dev-mode version, but
  flagging that the frozen path specifically wasn't re-tested.
- No installer/`.desktop` file/icon — just the raw binary.

## Stage 7 — real load test at 150 images (no code changes; verification only)

Ran the actual migration's core promise through a real test, not a
guess: 150 real on-disk JPEGs, real validation, real thumbnailing,
real generation pipeline (concurrency 8), all through the real
`session.py`/`bridge.py` seam, rendered into the real DOM card grid.

**Import + validation:** 150/150 accepted, 0 rejected, in **0.046s**
(threaded validation in batches of 8, same as `add_paths`'s real
logic).

**Thumbnails:** all 150 generated and cached in **1.6s**.

**Generation at scale, cache-cold (fresh 2400×1800 images, forcing
`prepare_generation_preview`'s on-disk cache to actually build 150 new
previews rather than reuse old ones):** completed in **19.3s** for all
150 (failure path, since this sandbox has no API keys — a real
network-backed run would take longer per image but the plumbing
scales identically). **Confirmed this is a real finding, not
inconsistent data**: a second run over the *same* files completed in
under 1s, because `prepare_generation_preview`'s existing on-disk
cache (unmodified original behavior) was warm — the app's own caching
design working as intended, not a bug in the port.

**Incremental rendering, sampled every ~0.3s during the cache-cold
run:** card count climbed smoothly and monotonically the entire time
(0 → 1 → 4 → 8 → 11 → 17 ... → 145 → 147 → 150), never stalling for
more than a few hundred ms and never jumping from 0 to a large number
all at once. This is the actual evidence for "no UI freezing during
processing" — a freeze-then-dump architecture would show a flat line
near 0 followed by a single jump to 150, not this ramp.

**Correctness at scale:** `completion_order` had exactly 150 entries,
all unique (no drops, no duplicates); DOM card count matched exactly;
the event queue was fully drained (0 leftover) after completion;
Generate button correctly re-enabled.

No bugs found, no code changes needed this batch — this batch exists
to actually produce the evidence the whole migration was undertaken
for, rather than assume the architecture change would fix the
sluggishness without checking.

## v0.8.3 — Stage 5 (batch 2): real Dashboard + Prompt-to-Prompt screens

**What changed:**
- New `backend/dashboard.py`: thin aggregation calling the already-pure
  `core/stats_db.py` functions unchanged (`today_summary`,
  `lifetime_summary`, `last_n_days_series`, `recent_activity`) plus
  the AI Usage capacity math ported from `ui/dashboard.py`'s
  `_refresh_ai_usage` (`active_keys × daily_limit_per_key − used_today`).
  **Deliberately strips `est_api_cost`/`est_api_cost_saved`** from what
  reaches the frontend — `stats_db.lifetime_summary()` still computes
  them, but the original dashboard never surfaces a USD figure either,
  by design (see the product constraint: never show a cost figure).
  Ported that omission on purpose, not by oversight — verified below.
- New `backend/prompt2prompt.py`: a thin bridge around the real,
  **completely unmodified** `prompt_to_prompt.engine.PromptToPromptEngine`.
  That engine expects a few attributes from an `app`-like object
  (`.prefs`, `._task_mgr`, a Tk-`IntVar`-shaped `.ai_concurrency_var`,
  `._last_ai_provider`/`._last_ai_model`) — rather than editing the
  engine to remove that coupling, added a small `_AppShim` that
  duck-types exactly those attributes, so the real batching/dedup/
  top-up-shortfall logic runs completely unchanged.
  **Text-to-prompts mode only in this batch** — Image-to-Prompt mode
  (`source_image=...`) is not wired up; matches the project knowledge
  doc's own note that Image mode was "spec'd but not started" as of
  v0.7.5, so it's being left that way here too rather than rushing an
  unverified version of it alongside everything else in this batch.
- `bridge.py`: added `get_dashboard_data`, `set_daily_limit`,
  `start_prompt_to_prompt`, `pause_prompt_to_prompt`,
  `stop_prompt_to_prompt`.
- Frontend: real Dashboard page (stat cards, a plain-SVG 7-day bar
  chart — no charting library needed for a 7-point series, Lifetime/
  AI-Usage key-value panels, editable daily-limit-per-key, recent
  activity list) and real Prompt-to-Prompt page (original-prompt
  input, count/creativity/style/concurrency controls, live partial
  results rendered as batches land via `p2p_partial`, matching the
  original's `on_partial` callback intent). New nav items wired
  through the existing `nav.js` page-switcher.

**Verified (executed under Xvfb + real GTK/WebKit this session, real
SQLite stats.db under `~/.metazone`, not mocked):**
- Seeded two real `stats_db.record()` calls, then confirmed
  `get_dashboard_data()` reflects them exactly, and that a **second**
  verification run's totals correctly accumulated on top of the
  first — real persistence, not fixture data.
- Confirmed `lifetime` dict sent to the frontend contains no
  `est_api_cost*` key — the omission is real, not just described.
- `set_daily_limit(500)` persisted and read back correctly on a
  fresh `get_dashboard_data()` call.
- Dashboard nav click renders exactly 4 real stat cards and a real
  `<svg>` chart element (not a placeholder).
- Prompt-to-Prompt: real engine run against real (missing) API keys
  correctly surfaced the exact real error —
  `"All batches failed. Last error: No active API keys. Open 'Configuration'."`
  — all the way to the page's status text, with the Generate button
  correctly re-enabled and the session's `running` flag correctly
  false afterward. This exercises the real dedup/batching/on_error
  wiring end-to-end, not just a happy-path stub.

**Not done / explicitly deferred:**
- Image-to-Prompt mode within Prompt-to-Prompt.
- Smart Workflow — still not started.
- Pause/Resume for Prompt-to-Prompt: wired, call shape correct, not
  exercised mid-batch in this session (same reason as Meta
  Generator's Pause — the no-keys failure path completes too fast to
  reliably land a pause between batches in an automated run).
- Packaging — Stage 8.

With this batch, every screen in the original app now has a real
counterpart except Smart Workflow (already deactivated as of v0.7.5)
and Image-to-Prompt mode.

## v0.8.2 — Stage 5 (batch 1): real Meta Embedder + Settings/API Manager screens

**Scope note:** Stage 5 is being delivered in batches rather than all
at once — this batch covers Meta Embedder and Settings/API Manager.
Dashboard and Prompt-to-Prompt are still not rebuilt (placeholder page
shown for Dashboard; Prompt-to-Prompt nav item not added yet).

**What changed:**
- New `backend/embedder.py`: `EmbedSession`, ported from
  `ui/embed_window.py`'s `EmbedContent` — CSV load with column
  auto-guessing, folder selection, a real match-preview pass, and the
  real embed pipeline (one-time `build_file_index`/`index_lookup` scan
  — never per-row — then `embed_metadata_one` per matched row via
  `TaskManager.run_batch`, 6-way concurrent, optional title-based
  rename). Progress/log lines go through `bridge.emit(...)`.
- New `backend/settings.py`: real API key management ported from
  `ui/api_dialog.py`'s `APIManagerContent`. Same `prefs["ai_keys"]`
  storage shape as the original, so an existing user's `prefs.json`
  keeps working unchanged. Only `VISIBLE_PROVIDERS` are exposed to the
  frontend (free-providers-only rule preserved — Grok/Groq/Claude stay
  hidden). Keys are never sent to the frontend in full, only masked.
- `bridge.py`: added `browse_csv`, `browse_embed_folder`,
  `preview_embed_match`, `start_embed`, `get_provider_summary`,
  `add_api_key`, `set_key_active`, `delete_api_key`,
  `validate_key_live`.
- Frontend: real Meta Embedder page (CSV load, folder select, column
  mapping dropdowns, match preview, start/progress/log) and real
  Settings page (per-provider key list, add/activate/deactivate/
  delete, live validation on blur). New `nav.js` makes the sidebar
  actually switch pages — previously the nav buttons only toggled a
  CSS class with no page ever hiding/showing.

**Real regression caught and fixed before shipping (not by re-reading
the port, by comparing behavior against the original):** my first pass
at `add_key`/Save synchronously called network validation
(`validate_key`, up to a 12s timeout) before saving — a real violation
of "never block the frontend" that the *original* app deliberately
avoids: `api_dialog.py`'s `_add_key` saves a new key immediately and
validates live/separately via a non-blocking FocusOut check. Fixed to
match: `add_api_key` now saves instantly; `validate_key_live` (called
on blur, not on save) carries the network check.

**Verified (executed under Xvfb + real GTK/WebKit this session, real
files, real exiftool binary, not mocked):**
- Nav switching: clicking "Meta Embedder" actually hides the Meta
  Generator page and shows the Embedder page (previously nav did
  nothing but change a CSS class).
- Real 3-row CSV loaded; headers and column auto-guess correct;
  DOM `<select>` elements populated and pre-selected correctly.
- Real match preview against a real 2-file folder (one file directly
  in the folder, one in a subfolder) with a deliberately unmatched
  third CSV row: correctly reported **2/3 matched**.
- Real embed run against real files: **independently confirmed via a
  fresh `exiftool -Title -Keywords -Description` read-back** (not our
  own code) that Title/Keywords/Description were actually written to
  the JPEG.
- Settings: added a real key, `get_provider_summary()` correctly
  returned it masked (`tes••••••••••••456`) with `active_count: 1`;
  delete correctly removed it. DOM rendered exactly 4 provider blocks
  — matching `VISIBLE_PROVIDERS`, confirming Grok/Groq/Claude stayed
  hidden.

**Not done / explicitly deferred:**
- Dashboard (stats + activity chart) — placeholder page only.
- Prompt-to-Prompt screen — not started.
- Smart Workflow — not started (also deactivated in the original app
  as of v0.7.5, so lower priority).
- Pause/Resume for the Embedder (the original `EmbedContent` doesn't
  have pause/resume either — Stop wasn't ported here yet, only Start).
- Packaging — Stage 8.

## v0.8.1 — Stage 4: real Meta Generator screen (card grid + generation pipeline)

**What changed:**
- New `backend/session.py`: a `Session` class holding the real batch
  state (`all_paths`, `results`, `completion_order`) and the real
  generation pipeline — ported with the same logic as
  `main_window.py`'s `_gen_thread`/`process_one` (prompt building via
  `build_meta_prompt`, `call_with_failover`, `parse_meta`,
  punctuation sanitization, prefix/suffix application, the
  under-49%-of-requested-keywords retry), calling the exact same
  unmodified `engine`/`core` functions. Progress/status now go through
  `bridge.emit(...)` instead of `self._ui_action_queue.put(...)`.
- `bridge.py`: added `browse_images` (native OS file dialog via
  `window.create_file_dialog`, real filesystem paths — same intent as
  `filedialog.askopenfilenames`), `get_thumb`, `clear_batch`,
  `get_batch_state`, `start_generation`, `pause_generation`,
  `stop_generation`. `Api.__init__` now owns one `Session`.
- New `make_thumb_b64()` in `session.py`: a plain-PIL replacement for
  `core/utils.py`'s `make_thumb`, producing a base64 JPEG for an
  `<img>` tag instead of a `ctk.CTkImage`.
- Frontend: real Meta Generator screen — Browse button (native
  dialog), a controls panel (title/desc chars, keyword count,
  concurrency, single-word-keywords, avoid-copyright), Generate/
  Pause/Stop buttons wired to the real pipeline, and a DOM card grid.
  The card grid follows the same completion-order rule as
  `main_window.py`: a card is only ever created once a path reaches
  `done`/`failed` (never for `waiting`/`working`), and once created it
  is **appended, never repositioned** — `cardEls`/`lastApplied` Maps
  mirror `_card_by_path`/`_last_applied_result`'s no-op-diff guard so
  an unrelated update never re-flashes a settled card's content.

**Real bug found and fixed by actually running this (not by reading
code):** the event-drain loop could fire its first tick before the
page's own `<script>` tags finished loading, so `window.__onBackendEvents`
didn't exist yet and the drain thread crashed. Fixed by catching the
failure and re-queuing the batch (in original order) for the next
tick, rather than adding an arbitrary startup delay.

**Real architectural finding:** `pywebview`'s `evaluate_js` (called
from Python) cannot see a page script's top-level `const`/`let`
bindings — only explicit `window.*` properties. This doesn't affect
normal in-page behavior (buttons/listeners are ordinary same-script
closures), but it means any future Python-side debugging/automation
needs an explicit `window.__debugState()`-style hook, which was added
to `app.js` for exactly that purpose.

**Verified (executed under Xvfb + real GTK/WebKit this session, using
5 real on-disk JPEGs, not mocked data):**
- `add_paths()` validated and accepted all 5 real files.
- Thumbnails generated and rendered as real `<img>` elements in every
  card.
- `start_generation()` ran the real pipeline; with no API keys
  configured (sandbox has none), `call_with_failover` correctly raised
  its real "No active API keys" error for every image, and that exact
  message surfaced all the way to the card's title field — confirms
  the error-propagation path works, not just the happy path.
- All 5 paths appear in `completion_order` exactly once; the DOM grid
  shows 5 cards, matching.
- Generate button correctly re-enabled once `task_completed` fired.

**Known, faithfully-preserved behavior (not a new bug):** the progress
bar's "done" counter only increments on a *successful* generation
(same as `main_window.py`'s `done_count`, which is only incremented
inside the try-block's success path) — a failed image still finishes
and gets a card, but doesn't move the progress bar. This matches the
original app's existing behavior exactly; flagging it here since it
surfaced clearly in this all-failures test run, not because it was
changed.

**Not done / explicitly deferred:**
- Real browser drag-drop file handoff (still hover-only visual) — HTML5
  drag-drop doesn't reliably expose real filesystem paths in
  WebKitGTK; Browse (native dialog) is the working path for now.
- Prompt-to-Prompt mode, Dashboard, Embedder, Settings, Smart Workflow
  — Stage 5.
- Pause/Resume UI was wired but only smoke-tested for call shape, not
  exercised mid-batch in this session (the failure case above
  completes each image in well under 100ms, too fast to reliably pause
  between images in an automated headless test).
- Packaging — Stage 8.

## v0.7.5 — Confirmed root cause of the crash and the "very heavy" app, Smart Workflow deactivated

**The RecursionError crash and general heaviness (sluggish scroll, window
move, and resize) — found the real cause, with numbers, not a guess.**
Profiled a realistic batch (50 completed cards, well below this user's
normal 300+) and measured **12+ CPU-seconds** spent inside
`CTkFrame.configure()` calls alone — the per-card fade-in animation
added in an earlier version calls `.configure()` 16 times per new card
to animate its color in, and CustomTkinter's `configure()` triggers a
full redraw of that widget's entire subtree (a card containing
textboxes, buttons, and labels), not a cheap property set. The
column-count-change "flash" transition had the same problem, worse: 8
configure() calls across *every visible card at once*, every time the
grid reflows (e.g. maximizing the window). At this user's real batch
sizes, that's easily thousands of expensive redraw calls fired in a
short window, all scheduled through chained `self.after()` callbacks —
a direct, measured explanation for "too heavy to scroll / move / scale
the window," and a very plausible source of the reported
`RecursionError` (deeply nested callback and redraw contention during
generation, with the crash surfacing inside Tkinter's own internal event
code simply because that's wherever the stack happened to run out —
confirmed by research to be the typical shape of this specific error,
not a sign the bug lives in that code itself).

Fixed by removing both animations' step-loops entirely — cards get their
correct final color in one immediate, cheap call instead of 16 expensive
ones; the "flash" is now a no-op. Verified directly: the same 50-card
benchmark went from **10.1s → 5.6s** to settle (measured, not estimated,
and with the fade/flash calls completely absent from a fresh CPU
profile), and a single card's status-colored border is confirmed correct
on the very first frame with no animation delay to wait out. The
remaining ~5.6s is legitimate CustomTkinter widget-construction cost
(building real textboxes/buttons/labels) — real, but no longer being
compounded by an animation bug on top of it. Also added a modest
`sys.setrecursionlimit()` increase in `app.py` as a safety margin — not
a substitute for the real fix above, but reasonable headroom given how
deep this app's widget tree legitimately gets at a large batch size.

**Smart Workflow deactivated per request, code kept in place.** This
was more than a hidden nav button: `SmartWorkflowPanel` — its entire
widget tree, its own preview/downscale system, a startup resume-check —
was being constructed unconditionally on every app launch regardless of
whether the person ever used it. Removed that construction entirely,
along with the nav entry, the Dashboard's "Smart Workflow"/"Resume Last
Project" quick actions (replaced with API Manager/Settings so the grid
stays a clean 2x3), and the System Status "Smart Workflow" row. The
`smart_workflow/` module itself is untouched on disk for a future
re-enable — confirmed directly that it no longer even appears in
`sys.modules` at runtime, i.e. genuinely zero cost, not just hidden.

Delivered as changed-files-only: `app.py`, `ui/main_window.py`,
`ui/dashboard.py`, `core/constants.py`.

## v0.7.4 — Dashboard fills the window instead of leaving dead space below Activity

The Dashboard's content area was a `CTkScrollableFrame` with everything
packed top-down and sized to its own content — in a maximized/large
window, that meant a visible band of empty space below the Activity
chart, since nothing was set up to actually use the extra room. Not
consistent with this app's move to window-relative, percentage-based
sizing (v0.7.2) rather than fixed pixel layout.

Restructured the page to a plain grid layout instead: every row above
the Activity chart keeps its natural content-driven height, and the
chart's row is the one row configured with `weight=1`, so it's the row
that absorbs whatever space is actually left over — none in a small
window, a lot in a maximized one. The chart canvas itself is now
grid-stretched to fill that row (was a fixed 72px), with a resize
handler that redraws it at its real current height rather than the
canvas just rendering blank in the extra space (a plain `Canvas` doesn't
automatically redraw existing content differently just because it got
taller). Gave the row a 130px floor so a very short window doesn't
compress the chart down to near-nothing.

Verified directly: at the app's normal default size the chart renders at
a sensible height with room to spare; maximized on a simulated 1920x1080
screen, the chart canvas grows to 312px and visibly fills the window
with no dead space left below it (screenshot-confirmed); shrunk back
down, it returns to a compact size without breaking. Confirmed the
existing blink-suppression and AI-usage-capacity behavior from earlier
versions still work unchanged.

Delivered as changed-files-only: `ui/dashboard.py`.

## v0.7.3 — Upload-size regression, redundant card reflow, fade-in border bug, P2P live progress

**Generation on upscaled images went back to uploading full-size
originals:** found a real, existing function (`prepare_generation_preview`
in `core/utils.py`) that downscales an image to a cached 1280px-longest-
edge JPEG before sending it to a vision API — well-built, clearly made
for exactly this — that had never actually been wired into the Meta
Generator's real call path, or Prompt-to-Prompt's Image mode. Every
generation call was reading and uploading the raw original file
regardless of size, which for a genuinely upscaled multi-thousand-pixel
image is a slow upload for no metadata-quality benefit. Wired it into
both call sites. Verified end-to-end with a real 6000x4000 test image:
confirmed the AI call now actually receives the cached ~1280px version,
not the original, with correct caching (near-instant on repeat) and
small images passed through completely untouched.

**Imports of large/upscaled batches taking 1-2 minutes, instead of
instant:** this was a regression from v0.7.2's own browser-drag
protection fix, found by literally benchmarking it — that fix validated
every single imported file (a stability poll plus a full Pillow decode)
unconditionally, sequentially, one at a time, which measured at ~150ms
of pure added overhead per file even for a completely ordinary,
already-complete file with zero risk of the race it was protecting
against. For a real hundred-plus-file batch of large images that's
30–45+ seconds of overhead that didn't exist before that fix. Rewrote it
to check a file's modification time first: anything older than 5 seconds
cannot possibly still be mid-write, so it skips straight through with
zero added cost — only a file modified in roughly the last few seconds
(i.e., one that could plausibly still be an in-progress browser-drag
temp file) gets the actual check, now running on a small concurrent pool
instead of one at a time. Benchmarked: 100 real, already-complete files
imported in 0.18s (was several seconds minimum, scaling to minutes for a
real large batch) — and re-verified the original browser-drag protection
this exists for still catches a genuinely fresh, incomplete file exactly
as before.

**Cards still visibly reshaping while new ones generate, even after
v0.7.2's completion-order fix:** that fix stopped cards from changing
*position*, but found a second, separate real cause — `_render_page()`
runs on every single new completion during a batch (not just to place
the new card), and it was calling `apply_result()` unconditionally on
*every already-displayed card* on every one of those passes, which does
an unconditional delete-and-reinsert of every textbox's content — even
though nothing about those already-finished cards had changed at all.
For a real batch, that means dozens of already-settled cards silently
re-flashing their full content on every subsequent completion for the
rest of the run. Fixed by comparing against the last-applied result and
only touching a card when its content has genuinely changed. Verified
directly: instrumented a card's textbox to count real delete() calls —
zero across 5 unrelated completions, exactly one when that specific
card's own content actually changes.

**Card border color reset to plain gray right after the fade-in
animation finished, every time, regardless of status:** the fade-in's
final cleanup step was hardcoded to always land on the plain resting
border color, silently overwriting whatever status-accent color (e.g.
green for a Compact card's "done" state) `_build()` had already set
correctly moments before. So no card ever kept its intended colored
border once its ~320ms fade-in settled — found while investigating a
report of the accent border looking incomplete/patchy across a grid of
cards. Fixed by capturing the card's own already-correct resting color
at the start of the animation and animating toward *that*, instead of a
hardcoded value. Verified directly: border color mid-fade shows the
transitional accent tone, and after the fade completes it now correctly
holds the real status color instead of reverting to gray.

**Prompt-to-Prompt: no live progress, Generate button never changed,
and a 200-prompt option.** Root cause for the "0% then instantly 100%"
progress bar: batches request up to `BATCH_SIZE` prompts per AI call,
and the previous batch size (10) meant the *default* prompt count (10)
was exactly one single batch — there was structurally no intermediate
step to show. Halved the batch size for materially smoother progress on
common counts, added a live partial-results callback so generated
prompts now actually appear in the output list progressively as each
batch lands (not held back until the very end), and fixed the Generate
button to actually read "Generating…" while a run is in progress instead
of just graying out with the same unchanged label. Added 200 to the
prompt-count options. Verified end-to-end: output row count visibly
grows in steps during a run, button text changes to "Generating…" and
back to "Generate" at the right moments.

**Nav panel width** — already correctly doubled in the current code from
the previous update (100→200); the earlier request's fix was intact, and
what actually made it look "narrow again" was this update's own
screen-aware global scaling (v0.7.2) applying uniformly to every
dimension in the app on a smaller-than-reference display, the nav
included, not a regression in the nav's own configured size. Confirmed
via direct inspection that the configured value is still 200 (double
the prior request's 100) independent of whatever scale factor a given
screen ends up applying.

Delivered as changed-files-only: `ui/main_window.py`, `ui/widgets.py`,
`core/utils.py`, `prompt_to_prompt/engine.py`, `prompt_to_prompt/panel.py`.

## v0.7.2 — Card reflow root-cause, embed freeze root-cause, browser-drag bug, P2P multi-image, and a scaling pass

**Card "constant deforming and reforming" — real structural fix, not
another animation tweak:** cards were rendered in *import* order, so
whenever an image finished generating BEFORE an earlier-in-import-order
image that was still running, every already-on-screen card after it
would shift position the instant that earlier one finally completed —
this happens on nearly every batch once there's any real concurrency,
since completions essentially never land back in import order. Switched
to rendering in *completion* order instead: a card, once placed, never
moves again, ever — new completions only ever append. Verified with a
test that completes images out of their import order and confirms zero
already-placed cards change position when later ones arrive. This is
what v0.7.1's fade animation was trying (and failing) to paper over —
there was never a way to visually mask a card that's actually
relocating underneath the animation.

**The 70+-file freeze, actually root-caused this time:** clicking Embed
was calling `find_recursive`/`find_file` once **per CSV row** to locate
each file — for subfolder search, that's one full `os.walk` of the whole
folder tree per row, up to 6 of them running concurrently against each
other during the real embed pass. For a 70-row batch against a real
nested export folder, that's up to 70 full tree walks (plus preview
checks) contending for the same disk/OS cache right after the reported
repro (alt-tabbing to File Explorer, which cold-starts that cache) — a
completely plausible multi-second-to-much-longer freeze with zero
progress indicator, not a guess. Replaced with a one-time folder index +
O(1) lookups, shared between the live match-preview and the actual embed
pass. Benchmarked at 17x faster on a synthetic tree (scales further with
real tree size and row count) and verified byte-for-byte identical
matching behavior to the functions it replaced.

**Dragging an image directly from a browser could fail with a misleading
"all keys failed" error, and no thumbnail:** confirmed root cause —
browsers that support this kind of drag write a temporary file to disk
as part of the operation, and that write isn't guaranteed to be finished
by the time the drop event fires. The app was accepting the file path
immediately; a 0-byte or truncated file fails to decode as a thumbnail
(silently) and then fails AI generation against every single
provider/key in a row, which reads exactly like "all your keys are bad"
even though the real problem was that one file. Downloading first always
worked because a fully-written file on disk doesn't have this race.
Fixed by validating every dropped file (a brief wait for its size to
stabilize, then an actual Pillow open+verify) on a background thread
before accepting it; a file that fails now gets a clear, specific
warning instead of silently producing a broken card. Verified against a
truncated file, a 0-byte file, a normal file, and a file that's mid-write
when checked but finishes shortly after (correctly waited-for and
accepted). The image formats requested (jpg/jpeg/png/gif/webp/tiff) were
already fully supported — this wasn't a format gap.

**Prompt-to-Prompt: multi-image support (up to 15), 5×3 thumbnail grid,
whole-page drag-and-drop, word-count slider, and a Reset button.**
- Up to 15 reference images now analyzed together in one call (a
  mood-board style combined reference), shown in a 5×3 thumbnail grid
  that expands to fill the left panel's remaining vertical space instead
  of sitting in a small fixed box. Required extending the AI provider
  layer (`engine/ai_providers.py`) to accept a *list* of image paths, not
  just one — every existing single-image caller (Meta Generator, Smart
  Workflow, single-image Image-to-Prompt) is completely unaffected,
  verified directly against both shapes.
- The whole page is a drop target now, not just the old thumbnail box —
  same fix class as an earlier Meta Embedder drag-and-drop bug. Dropping
  an image anywhere on the page also auto-switches to Image mode.
- The disabled placeholder "Language" dropdown is gone, replaced with a
  Prompt Length slider (10–100 words) that's threaded into the actual
  prompt sent to the AI for both text and image modes.
- Reset button (top-right of the page) clears generated prompts, the
  text input, and every reference image — including their cached disk
  thumbnails, not just the in-memory list.
- Found and fixed two real bugs during testing, before shipping: clearing
  many previously-thumbnail-filled slots back-to-back hit a genuine
  `_tkinter.TclError` inside customtkinter's image handling (reliably
  reproduced with 15 real slots; didn't reproduce in a plain isolated
  label, and didn't reproduce in the separate card-pool's own similar
  code, which was left alone since it showed no problem under the same
  stress) — worked around with `image=""` instead of `image=None`. And
  the Reset button's cache cleanup was initially checking the wrong
  cached-thumbnail size, so it silently didn't delete anything — caught
  by directly checking the cache file's existence before/after Reset in
  a test, not by assuming the call succeeded.

**Dashboard: CPU/RAM removed** (were reliably showing N/A regardless of
v0.7.1's priming/diagnostics — rather than keep two rows that don't
work, they're gone), **Est. Hours Saved removed**, and the
Recent Activity / Productivity Insights / System Status row plus the
padding throughout the rest of the page tightened significantly — the
`CTkLabel` default-height-28 fix from v0.7.1 only got applied to that
row's own three boxes then; this pass also cut every inter-section gap
and shrank the activity chart further (90px → 72px). Verified: at the
app's normal 900px-tall default window, everything (including the
Activity chart) now fits without scrolling; at the app's absolute
minimum window size (700px) it's much closer but still slightly over —
noted honestly rather than claimed as fully solved at every possible
size.

**Nav: "Metadata" renamed to "Meta".**

**Expanded card gap between title/description and keywords:** found the
actual cause — the keywords frame sat in a stretchy grid row with no
vertical anchor (`sticky="ew"` only), so it centered vertically within
whatever extra space that row had rather than hugging the top, which is
what created the odd-looking gap above it. Changed to `sticky="new"`.
Measured before/after with a deliberately tall card: 270px gap → 34px
(just the keywords header, which is correct).

**Scaling on different-resolution monitors — partial, honest fix, not a
full rewrite:** a full conversion of this app's layout from fixed pixel
values to percentage-based sizing is a much larger undertaking than fits
in this pass — there are thousands of hardcoded dimensions across a
2,400+ line file, and doing that properly needs its own dedicated pass,
not a rushed one bolted onto everything else in this batch. What's
actually fixed now, and confirmed against a simulated 1280×720 screen:
the window no longer opens larger than the actual screen (it was a fixed
1300×900 — wider AND taller than a 720p display, which is exactly the
reported bug: the window couldn't fit, and its bottom controls were
pushed out of view with no way to reach them); the minimum window size
is now screen-relative instead of a fixed floor that left almost no
margin on a small display; and CustomTkinter's own global widget-scaling
factor is applied based on how the real screen compares to the ~1920×1080
display this UI was laid out assuming, so every widget shrinks together
on a smaller screen instead of a fixed-size handful overflowing while
nothing else adapts. Verified this holds a normal 1080p window's exact
original size and 1.0 scaling unchanged (no regression for the common
case), and that on a simulated 720p screen the window fits entirely
on-screen with its bottom status bar genuinely visible. This does not
mean every dimension in the app is now percentage-based — that remains
open, tracked honestly rather than implied to be done.

Delivered as changed-files-only: `ui/main_window.py`, `ui/widgets.py`,
`ui/dashboard.py`, `ui/embed_window.py`, `core/utils.py`,
`core/constants.py`, `prompt_to_prompt/engine.py`,
`prompt_to_prompt/panel.py`, `engine/prompt_generator.py`,
`engine/ai_providers.py`.

## v0.7.1 — 14-item bug/polish batch from live v0.7 testing

**Embedder "Not a valid PNG (looks more like a JPEG)" on every file:**
reproduced against a real exiftool binary and tried every plausible bypass
flag (`-m`, `-F`, `-api IgnoreMinorErrors=1`, an explicit `-fileType=`
override) — none of them work, and structurally can't: the file is
genuinely JPEG-encoded data saved with a `.png` extension (common with
some AI image-generation tools), and ExifTool's PNG writer correctly
refuses to touch it rather than risk corrupting it. Fixed at the actual
source: detect the real format via PIL before embedding and rename the
file to match (e.g. `→ .jpg`) right before writing, never silently —
the embed log now says exactly what got renamed and why. Verified
end-to-end against the real binary, including that already-correct files
are completely unaffected.

**Compact thumbnails missing for most cards:** found a real race in the
thumbnail delivery pipeline. Cards get reused for a different image
constantly under the new one-card-per-completion workflow, and nothing
stopped an in-flight thumbnail request for whatever image *used to* be in
that slot from landing late and overwriting the *new* image's thumbnail —
or being the only delivery that ever arrived for that slot. Couldn't
naturally reproduce the exact timing with small fast test images, so
forced the race by hand to confirm the mechanism, then fixed it by
tagging every request with the path it's for and discarding any delivery
that no longer matches what the widget currently wants. Verified both the
stale-discard and normal-delivery-still-works cases directly.

**Compact card still too tall despite last update's pass:** found the
actual culprit — `CTkLabel` silently defaults to `height=28` regardless
of font size, which was quietly eating most of the "wasted" vertical
space on every small label in the card. Fixed that everywhere in the
card, merged Filename+Size onto one line, and collapsed each metadata
field's header+value from two rows to one ("Title: xyz…"). Height went
252px → 183px. Also shrank the thumbnail 80px → 64px.

**Working View removed entirely**, replaced with auto-scroll-to-the-
newest-card: the grid now just follows the latest finished result into
view on its own, if you were already at (or hadn't left) the bottom.
Found and fixed a real bug in this replacement before shipping it — the
scroll would silently do nothing right after a card appeared because the
canvas's scrollregion hadn't caught up yet; now force-synced on every
call. Verified against genuinely overflowing content, not just a
same-screen case that happened to pass trivially.

**Fade-in animation "barely noticeable":** the previous version
interpolated the card's own background/border color between two shades
only 10 RGB points apart by design, and didn't touch any of the card's
child widgets, so almost nothing visibly moved regardless of duration.
Rewritten: longer (180ms → 320ms, 16 steps), and the border now does a
genuine flash through the accent color before settling to its resting
shade, verified by sampling the actual color values through the
animation.

**Nav bar width +30%** to fit the bigger icons/labels properly.

**Scroll/resize "deformation" during reflow:** added a brief synchronized
dim-then-restore flash across all visible cards whenever the column count
actually changes (window resized, Expanded crosses the maximize
threshold), to mask the instant jump of every card relocating and
rewrapping to a new width at once. Verified the color genuinely varies
mid-transition, not just at the two endpoints.

**Expanded view column count now checks real maximize state**, not just
window width — 2 columns unless the window is actually maximized ("full
window mode"), 3 if it is, using Tk's own `state()=="zoomed"` check. This
sandbox has no window manager to actually exercise the maximized branch,
so that half is unverified here — the "not maximized" branch and the
graceful fallback are confirmed.

**Whole card now draggable to scroll, not just the thumbnail:** rewrote
the binding to recursively cover every non-interactive widget in a card
(labels, status badge, filename, snippets) instead of just two spots,
while textboxes/buttons stay untouched so editing and clicking still
work exactly as before. Verified end-to-end by firing a real drag gesture
starting from a plain label deep in a card.

**Recent Activity panel too tall vs. its row:** same `CTkLabel` height
bug as the compact card fix, plus each activity entry was two stacked
lines — collapsed to one line each and reduced from 6 shown to 4, which
brings its natural height in line with Productivity Insights/System
Status instead of stretching them with dead space to match it.

**System Status CPU/RAM:** moved to the bottom of the widget. Also added
a priming call on dashboard load — `psutil.cpu_percent()`'s first-ever
reading in a process is always a meaningless 0%, which reads exactly
like "not tracking anything" if that's the first number someone sees —
and separated "psutil isn't installed" from "psutil installed but a call
failed at runtime" in the fallback text, for easier diagnosis if this
comes up again. Can't rule out a PyInstaller-packaging-specific cause
without the actual built EXE.

**AI Usage: "Est. Cost" replaced with a daily-capacity estimate** — this
tool is free-providers-only, so a dollar figure was never the right
number here. Now shows an estimate of how many more images the currently
stored active keys can process today (active keys × a daily-limit-per-key
setting, minus requests already made today), with used/total shown too.
The daily limit is a small editable field, not a hardcoded number:
looked up current free-tier daily limits and found the public sources
flatly contradicting each other (anywhere from 50 to 1500 requests/day
depending on the site), so guessing a single number and presenting it as
fact would just eventually be quietly wrong for someone. Verified the
calculation and the live-editable field end-to-end.

**Nav panel blending into the page background on every page except
Dashboard:** turned out to be a real regression from v0.7's own nav
rewrite — this app already had a theme-aware `NAV_BG` color (darkens the
base theme color, or lightens it if the base is already very dark/light,
so it's never the same tone as whatever's adjacent either way) built for
exactly this, and the rewrite had quietly reverted to plain `BG2` —
the same color the Meta Generator/Smart Workflow settings sidebar uses,
which is why they blended together on those pages specifically. Restored
`NAV_BG` and added a real 1px border on top of it, so the separation
holds even where two panels' tones happen to coincide. Verified against
the settings sidebar's actual live color.

**Prompt-to-Prompt: new "Image to Prompt" mode.** A mode toggle switches
the left panel between the existing text-prompt input and a new
drag-and-drop image zone (with thumbnail preview and a Browse… fallback);
in this mode, one reference image goes through the same vision-capable
call path the Prompt Generator page already uses, generating N different
prompts inspired by it instead of N variations of an existing text
prompt — same creativity/style controls, batching, and dedup machinery
as the text mode, reused rather than duplicated. Verified end-to-end that
the image path actually reaches the AI call and that distinct prompts
come back. Scoped to one reference image rather than a multi-image
thumbnail grid, given the time available for this batch.

Delivered as changed-files-only: `ui/main_window.py`, `ui/widgets.py`,
`ui/dashboard.py`, `ui/embed_window.py`, `ui/api_dialog.py`,
`core/utils.py`, `core/constants.py`, `core/stats_db.py`,
`prompt_to_prompt/engine.py`, `prompt_to_prompt/panel.py`,
`engine/prompt_generator.py`, `smart_workflow/pipeline.py`.

## v0.7 — Complete UI/UX & Card System Refactor, plus the recurring freeze (again) and a scroll bug batch

**The freeze, found again:** a **third** live instance of the exact bug
class already root-caused and fixed twice before (v0.6, v0.6.3) —
`self.after()` called directly from a background thread. This one was in
`embed_window.py`'s embedding pipeline, and it's the hottest instance yet:
up to 6 concurrent worker threads (the embed batch's own thread pool) all
doing it per-row, not once per batch from a single thread like the earlier
two. Also found it in `api_dialog.py`'s key-validation thread, and a
fourth, currently-dormant instance in a `widgets.py` thumbnail-loading
fallback path. Fixed all three the same way as before — every UI touch
from a worker thread now goes through a plain thread-safe queue, drained
only by a main-thread-scheduled poll; no Tk call originates off the main
thread anywhere in any of these three files now. Verified the queue drains
correctly under real concurrent load. Could not reproduce the exact
reported repro (Windows, clicking away to File Explorer and back mid-batch,
a 69-file 5500×3000 batch) in this environment — flagging this honestly
rather than claiming the repro itself is solved, but this is a confirmed
real bug matching the project's own established root-cause pattern, not a
guess.

**Card system & workflow — the requested refactor:**
- **Pagination removed entirely.** No pages, no Previous/Next, no page
  numbers. One continuously scrolling grid.
- **Manual column selector removed.** Both view modes now auto-fit column
  count to window width instead: Expanded 2 cols (small window) / 3
  (large), Compact 3 / 4 — two fixed tiers per mode, not a continuous
  card-width division, matching the spec exactly.
- **New card-creation workflow.** A path never gets a card while it's
  "waiting" or "working" — no empty cards, no placeholder cards, ever.
  A card is created exactly once, the instant its own metadata generation
  finishes (done or failed), already fully populated (thumbnail, filename,
  title, keywords, description, status), with a lightweight fade-in
  (~180ms color interpolation from background to the card's real color —
  CTk has no true alpha channel to animate against). Verified this holds
  even with Working View off, which needed a real fix: the debounced
  render that used to only fire when Working View was on now also fires
  whenever a newly-finished path doesn't have a card yet; and `_gen_done`
  now forces one final render to close a race where the very last
  completions in a fast/high-concurrency batch could still have a pending
  debounce timer when the batch itself ended.
- **Processing Queue stats** — Completed / Remaining / Avg time per image /
  Est. time remaining / current AI model / retry count, added to the
  progress bar area while a batch is running. Deliberate scope call: built
  into the existing progress bar strip rather than as a separate panel
  competing with the results grid for space — flagged as a design decision,
  not hidden as if it were the only option.
- **Compact card layout restructured** to a single vertical stack —
  Thumbnail → Status Badge → Filename → Metadata — replacing the previous
  two-column (thumbnail+status on the right, metadata beside it) layout.

**Sidebar:**
- The expand/collapse toggle is gone. The sidebar is now permanently the
  icon-over-short-label style that used to be the "collapsed" state —
  there is no other mode any more.
- Icons are noticeably bigger. (A single `CTkButton` can't mix two font
  sizes in one string, so each nav item is now a small compound widget —
  an icon label stacked over a text label, each with its own font — with
  manual hover/click/active-highlight handling replacing the button.)
- Labels unchanged text, +1pt font size, spacing rebalanced around the
  bigger icons.

**Dashboard:**
- **Blinking, root-caused:** `CTkLabel.configure()` forces a full internal
  redraw every call regardless of whether the value actually changed —
  and the dashboard was calling it on 20+ widgets every 4 seconds
  unconditionally. That's what read as the whole screen blinking.
  Added change-detection (only calls `.configure()` when a value genuinely
  differs) plus a brief color-pulse highlight on real changes, as a
  proxy for "fade in/out" since `CTkLabel` has no real alpha. Verified
  with an instrumented test: zero redundant `configure()` calls across
  repeated refreshes of unchanged data.
- **Layout reordered** per request: Recent Activity / Productivity
  Insights / System Status are now one row of 3 equal-width columns (the
  latter two existed already but were built and never actually shown,
  hidden behind the Quick Actions grid); the Activity (Last 7 Days) chart
  moved to its own full-width row below, height dropped 180px → 90px
  since it no longer needs to match Recent Activity's height.
- Same blink fix applied to the Recent Activity list and the 7-day chart:
  both now skip their (expensive, visibly flashy) full rebuild/redraw
  entirely when the underlying data hasn't actually changed since the
  last tick.

**Embedder drag-and-drop dead zone:** only the two narrow CSV/File-Location
rows were ever registered as drop targets. The popup embedder is small
enough that those two rows cover most of the window, so it's hard to miss
them; the full-page embedder sits inside the much bigger main window with
a lot of open space around those same two rows, and dropping anywhere else
landed on nothing. Registered the whole page as a catch-all drop target
too — same fix class as the Smart Workflow drag-and-drop bug from an
earlier session. Verified under a real tkdnd load: dropping a folder or a
`.csv` anywhere on the page now routes correctly.

**Scroll bug batch (found from live feedback on this same build):**
- **Scroll buttons barely moving:** root cause was relying on Tk's
  `yscrollincrement` for click distance, which turned out to be
  platform/build-dependent — a low or zero default on at least one real
  build made each click move almost nothing. Rewritten to compute pixel
  distance directly from an actual rendered card's height (2 card-heights
  per click) every time, independent of any Tk/platform default.
- **Scrollbar thumb not showing/draggable:** the floating ▲/▼ buttons'
  placement (`x=-14`) directly overlapped the built-in scrollbar's track —
  confirmed by measuring real widget geometry, not guessed. Moved to
  `x=-38` to clear it with a gap.
- **No locked position at either end** ("top cards keep moving down, then
  there's nothing above them, no lock"): the scroll position wasn't being
  re-clamped against the *current* content size on every click, so it
  could drift past the actual first/last card while cards were still
  resizing/relaying-out live during generation — Tk doesn't automatically
  re-clamp an existing scroll position when the scrollable content's
  extent changes after the fact. Every click now recomputes the real
  content bbox and clamps to it fresh, so each click is self-correcting
  regardless of what happened to the layout since the last one. Also set
  `yscrollincrement=1` (was left at whatever the Tk build defaulted to) so
  `yview_moveto` can't quietly snap to a coarser increment than intended.
  Verified exact locks at both ends even after 30-40 rapid clicks well
  past either boundary.

Delivered as changed-files-only: `ui/main_window.py`, `ui/widgets.py`,
`ui/dashboard.py`, `ui/embed_window.py`, `ui/api_dialog.py`,
`core/constants.py`.

## v0.6.3 — Recurring freeze root-caused, Working View readability, drag-scroll, and a bug batch

**Item 5, the recurring "Not Responding" freeze:** found a second, much more
frequent instance of the exact bug class already fixed once for the
online-status loop — the generation-completion callback was calling
`self.after()` directly from a background thread, on *every single batch
you run*. Rewrote the entire generation status pipeline (working/done/
failed updates, the completion signal, the ExifTool check, the
online-status loop) through a proper thread-safe queue that only the main
thread ever drains — no Tk call now originates off the main thread
anywhere in that path. Verified end-to-end with a real generation run.

**Other real bugs found and fixed:**
- The floating ▼/▲ buttons next to the results grid were actually
  changing pages, not scrolling — restored to their real function (mouse-
  wheel-equivalent scroll of the current page); the separate ◀/▶ Page Nav
  buttons still handle pagination.
- Moving the window (not resizing it) was still triggering the deform/
  reform flash — tightened the resize handler to check the event's actual
  width before doing anything, since a pure drag fires `<Configure>` on
  child widgets in some window managers even though nothing about their
  size changed.
- Found a real mismatch from the earlier thumbnail-size unification: the
  card *frame* was resized to 80px but the actual *requested* thumbnail
  resolution was still defaulting to 58×58 — fixed in both the live-
  display path and the page-navigation rebind path.

**New this round:**
- Whole-batch thumbnail prefetching — importing now warms the disk cache
  for every image immediately in the background, not just the page
  currently on screen, so paging through a large batch later hits the
  cache instantly. Verified: 8 images → 16 cache files (both view-mode
  sizes) within 1.5s of import.
- Clear All now also wipes the thumbnail cache (background thread, since
  the folder can hold many files) — never touches prefs.json, which lives
  in a different folder entirely.
- Click-and-drag scrolling on the results grid — hold and move the mouse
  to scroll live, like a touch gesture. Bound directly on each card and
  its thumbnail (not just empty canvas background, which cards leave
  almost none of).
- Working View now holds a just-finished card visible for a few seconds
  instead of swapping it out the instant it completes — the "only a
  blink before it's gone" complaint. The page label now shows both counts
  (e.g. "⟳ Working (10)  ✓ (3)") instead of lumping everything under
  "Working".
- Nav now shows short labels (Home/Metadata/Smart/Embed/Prompt/P2P/API/
  Setting/License/Help) under each icon even in collapsed mode; expanded
  mode is unchanged.
- Investigated the "concurrency=20 feels slower than older versions"
  report: audited the whole concurrency path (a standard bounded
  `ThreadPoolExecutor`, unchanged this session) and found no code-level
  bottleneck. Most likely explanations are free-tier AI provider rate
  limiting at higher concurrency, or a perceptual effect from more cards
  being visible at once — flagging this honestly rather than claiming a
  fix for something not found. The app already tracks real "Avg.
  Processing Speed" (img/min) from actual completion data in
  `core/stats_db.py`, currently just not visible on screen since that
  panel was hidden in v0.6.1's dashboard restructure.

## v0.6.2 — Thumbnail disk cache + lazy page init (rest of the performance directive)

- **Thumbnail disk cache**: resized thumbnails are now saved once to a
  shared cache folder (next to prefs.json in `C:\MetaZone\.cache\thumbs`)
  and reused on later imports of the same file — mtime-keyed, so editing
  or replacing a source image automatically invalidates its cached
  thumbnail without needing to hash the whole file. Includes light
  automatic cleanup so the cache can't grow unbounded. Verified
  end-to-end: cache hit path measured at ~0.6ms vs ~200ms for a cold
  generate on a test image, and confirmed real cache files get created
  when importing into the actual running app.
- **Lazy page initialization**: Meta Embedder, API Manager, and Settings
  now build the first time you actually navigate to them instead of at
  startup — profiling showed this was costing ~1s of App() construction
  for pages a given session might never visit. Startup measured at
  3.6s → 2.5s. Once built, each page is cached exactly as before (never
  rebuilt, never destroyed) — this only changes *when* construction
  happens. Verified every page, including the newly-lazy ones, still
  builds correctly on first visit with zero errors.
- Dashboard, Metadata/Prompt Generator, and Smart Workflow stay eager —
  Dashboard is the landing page every session hits immediately, and the
  other two are commonly the very next thing opened, so deferring them
  had little real-world upside for the added risk.

## v0.6.1 — Performance root cause found & fixed, Working View, and a bug batch

**The big one:** measured `_render_page()` at **6.5 seconds** per grid-column
change or page navigation at a 372-image scale — completely freezing the
main thread. That's the real explanation behind several reported symptoms
that looked unrelated: the scrollbar and mouse wheel appearing "stuck"
(the whole app was frozen, not broken), the visible deform/reform flash
on grid changes, and a 1-column Expanded layout looking stuck until
restart. Root cause: every trigger (page nav, grid-column change, any
re-render) destroyed and rebuilt every card widget from scratch — for a
CTkTextbox-heavy Expanded card, construction was always the expensive
part, never the data. Rewrote the renderer to reuse a pool of already-
built card widgets via a new `rebind()` method (added to both
`MetaResultCard` and `CompactEditCard`) instead of destroy+reconstruct.
Re-measured after the fix: page navigation **6.5s → ~0.18s** (35x
faster), grid-column changes **6.5s → ~0.5s** (13x faster) — profiled the
remainder and confirmed it's legitimate CustomTkinter canvas redraw, not
waste.

**Working View** — new toggle next to the grid-column selector. While
generation is running, the results grid shows only the cards currently
being processed (exactly as many as your Concurrent Generation setting),
advancing live as each one finishes — in both Expanded and Compact.
Automatically reverts to normal pagination once nothing is actively
processing. Verified end-to-end with a scripted run.

**Other fixes this round:**
- Added an Embed button to Metadata Generator, to the left of Clear All —
  shown only after a full, natural generation completion; stays hidden
  through Stop/Pause and disappears again on Clear All. Verified with
  three separate scripted scenarios (natural completion, Clear All,
  Stop).
- Found and fixed a second real crash bug while working on the above:
  `CompactEditCard.get_result()` was defined twice — the second
  (winning) definition crashed on `None._boxes`, which would have broken
  Save/Export CSV any time it ran from Compact view.
- Concurrent Generation max raised from 10x to 20x.
- Thumbnail size unified to 80px long edge in both Expanded and Compact
  (a stale code comment had claimed Expanded was already 120px — it was
  actually still 60px).
- Title/Description/Keyword counters split into their own accent-colored
  label next to the field name, instead of one small gray combined label.
- Nav menu button alignment fixed — it was sitting in its own narrower
  frame instead of being sized/packed identically to the icon buttons
  below it.
- Dashboard font sizes increased across the board; Quick Action button
  labels bumped further so they're clearly more prominent.
- Left honestly unfinished: the theme-change tempdir-warning/false
  ExifTool-missing report needs real Windows testing to make further
  progress on — the Python-level hardening from v0.6 is still in place,
  but this can't be verified or root-caused further from this
  environment. Lazy page initialization (building non-Dashboard
  workspaces on first visit instead of at startup) from the performance
  directive is also not done — page-switching itself is now fast via the
  caching fix above, so this was deprioritized in favor of the
  higher-impact items in this list.

## v0.6 — Nav/Dashboard restructure, inline pages, Process All, and a large bug-fix batch

**Real bugs found and fixed** (all root-caused and verified via a real
Xvfb+tkinter test harness this round — screenshots, pixel-diffing, and
mocked end-to-end runs, not just static review):
- **App freeze after running a while** — the online-status background
  thread was calling `self.after()` directly, which isn't thread-safe in
  Tkinter and was silently corrupting the UI's event-loop state every 8
  seconds until it eventually hung. Fixed to reschedule on the main
  thread only.
- **Smart Workflow drag-and-drop ("0 files loaded")** — the Smart
  Workflow panel sits on top of and covers every drop target Standard
  Workflow registers, but was never itself registered as one, so a drop
  onto it silently did nothing. Registered it, and made the file-count
  label update live on every import path (browse, drag-drop, and the
  large-batch async import).
- **Prompt-to-Prompt: 50 requested → only 6 delivered, one a stray
  fragment** — batches ran concurrently, so most started with an empty
  "avoid duplicates" list at the same moment, produced near-identical
  variations of each other, and dedupe collapsed them down hard (worst
  at Low creativity, which explicitly asks the model to stay close to
  the original wording). Fixed with a bounded catch-up loop that tops up
  any shortfall using a real avoid-list, raised the token budget for
  these text-only batches (2200→4000 — a batch of 10 detailed prompts
  could get cut off mid-list), and added a filter that drops
  preamble/fragment lines. Verified by simulating the exact failure
  mode: 50 requested → 50 delivered.
- A crash bug introduced partway through this same round (an edit had
  accidentally nested the rest of `SmartWorkflowPanel._build()` inside
  a helper method) — caught immediately by actually running the app
  under a virtual display instead of only compiling it.

**Nav & page restructure**
- Left nav is now always a vertical icon strip; the menu button expands
  it to icon+label and back, it never becomes anything else.
- Reordered to: Dashboard, Meta Generator, Smart Workflow, Meta
  Embedder, Prompt Generator, Prompt to Prompt, API Manager, Settings,
  License, Help.
- Meta Embedder, API Manager, and Settings are now real inline nav
  pages — not popups. API Manager and Settings share one underlying
  content frame (`APIManagerContent`) with two modes so the popup
  shortcut and the nav page can never drift apart; same pattern for the
  Embedder (`EmbedContent`). The old popups still exist for quick access
  (Metadata Generator's sidebar shortcut opens API Manager as a popup)
  but are thin wrappers around the same shared content now.
- Removed the sidebar Standard/Smart Workflow toggle and the
  Metadata/Prompt mode toggle — the nav is the only place those are
  chosen now. Removed the permanent top "Metadata AI"/"Embed" buttons.
- Settings is now the only place Theme is reachable from; API Manager
  is API keys only, renamed from "Configuration".

**Dashboard**
- Productivity Insights and System Status are hidden for now, replaced
  in that exact spot by a 2×3 Quick Actions grid.
- "Idle"/"Empty" moved to the top-right corner of the Running
  Tasks/In Queue cards.
- Added dashboard-only Stop All (pauses every running workflow without
  closing anything) and Refresh (resets the view only, never touches a
  running process) next to the online indicator.
- Confirmed nothing in the stats/activity area is click-bound.

**Smart Workflow**
- Thickened the progress bar to match the rest of the app, added a live
  imported/processing/good/bad stats row underneath it.
- Added a "Process All" toggle next to Auto-Embed: on, metadata
  generation auto-starts on Good + Needs Review right after Quality
  Inspection with no manual step; off (default) keeps today's manual
  selection step. Verified end-to-end both ways with a mocked run.

**Other**
- Real app icon (dark badge, green "MZ") now shows in every window's
  titlebar and the Windows taskbar/EXE — wired into the PyInstaller
  build.
- API Manager: explicit "Apply to All Keys" action for switching a
  provider's model, with visible confirmation.
- Lightened the accent color presets that read as too dark against the
  dark background (Red/Purple/Pink/Violet/Blue) to match Teal's
  brightness; Green/Orange/Teal were already fine.
- Hardened the theme-change restart path and the ExifTool detection
  against the "second theme change in a row" failure seen in testing —
  best-effort, since the exact Windows/antivirus interaction can't be
  fully verified outside real Windows.
- prefs.json now lives in a shared `C:\MetaZone` folder instead of next
  to the EXE, with automatic one-time migration of existing settings,
  so it survives switching between installed versions.

**Not done yet, left honestly unfinished:** Prompt Generator is still
not a fully independent page (it shares Metadata Generator's upload/
results area, though the nav-only mode switch is in place); no general
resize/stutter pass beyond what was already debounced; the "12 cards /
constantly deforming" report could not be reproduced (card positions
were pixel-identical before/after a content update in testing) —
needs more detail to keep chasing productively.

## v0.5.1 — Prompt-to-Prompt Generator (Part 2 of the v0.5 spec) + provider updates

**Prompt-to-Prompt Generator** — a brand-new workspace, fully wired into
the nav (no longer a "coming soon" placeholder):
- One prompt in, N new variations out (5/10/20/50/100), with Creativity
  (Low/Medium/High) and Prompt Style (Maintain Original/Commercial/
  Creative/Minimal/Highly Detailed) controls.
- Runs as background batches (10 prompts per AI call) through the app's
  existing bounded worker pool — Progress/Pause/Cancel all work, and
  navigating to any other workspace never interrupts a run in progress.
- Output list: per-prompt Copy, Select All, Copy All, Export TXT/CSV,
  and Regenerate Selected (replaces only the checked prompts, keeps the
  rest). Verified with a scripted test including that regenerating
  selected prompts doesn't clobber the normal Generate flow afterward —
  an actual bug caught while testing (see below).
- Duplicate-safe: each batch is told what's already been generated so
  far to steer away from repeats, plus a final normalized-text dedupe
  pass across the whole result set.
- Completions are recorded to the same stats DB the Dashboard reads
  from, so its "Total Prompt-to-Prompt Generations" figure is real
  starting now, not perpetually zero.

**Engine change enabling the above**: every AI provider caller
(`engine/ai_providers.py`) previously *required* an image — there was
no way to send a text-only request through the app's AI engine. Rather
than write a second, duplicate set of "text-only" callers (which the
Smart Workflow spec's "never duplicate AI request logic" principle
argues against), each existing caller now accepts `path=None` and
simply omits the image part of the request. Zero behavior change for
every existing caller — Standard/Smart Workflow/Prompt Generator always
pass a real path, so their requests are byte-for-byte the same as
before; verified by inspecting the actual request payload built with
and without a path.

**Bug found and fixed while testing this**: `_regenerate_selected` was
reassigning the engine's `on_complete` callback to a one-off closure
and never restoring it — so after using "Regenerate Selected" once, the
next normal "Generate" click would silently misbehave (still running
the regenerate-merge logic against a stale list). Fixed by using a
stable single callback with a "pending keep" flag instead of swapping
the callback itself.

**Provider/model updates**:
- Added the current Gemini 3.x Flash lineup — 3.6 Flash, 3.5 Flash, 3.5
  Flash-Lite, 3.1 Flash-Lite, and 3 Flash (Preview) — verified against
  Google's live models documentation rather than guessed. Also dropped
  Gemini 2.0 Flash, which that same documentation confirms was shut
  down June 1, 2026 — leaving it selectable would have just meant
  picking a dead model.
- Claude is now hidden from the AI Providers page and skipped during
  generation failover — it has no free API tier, and this app is
  free-providers-only. Uses the same `HIDDEN_PROVIDERS` mechanism
  already in place for Grok/Groq, so nothing structural changed and
  Claude support can be un-hidden later with a one-line change if that
  ever matters.

## v0.5 — Dashboard & Global Navigation (Part 1 of the v0.5 spec)

The biggest structural change yet: Meta Zone is no longer one flat
window — there's now a permanent left navigation rail and every tool is
its own workspace. Switching workspaces never interrupts anything
running in the background; verified with a scripted test that starts a
generation batch, navigates through 4 different pages mid-run, and
confirms all files still complete and get recorded correctly.

**Dashboard** (now the landing page on launch):
- Today's Statistics, Lifetime Statistics, AI Usage, Productivity
  Insights, System Status, and Recent Activity — every number comes
  from a new persistent SQLite store (`core/stats_db.py`) fed by real
  completion events (metadata generation, embedding, prompt generation,
  Smart Workflow runs). Nothing is simulated — a fresh install shows
  zeros and "—", not sample data. Cost figures are explicitly labeled
  "Est." since there's no real per-provider billing API to pull from.
- A hand-drawn 7-day activity chart (plain Tkinter Canvas, no new
  charting dependency).
- Quick Actions that jump straight to the relevant workspace, including
  "Resume Last Project" for an interrupted Smart Workflow run.

**Global Navigation**: Dashboard, Smart Workflow, Metadata Generator,
Metadata Embedder, Prompt Generator, Prompt-to-Prompt Generator, AI
Providers, Settings, License, Help. Metadata Generator / Smart Workflow
/ Prompt Generator all share the exact same underlying workspace and
logic as before (no duplication) — the nav items just drive the
existing workflow/mode toggles instead of introducing a second
implementation.

**Incidental bug found and fixed while testing this**: re-navigating to
an already-active Metadata Generator/Prompt Generator/Smart Workflow
page was calling the same internal mode-switch logic every time, which
unconditionally cleared results — including a batch that was still
running. Confirmed via test: without the fix, navigating away and back
mid-generation silently dropped completed files back to "waiting" and
the run finished 3 files short. Fixed by making the mode/workflow
switches a no-op when already in the requested state.

**Known limitations in this delivery** (spec's remaining pieces, coming
next):
- Prompt-to-Prompt Generator is not built yet — its nav item says so
  honestly rather than faking a working page.
- Metadata Embedder, AI Providers, and Settings are real, working pages
  today, but each opens its existing dialog rather than being fully
  redrawn inline — full in-page embedding is the other piece of this
  spec still pending.
- Settings doesn't yet have a "Reset Lifetime Statistics" button wired
  up, even though `stats_db.reset_lifetime()` exists and works.
- Not yet stress-tested with a real multi-thousand-file history in the
  stats DB — only small synthetic batches so far.

## v0.4.1 — Smart Workflow keyword ordering

- Stage 5 (Metadata Optimization) never actually implemented the spec's
  "Keyword ordering"/"Keyword importance" checks — it only scored
  metadata, it didn't verify or fix ordering at all. Stage 4's prompt
  already asks the AI for most-relevant-first keywords (same instruction
  Standard Workflow uses), but that was a soft request with nothing
  enforcing it in code.
- Added: Stage 5 now re-ranks each result's keywords so any keyword that
  actually appears in the title (the clearest "this is the central
  subject" signal) moves toward the front — the most relevant keywords
  now genuinely show top to bottom. It's a stable sort, so the AI's own
  relative ordering is preserved within each relevance tier rather than
  discarded; nothing is fabricated and no extra API calls are made.
  Verified with a unit test confirming title-matching keywords move to
  the front while both groups keep their original relative order.

## v0.4 — Smart Workflow (Beta)

A brand-new, fully separate opt-in workflow — Standard Workflow is
untouched and stays the default. Toggle between them from the sidebar;
switching doesn't destroy or rebuild either mode's widgets (raised/
lowered over the same area instead), and files are imported the normal
way in either mode.

Seven automatic stages, each with its own progress indicator:
1. **Preview Generation** — every image gets a temporary ~1024px-long-
   side preview before anything else happens; originals are never
   touched until embedding, and previews are deleted at the end.
2. **AI Quality Inspection** — every preview is checked for blur, AI
   artifacts, deformed faces/hands, missing/duplicate body parts,
   logos/watermarks/signatures, visible text, and copyright-sensitive
   content, and classified 🟢 Good / 🟡 Needs Review / 🔴 Rejected with
   a confidence score. Nothing is permanently rejected at this stage —
   classification only.
3. **Image Selection** — shows the Good/Review/Rejected counts and lets
   you choose Good Only / Good + Needs Review / All Images before
   metadata generation runs.
4. **Metadata Generation** — reuses the exact same prompt-building,
   parsing, and AI-failover engine as Standard Workflow (no duplicated
   logic), sending only the preview, never the original file.
5. **Metadata Optimization** — scores each result (missing/short
   keywords, missing description, flagged trademark/copyright terms,
   excess punctuation) into a Metadata Quality percentage.
6. **Embedding** — one toggle: auto-embed into the originals (reusing
   the same embed helper Standard Workflow's Embed window uses) or
   skip straight to CSV-only.
7. **Organization & Cleanup** — sorts originals into Ready Upload /
   Needs Review / Rejected folders, writes the CSV and a log, deletes
   the temporary preview cache, and produces an exportable TXT
   processing report (totals, scores, timing, provider used, errors).

**Interruption recovery**: progress is checkpointed to disk after every
stage. If Meta Zone closes mid-run, the next launch detects it and asks
to resume from the last completed stage. Verified via a scripted stop-
mid-generation-then-resume test — and along the way, found and fixed
two real bugs in this before it ever shipped: the checkpoint was
recording the stage that had *just finished* instead of the next one to
run, which would have silently re-run (and re-billed) that stage on
every resume; and generated metadata/scores were never actually being
saved to the checkpoint at all, which would have silently lost all
generated results on any resume past Stage 4. Both fixed and confirmed
with a test asserting zero redundant AI calls and zero data loss across
a real interruption.

Performance: never loads the whole batch into RAM, uses the same
bounded worker-pool pattern as Standard Workflow's generation (not
unbounded threads), and is designed against 5,000+ image batches —
verified for correctness end-to-end on small batches with mocked AI
calls; full-scale throughput/memory behavior hasn't been exercised yet
on a real multi-thousand-file batch.

## v0.3.2 — progress bars

- Every progress bar in the app (Generate tab, Import dialog, Embed
  window) was a thin 6px line that was easy to miss. Thickened all
  three to a consistent 14px, fully rounded, with a subtle border for
  definition — same accent color, just far easier to actually see
  progress at a glance.

## v0.3.1 — bug-fix batch

### Root-caused: the card list overlap/garbling, "imports stop showing as cards"
- The results area actually had two separate rendering systems fighting
  each other: a hand-rolled virtualized "infinite scroll" (place()-based
  absolute positioning + a row-height table) for Expanded/1-column, and a
  separate paginated grid for Compact/multi-column.
- Reproduced with a headless Xvfb + tkinter test harness: importing in
  two batches that together crossed the old internal 60-file
  "auto-compact" threshold silently shrank already-built cards' reserved
  row height (274px → 134px) in the height table WITHOUT rebuilding the
  actual widgets — so a still-274px-tall card ended up overlapping the
  row below it by ~140px. This is the confirmed cause of "the first
  dozen or so files look fine, then everything after looks like one
  garbled/merged card."
- Fix: removed the whole dual-system architecture (virtualization,
  row-height table, the 120ms scroll-poll, place()-based positioning)
  and unified every view mode onto one simple paginated grid renderer.
  A page is always bounded by page size (default 50), so building it is
  cheap even with 5,000+ files loaded, and there's no per-card
  bookkeeping left that can fall out of sync with what's on screen.
  This is also the most likely cause of the sidebar-collapse freeze and
  the general page/view-switching lag, since the polling+internals-
  reaching-in system this replaces was the most fragile part of the UI.
- Verified via the same headless harness: import → clear → reimport,
  import across the old threshold, switching Expanded/Compact, and
  changing page size/navigating pages all now leave exactly one live
  card per visible file, no overlap, no missing cards.

### Compact View redesign
- Rebuilt to match spec exactly: thumbnail with its shorter edge fixed
  at 100px (aspect ratio preserved, longer edge capped so an extreme
  panorama/portrait can't blow out the layout) — bigger than Expanded's
  thumbnail, not smaller. Filename and file size stacked underneath it.
- No longer editable — no textboxes. Shows a short snippet of
  title/description with a character counter, the first 10 keywords
  with a total-count counter, generation status, and a Regenerate
  button.
- Grid columns are now auto-fit to the available window width in
  Compact (recomputed on resize) — the manual 1-4 column picker only
  applies to Expanded, per request.

### Other UI fixes
- Fixed a real gap between the title/description boxes and the
  keywords box in Expanded cards — the title/desc row was absorbing
  all of the card's leftover vertical space instead of the keywords
  row, leaving blank space above the keywords box.
- Save button was much wider than its icon+text needed — shrunk.
- Embed window now shows a live progress bar plus succeeded/failed/
  not-found counts at the bottom, matching the Generate tab's progress
  row, instead of only the Activity Log scrolling by.

### API Keys — Mistral (and every provider) mass-deactivation bug
- Found the actual cause of "adding a new API key deactivated every
  other active key for that provider": `_add_key` unconditionally set
  every existing key's `active` flag to False before adding the new
  one as active — wiping out the whole failover set the moment someone
  added one more key. Fixed: a new key now joins as active without
  touching any other key's state.
- Added "Activate All" / "Deactivate All" buttons under "Get API Key",
  per provider.

## v0.3

### Theme customization
- "API Configuration" renamed to "Configuration", now a two-page window
  (API Keys / Theme) behind a page selector at the top.
- New Theme page: pick a background color and an accent color — presets
  as circular swatches (Pitch Black / Natural Black / Grayish Black for
  background; Green/Red/Purple/Pink/Violet/Orange/Blue/Teal for accent)
  plus manual hex input for either. Text color is intentionally not
  customizable, per request.
- One background color generates the full BG1-BG4/glass/border shade
  ladder via a fixed lightness step; one accent color generates its own
  hover/dim variants — nobody has to pick five shades by hand.
- Applying shows a confirmation (warns unsaved files will be lost, since
  it restarts the app) and then closes and relaunches Meta Zone
  automatically. Verified the actual relaunch mechanism directly: spawned
  a real subprocess the same way Apply does, confirmed it launches and
  stays running, and separately confirmed a genuinely fresh process
  picks up a saved custom theme correctly. Works both from source and as
  the frozen EXE (uses sys.executable when frozen, since a packaged
  build has no Python interpreter to hand a script to).

### Compact View + Grid + Pagination
- New View Settings controls in the results header: Expanded/Compact
  toggle, 1-4 column buttons, and page navigation.
- New CompactEditCard: small thumbnail, genuinely editable title/
  description/keywords boxes with live character/keyword counters,
  icon-only regenerate button — no bordered info box, no full status
  chrome.
- Architecture note: rather than rewrite the virtualized infinite-scroll
  system (already hardened through several rounds of real bug fixes —
  overlap, the buried collapse button, the edit-loss bug), Compact View
  and >1 columns use a separate, simpler paginated grid renderer instead.
  Expanded + 1 column (the default) keeps using the original,
  unmodified virtualized scroll — confirmed via regression test that it
  still works exactly as before.
- Tested end-to-end: 75-file batch, Compact + 3 columns, confirmed exact
  page counts (50 + 25), edited a card, navigated away and back,
  confirmed the edit survived — same edit-loss protection now covers
  page navigation, not just scrolling. Also confirmed live generation
  results stream correctly into compact-grid cards in place.
- View settings persist across restarts.

### Modern dropdown styling
- CTk's dropdown is a raw tkinter.Menu under the hood — on Windows its
  border is native OS chrome that can't be recolored through any CTk
  setting (a real Tk limitation, not a missed option). Built a proper
  replacement (ModernDropdown) using a borderless custom popup instead,
  applied to Platform and File Type.

### Collapsible control panel
- Thin collapse tab on the sidebar's right edge; matching expand tab
  appears on the card area's left edge once collapsed, freeing the full
  window width for cards during generation.

### Keyword ordering
- Strengthened the prompt to explain why keyword order matters (Adobe
  Stock weights early keywords more heavily in search) and what to
  prioritize first (main subject/action) vs. later (mood/color/style).
  Confirmed nothing downstream (single-word enforcement, copyright
  filtering, dedup) ever re-sorts the list — it's a pure order-
  preserving filter chain.

### Bug fixes
- Description/keyword bleed: when Description is off, some files were
  getting a second batch of keywords parsed into the description field
  (keywords generated twice under two different labels). Fixed by
  force-emptying description whenever the toggle is off, regardless of
  what the model returns.
- CSV auto-save/Save now use numbered suffixes (#folder.csv, #folder
  (1).csv, #folder (2).csv, ...) for separate batches from the same
  folder, instead of silently overwriting a previous export. Verified
  against the exact 3-batch scenario described.
- Vector titles double-stating "vector illustration" (once naturally,
  once as a trailing summary clause) — strengthened the prompt and
  added a code-side safety net that strips the redundant restatement,
  freeing character budget for real content.
- Punctuation restrictions: title/description now strip everything
  except comma, period, hyphen; keywords strip all punctuation
  including hyphens.
- Platform title/description limits now actually lock the slider
  ceiling — switching to a stricter platform clamps down, but a
  manually-lowered value survives switching back. Corrected Adobe
  Stock's cap to 200 (was stored as 150).
- Embed window's "Processing" button text going invisible — same fix
  pattern as the Generate button.
- Embed folder browser now starts from the current folder instead of
  Documents; added drag-and-drop for the File Location field.
- Replace Filename toggle (hides Remove Copyright, which stays fully
  functional) — renames embedded files to the first 8 words of their
  title. Stress-tested with 30 files sharing an identical title:
  confirmed unique numbered filenames, zero data loss.
- Embedding is now parallel (up to 6 at once) instead of one file at a
  time. Caught and fixed a real race condition this exposed: two files
  with the same title being renamed simultaneously by different worker
  threads could have silently overwritten one file with another — fixed
  with a lock, then stress-tested under real concurrent load to confirm
  it holds.
- Removed "Content Theme / Videos" from Advanced Options entirely, and
  fixed a pre-existing bug this surfaced: Prompt mode was always
  sending every style name regardless of any toggle state.
- File Type dropdown color changed from cyan to green.

## v0.2

### Manual edits getting lost after scrolling (data loss — found root cause)
- Confirmed the real cause: the virtualized list destroys card widgets
  once they scroll out of view, but nothing ever read their edited
  text boxes back into the app's data first — so any hand-edited
  title/description/keywords were silently gone the moment that card
  was torn down, even before Save or Export was ever touched.
- Fixed at the root: every place a card gets destroyed (scrolled out
  of view, or collapsed/expanded) now reads its current text boxes
  back into the saved data first. Verified directly: edited a title,
  scrolled it far out of view (destroying the widget), and the edit
  was still there afterward.
- Also caught and fixed a second bug this surfaced: the first version
  of this fix merged the card's *entire* snapshot back (not just the
  edited text), which included a stale "status" field frozen at the
  moment the card was built — silently reverting a live status (e.g.
  "done" back to "waiting") on sync. Fixed to only sync the actual
  editable text fields.
- New **Save** button (top-right of the Generate tab, where Embed
  used to sit before it moved to the header): syncs every
  currently-open card's edits, then writes them straight to the
  working CSV on disk — no need to go through Export CSV's save
  dialog first, and it updates the same file whether or not you've
  manually exported yet.

### Floating scroll buttons
- Two arrow buttons, bottom-right of the card list, scroll exactly 3
  rows (a full screen, since 3 cards fit the viewport) per click —
  using the real per-card heights, so it still moves by exactly 3
  cards even with some individually expanded.

### Card overlap / missing collapse button (large batches)
- Root cause: the virtualized list used ONE fixed row-height estimate
  for the whole batch, so an individually-expanded card inside an
  otherwise-compact batch didn't get a taller row slot reserved for
  it — it just overflowed into the next row. Replaced with a real
  per-row cumulative-height table: each row is exactly as tall as its
  own card actually is, and every row after an expand/collapse shifts
  accordingly. Verified with an 80-file batch and two cards expanded
  simultaneously — no overlap.
- The collapse button was real but was getting visually covered by the
  description box's copy/paste buttons in the same corner (a z-order
  issue — it was built before those buttons instead of after). Moved
  it to build last and explicitly raised above everything else, and
  made it a labeled "⌃ Collapse" button instead of a tiny glyph so
  it's easier to spot.

### Scroll speed
- Mouse wheel scrolling felt sluggish because each wheel notch only
  moved ~20px against 130–274px tall rows. Increased the canvas's
  scroll increment (not touching CustomTkinter's shared event
  bindings) so a notch now covers roughly a full row.

### Sentence-completion fix (title/description)
- Prompt now explicitly tells the model to always finish as a complete
  sentence within the requested length — wrap up early rather than run
  out unfinished.
- Added `smart_trim()`: if a title still exceeds the limit, it's cut at
  the last complete sentence boundary instead of an arbitrary word
  boundary, so it never reads as cut off mid-thought.

### File type / content-type directives
- New "File Type" dropdown, right under Platform, styled like it —
  no longer buried in Advanced Options. Six options: Auto Detect,
  Vector, Illustration, Transparent PNG, White Background, Silhouette.
- Each option is now a MANDATORY, top-priority prompt directive (not a
  loose style hint) — Vector titles state the image is a vector
  illustration, Transparent PNG mandates mentioning the transparent
  background, White Background adds "on a solid white background",
  Silhouette states it's presented as a silhouette.
- `smart_trim()` now takes a `must_include` phrase: if trimming would
  cut off the mandatory content-type phrase, it shrinks the rest of the
  sentence further to make room instead, and appends the phrase if the
  model left it out entirely but there's still room.
- Moved Single Word Keywords into Advanced Options.

### Platform / title length
- Named platforms (Shutterstock, Getty, Adobe Stock, etc.) keep their
  real recommended title caps unchanged.
- The "General" platform preset's title cap raised from 150 to 300 —
  use this when you want the longer title and don't need to match a
  specific site's limit.

### Header
- Added a "Metadata AI" / "Embed" button pair to the title bar.
  "Metadata AI" is an inert, button-styled label showing the current
  mode (dark/gray, white text); "Embed" is a real button (green,
  black text, matching Generate/API Configuration) that opens the
  Embed window. Removed the now-redundant old Embed button from the
  Generate tab's toolbar.

### Embed window
- Fixed the dead space below "Start Embedding" — the window was
  hardcoded to 640px tall but the form only needs ~546px. Now opens at
  570px with a matching minsize.

### Architecture
- Added `workers/task_manager.py`: a bounded `ThreadPoolExecutor`-based
  worker pool, replacing the manual `threading.Thread` + `Semaphore`
  pair used for AI generation batches. Pause/stop/retry/progress
  semantics are unchanged — this is a mechanical swap of the
  concurrency primitive, not a behavior change.

## v0.1
Version reset to v0.1 as the new baseline. From here, each major update
bumps the version (v0.2, v0.3, ...) — edit `APP_VERSION` in
`core/constants.py`.

### Architecture
- Split the single `metadata_tool.py` file into a modular package:
  - `core/` — constants, prefs (load/save), stateless helpers (exiftool
    discovery, file matching, thumbnails, filesize formatting)
  - `engine/` — AI provider calls + failover, prompt building, response
    parsing
  - `ui/` — theme, drag-and-drop bootstrap, and each window/widget
    (main window, API key manager, embed window, result card, import
    progress dialog)
  - `app.py` — entry point
- Consolidated the color palette into a single `ui/theme.py`. The old
  file defined two full palettes — an unused legacy one and the real
  black-glass one that silently overrode it later in the file. Verified
  by usage scan before removing anything, and kept the two colors
  (`AMB`/`AMB2`) that turned out to still be in use.
- Fixed a real bug the split would otherwise have introduced: both
  `prefs_path()` and `find_exiftool()` resolved their base folder from
  `__file__`, which pointed at the *module's own* folder. After moving
  those functions into `core/`, that would have silently relocated
  `prefs.json` and broken exiftool discovery. Both now resolve relative
  to the app's entry point instead, matching the original behavior
  exactly.

### UI fixes (AI Generate tab result cards)
- Left info panel (thumbnail, filename, size, model, status, Regenerate)
  is now a fixed-width bordered box — it no longer expands or shrinks
  when Description is toggled on/off.
- Title box shrunk vertically; Keywords box given the freed space.
- When Description is on, Title/Description now split roughly 40/60
  instead of being nearly equal.
- Font sizes inside cards bumped up by one point.
- The drag-and-drop bar now hides once files are loaded (freeing space
  for cards) and reappears when the list is cleared. Drag-and-drop
  itself keeps working while it's hidden — the whole window is already
  a registered drop target.
- Net effect: real card height measured ~270px -> ~254px. Note: an
  earlier pass also doubled the thumbnail size, but that directly
  fought against shrinking the card, so it was reverted back to the
  original 60px per direction given during the session.

### Bug fix
- Added a one-shot automatic retry when a provider badly undercounts
  keywords (e.g. ~30 when 49 were requested): the request is retried
  once with a stronger correction prompt, keeping whichever attempt
  produced more keywords. This can't guarantee an exact count from
  every model, but should meaningfully reduce the undercount cases.

### Not done yet (flagged, not attempted this pass)
The full "Meta Zone v1.0 Performance Edition" architecture spec calls
for a ThreadPoolExecutor-based task manager, a multi-stage processing
pipeline, a live performance dashboard, structured logging, and a
persistent on-disk thumbnail cache. These would replace the app's
current (working) threading model, and doing that correctly needs its
own dedicated, carefully-tested pass rather than being bundled into a
UI-fix + file-split session. Tracked as follow-up work.
