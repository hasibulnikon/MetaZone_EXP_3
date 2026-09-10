# MetaZone v0.8.4 — Stage 3 + Stage 4 + Stage 5 (batches 1 & 2) + Stage 7 load test + Stage 8 (Linux packaging) (JS frontend migration)

Every screen from the original app now has a real counterpart except
**Smart Workflow** (already deactivated as of v0.7.5) and **Image-to-
Prompt mode** within Prompt-to-Prompt (not started — see below). A
real 150-image load test has been run, and a real standalone Linux
binary has been built and verified launching with a working UI.

## Build a standalone binary (Linux, verified)

```
./scripts/build_linux.sh
```

Produces `dist/MetaZone` — a single self-contained ~64MB binary.
Verified this session: launches with no Python/source tree needed,
renders the real UI (confirmed via screenshot), and real backend calls
work inside the frozen binary (Settings page's provider list, which
calls `core/config.py` + `core/constants.py`, rendered correctly).
GTK/WebKitGTK themselves still need to be installed on the target
system — they are not bundled into the binary. **Windows build is
untested** — no Windows environment available to verify WebView2/
`exiftool.exe` bundling; see CHANGELOG.md's Stage 8 entry.

## Run it

```
pip install -r requirements.txt
python app.py
```

On Linux this needs a GTK+WebKit webview (`python3-gi`,
`gir1.2-webkit2-4.1`, `gir1.2-gtk-3.0`) and a real `exiftool` binary
next to `app.py` for the Embedder. On Windows, pywebview uses
WebView2; PyInstaller packaging for WebView2 and `exiftool.exe`
bundling is Stage 8, not done.

To actually generate metadata or prompts you'll need real API keys
added via Settings — this app doesn't ship any.

## What's verified (actually run under Xvfb + real GTK/WebKit, not just read)

**Stage 3/4:** real prefs/key checks, real file import + thumbnails +
generation pipeline, completion-order card grid.

**Stage 5 batch 1:** real CSV load/match-preview/embed run — confirmed
via an independent `exiftool` read-back that metadata was actually
written to a real JPEG; real Settings key add/mask/delete.

**Stage 5 batch 2:**
- Real Dashboard data from a real SQLite `stats.db` — seeded real
  activity, confirmed it's reflected and **accumulates correctly
  across separate runs** (real persistence, not a fixture).
- Confirmed no `est_api_cost*` field reaches the frontend, matching
  the original app's deliberate no-USD-figure design.
- Real `daily_limit_per_key` setting persisted and read back.
- Real Prompt-to-Prompt run against the real (unmodified)
  `PromptToPromptEngine` — with no API keys configured, correctly
  surfaced the exact real error message end-to-end to the UI, proving
  the batching/dedup/error-handling wiring works, not just a stub.

See CHANGELOG.md for full details on all batches, including three real
findings/regressions caught by actually running things rather than
just reading the port: a startup race in the event drain loop, a
pywebview `evaluate_js` scoping constraint, and a "Save shouldn't
block on network validation" fix made to match the original app's
actual behavior.

## Stage 7 — real load test at 150 images

This is the actual evidence for the migration's whole reason for
existing — not an assumption that a new architecture would fix the
sluggishness. 150 real JPEGs, real pipeline, real DOM:

- Import + validation: 150/150 accepted in 0.046s.
- Thumbnails: 150/150 generated in 1.6s.
- Generation at scale (cache-cold, forcing real work): 150/150 done in
  19.3s, with card count **sampled every ~0.3s and climbing smoothly
  and monotonically the entire time** — not a freeze followed by a
  single dump, which is what a broken/blocking architecture would show.
- Zero dropped or duplicated events; `completion_order` and DOM card
  count both exactly 150; event queue fully drained afterward.
- Along the way, confirmed `prepare_generation_preview`'s on-disk
  cache (unmodified original behavior) is why a same-file re-run
  finishes in under 1s instead of ~19s — a real finding about the
  original app's own caching design, not a bug in the port.

Full numbers in CHANGELOG.md's "Stage 7" entry.

## What's explicitly NOT done yet (do not assume otherwise)

- **Windows packaging entirely untested** — WebView2 runtime,
  `exiftool.exe` bundling. This is the single biggest remaining risk
  before this can replace the original app for real.
- **Image-to-Prompt mode** (within Prompt-to-Prompt) — not wired up.
  Matches the original project's own note that this mode was "spec'd
  but not started" as of v0.7.5.
- **Smart Workflow** — not started (also inactive in the original app).
- Real browser drag-drop file handoff for Meta Generator — still
  visual-only; Browse (native dialog) is the working import path.
- Pause/Resume for Meta Generator and Prompt-to-Prompt: wired, call
  shape correct, not exercised mid-batch (fast no-API-key failures
  make this hard to land reliably in an automated headless run —
  worth a manual check on a real slower batch with real keys).
- Embedder has no Stop button (matches the original, which doesn't
  have one either).
- `smart_workflow/panel.py` and `prompt_to_prompt/panel.py` excluded
  from the backend copy (UI code in otherwise-logic packages); their
  logic-only counterparts were kept.
- PyInstaller packaging (Windows + Linux), WebView2 runtime bundling,
  `exiftool.exe` bundling — Stage 8.

## Next step

Stage 6 (animation/performance pass across all screens) and Stage 7
(load testing at 1/10/50/100+ images) per the original migration plan
— or Image-to-Prompt mode / Smart Workflow if those matter more to you
first. Your call.
