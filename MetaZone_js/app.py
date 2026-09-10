"""
MetaZone v0.8 — pywebview shell entry point (Stage 3-7 batches).

This launches a native OS webview (WebView2 on Windows, WebKitGTK on
Linux) pointed at frontend/index.html, with `backend.bridge.Api`
exposed to it as `pywebview.api`.

Resource resolution handles both dev mode (running `python app.py`
from source) and a PyInstaller-frozen build: when frozen, PyInstaller
extracts --add-data bundles to sys._MEIPASS at runtime, so BASE_DIR
points there instead of this file's directory.
"""
import os
import sys

BASE_DIR = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))

# backend/ is added to sys.path (not imported as a dotted package) so
# that core/, engine/, workers/, etc. keep resolving as top-level
# imports exactly as they do in the original app -- zero changes
# needed to any copied business-logic file. This works identically
# frozen or not, since backend/ is bundled as plain data (--add-data)
# and imported by path at runtime rather than relying on PyInstaller's
# static import analysis to discover it.
BACKEND_DIR = os.path.join(BASE_DIR, "backend")
sys.path.insert(0, BACKEND_DIR)


def _run_diag():
    """v0.9.8: '--diag' CLI flag -- prints a plain dependency report
    (ExifTool/FFmpeg/ffprobe/Ghostscript found or not, and from where)
    and exits, without opening any window. Added specifically so the
    GitHub Actions Windows build (.github/workflows/build_js.yml) can
    actually verify a freshly-built EXE finds its bundled binaries,
    instead of the build being 'untested' beyond 'PyInstaller didn't
    error and a .exe file exists'. Exits 1 if anything expected to be
    bundled is missing (a real packaging bug worth failing CI over);
    prints to stdout either way so a human can also just run
    'MetaZone.exe --diag' themselves to see what's wrong.

    Also writes the same report to a 'metazone_diag.txt' file next to
    the running exe (or the script, in dev mode): this build is
    `--windowed` (no console subsystem), so plain stdout from a
    launched .exe is not reliably visible to a CI step that just
    invokes it -- the file guarantees the CI log can show real output
    either way, not just the exit code.

    Deliberately called (see the bottom of this block) BEFORE `import
    webview`, `from bridge import Api, ...`, PIL/sqlite3, etc. This
    used to run after all of those, which meant an unrelated import
    failure anywhere in that much larger chain (bridge.py alone pulls
    in session.py, embedder.py, engine/ai_providers.py, automation/*,
    dashboard.py...) would crash the process with a bare traceback
    before '--diag' ever got a chance to run -- exiting non-zero and
    writing no report at all, which looked identical to a real
    'dependency not found' failure in CI logs but was actually a
    totally separate bug. Only os/sys and the two lightweight
    core.utils/core.bin_finder modules (pure stdlib + PIL) are needed
    for the four checks below, so --diag no longer depends on webview,
    pywebview's renderer detection, or any backend module actually
    being importable.
    """
    meipass = getattr(sys, "_MEIPASS", None)
    frozen = getattr(sys, "frozen", False)

    try:
        from core.utils import find_exiftool
        from core.bin_finder import find_bundled_binary
    except Exception as e:
        # core/ itself failed to import -- report that plainly instead
        # of letting it look like an ordinary crash with zero output.
        report = (
            "MetaZone dependency check FAILED TO START: could not import "
            f"core.utils / core.bin_finder ({e.__class__.__name__}: {e}). "
            "This means core/ was not bundled correctly, not that a "
            "specific tool is missing."
        )
        print(report)
        _write_diag_report(report)
        sys.exit(1)

    # (label, lookup, [paths tried, for reporting when missing/erroring])
    meipass_disp = meipass or "<not frozen / no _MEIPASS>"
    dep_specs = [
        ("ExifTool", find_exiftool,
         [os.path.join(meipass_disp, "exiftool_pkg", "exiftool.exe"),
          "next to the running exe/script (dev-mode fallback only)"]),
        ("FFmpeg", lambda: find_bundled_binary("ffmpeg_pkg", ["ffmpeg.exe", "ffmpeg"]),
         [os.path.join(meipass_disp, "ffmpeg_pkg", "ffmpeg.exe"), "system PATH"]),
        ("ffprobe", lambda: find_bundled_binary("ffmpeg_pkg", ["ffprobe.exe", "ffprobe"]),
         [os.path.join(meipass_disp, "ffmpeg_pkg", "ffprobe.exe"), "system PATH"]),
        ("Ghostscript", lambda: find_bundled_binary("gs_pkg/bin", ["gswin64c.exe", "gswin32c.exe", "gs.exe", "gs"]),
         [os.path.join(meipass_disp, "gs_pkg", "bin", "gswin64c.exe"), "system PATH"]),
    ]

    ok = True
    lines = [f"MetaZone dependency check (frozen={frozen}, _MEIPASS={meipass})"]
    for name, lookup, tried in dep_specs:
        try:
            path = lookup()
        except Exception as e:
            path = None
            lines.append(f"{name}: ERROR — {e.__class__.__name__}: {e} "
                         f"(looked in: {'; '.join(tried)})")
            ok = False
            continue
        if path:
            lines.append(f"{name}: PASS — {path}")
        else:
            lines.append(f"{name}: MISSING — looked in: {'; '.join(tried)}")
            ok = False

    hard_fail = frozen and not ok
    if hard_fail:
        lines.append("\nOne or more dependencies expected to be bundled in a Windows "
                      "release build were not found -- this is a packaging problem, "
                      "not a missing-optional-tool situation.")
    else:
        lines.append("\nOK" if ok else "\nSome optional dependencies are missing (expected "
                      "in a dev environment without them installed) -- affected features "
                      "will show a clear per-file error instead of crashing.")
    report = "\n".join(lines)
    print(report)
    _write_diag_report(report)
    sys.exit(1 if hard_fail else 0)


def _write_diag_report(report):
    """Writes metazone_diag.txt next to the running exe (frozen) or
    next to this script (dev mode). Best-effort: a write failure here
    must never hide the exit code, which is the authoritative pass/
    fail signal CI actually checks -- stdout above is the fallback if
    the file can't be written for some reason (e.g. a read-only
    install directory)."""
    try:
        log_dir = os.path.dirname(sys.executable) if getattr(sys, "frozen", False) else BASE_DIR
        with open(os.path.join(log_dir, "metazone_diag.txt"), "w", encoding="utf-8") as f:
            f.write(report + "\n")
    except Exception:
        pass


if "--diag" in sys.argv:
    _run_diag()

# Everything below this point is only imported for a real (non-diag)
# launch -- kept below the --diag short-circuit above so a packaging
# problem in any of these (webview's renderer detection, PIL, sqlite3,
# or the much larger bridge.py import chain) can never prevent the
# dependency diagnostic itself from running and reporting cleanly.
import threading
import webview

# Explicit, otherwise-unused imports: backend/ (which uses PIL and
# sqlite3) is bundled as plain data rather than analyzed by
# PyInstaller's import graph, so compiled-extension stdlib/third-party
# modules wouldn't otherwise be detected/bundled. These two lines
# exist purely so PyInstaller's static analyzer sees the imports and
# bundles their compiled extensions (_sqlite3.so, PIL's C extensions).
import sqlite3  # noqa: F401
import socket  # noqa: F401
import PIL.Image  # noqa: F401

from bridge import Api, start_event_drain
import bridge
from core.utils import _icon_paths

FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")

# ---- v0.9.1: multi-monitor/resolution compatibility ----
# The app was designed/tuned at a 1300x900 window (every fixed-pixel
# panel width, dropzone height, etc. in base.css assumes that canvas).
# That's fine on a 1920x1080+ screen, but on a smaller/lower-res
# monitor -- 1366x768 being the explicit "gold standard" older-monitor
# floor this needs to support -- a window requested at 900px tall
# either gets clipped by the taskbar or forces the OS to reposition
# it, and the fixed-pixel UI reads as oversized relative to the
# smaller screen. Two-part fix, deliberately split this way so the
# 1300x900 reference design is preserved pixel-for-pixel wherever it
# already fits (i.e. exactly the app's current look on a normal
# 1080p+ display is untouched):
#   1) Here: never *request* a window bigger than the primary screen
#      can comfortably hold, scaled down proportionally for smaller
#      screens but never enlarged past the 1300x900 reference on
#      bigger/4K ones.
#   2) frontend/js/viewport-scale.js: applies a uniform CSS zoom so
#      the UI's proportions/relative sizing look identical at
#      whatever window size step (1) actually produces -- shrinking
#      to fit a smaller monitor rather than overflowing/looking huge,
#      and it also re-runs on live resize, so manually resizing or
#      maximizing the window on any monitor is covered too, not just
#      the size at launch.
DESIGN_WIDTH, DESIGN_HEIGHT = 1300, 900
MIN_WINDOW_SIZE = (900, 600)


def _primary_screen_size(default=(1920, 1080)):
    """Best-effort primary screen resolution. Falls back to a
    1080p-equivalent default (matching the reference window this app
    was designed at) if screen detection isn't available for any
    reason -- must never block/break launch."""
    try:
        screens = webview.screens
        if screens:
            s = screens[0]
            return int(s.width), int(s.height)
    except Exception:
        pass
    return default


def _sized_window_dims():
    """Window size scales down for screens smaller than the
    1300x900 reference design (e.g. 1366x768), but is capped at
    1300x900 for bigger/4K screens -- so the reference size, and
    therefore the app's current on-screen look, is preserved exactly
    wherever it already fits."""
    screen_w, screen_h = _primary_screen_size()
    win_w = min(DESIGN_WIDTH, max(MIN_WINDOW_SIZE[0], int(screen_w * 0.85)))
    win_h = min(DESIGN_HEIGHT, max(MIN_WINDOW_SIZE[1], int(screen_h * 0.85)))
    return win_w, win_h


def main():
    api = Api()
    bridge.api_instance = api  # so real drag-drop (bound on the Python
    # side, not via evaluate_js) can reach the same session the rest
    # of the app uses, without threading api through DOM callbacks
    win_w, win_h = _sized_window_dims()
    window = webview.create_window(
        "MetaZone",
        url=os.path.join(FRONTEND_DIR, "index.html"),
        js_api=api,
        width=win_w,
        height=win_h,
        # v0.9.1: lowered from (1000, 700) -- that floor was already
        # taller than the usable area of a 1366x768 screen once the
        # taskbar is accounted for, so the window could never actually
        # settle at a size that fit. (900, 600) comfortably fits every
        # resolution down to 720p while viewport-scale.js keeps the UI
        # itself legible at that size.
        min_size=MIN_WINDOW_SIZE,
    )
    api.set_window(window)
    bridge.main_window = window
    bridge.frontend_dir = FRONTEND_DIR

    def on_loaded():
        start_event_drain(window)
        _bind_real_drag_drop(window)

    # v0.8.4: app/window/taskbar icon was never actually wired to
    # anything real -- the only icon code in the whole project,
    # core/utils.py's set_window_icon(), is a leftover from the old
    # CustomTkinter app (calls window.iconbitmap/iconphoto, which only
    # exist on tk.Tk/ctk.CTk windows) and is never called anywhere in
    # this pywebview build, so icon.ico/icon.png sitting in the root
    # folder next to app.py were being resolved by _icon_paths() but
    # then just... never used. pywebview's real icon hook is the
    # `icon=` kwarg on webview.start() (pywebview>=6.2, which
    # requirements.txt already pins), not per-window and not
    # iconbitmap/iconphoto. Prefer .ico on Windows (native taskbar
    # icon format), fall back to .png elsewhere/if only one exists.
    ico, png = _icon_paths()
    icon_path = ico if (ico and os.name == "nt") else (png or ico)

    if os.name == "nt" and ico:
        # v0.8.5: webview.start(icon=...) alone was still not showing up
        # in the real Windows taskbar even with a valid icon.ico present
        # -- two real, separate causes found and fixed:
        #   1) icon.ico only had a single embedded 256x256 image (no
        #      16/32/48px sizes). Windows picks the closest embedded
        #      size for the taskbar/title bar (typically 32x16px at
        #      100% DPI); with only a 256px frame present some shell
        #      versions silently fall back to the generic exe icon
        #      instead of downscaling it. Fixed by regenerating icon.ico
        #      with the full 16/24/32/48/64/128/256 size set.
        #   2) pywebview's `icon=` kwarg on webview.start() is honored
        #      by GTK/Qt on Linux, but on the Windows edgechromium
        #      backend the underlying WebView2 host window's native
        #      win32 icon isn't actually set by that call in every
        #      pywebview version -- it only affects Alt+Tab in some
        #      builds, not the taskbar button itself. Explicitly setting
        #      the window's WM_SETICON via pywin32 after the window is
        #      shown is the documented real fix for this class of
        #      pywebview issue, so it's done as a belt-and-suspenders
        #      step in _force_windows_icon() below, in addition to (not
        #      instead of) the icon= kwarg above.
        threading.Thread(target=_force_windows_icon, args=(ico,), daemon=True).start()

    webview.start(on_loaded, debug=False, icon=icon_path)


def _force_windows_icon(ico_path, retries=25, delay=0.4):
    """Best-effort: waits for the native window to exist, then sets its
    small+large icon directly via the Win32 API. Fails silently on
    anything but Windows/pywin32-available environments -- this is a
    supplement to webview.start(icon=...), never a replacement, so if
    this can't run for any reason the app still launches normally with
    whatever icon= already provided."""
    import time as _time
    try:
        import ctypes
        from ctypes import wintypes
    except ImportError:
        return

    user32 = ctypes.windll.user32
    IMAGE_ICON = 1
    LR_LOADFROMFILE = 0x00000010
    LR_DEFAULTSIZE = 0x00000040
    WM_SETICON = 0x0080
    ICON_SMALL = 0
    ICON_BIG = 1
    GCLP_HICON = -14
    GCLP_HICONSM = -34

    hwnd = None
    for _ in range(retries):
        hwnd = user32.FindWindowW(None, "MetaZone")
        if hwnd:
            break
        _time.sleep(delay)
    if not hwnd:
        return

    try:
        h_big = user32.LoadImageW(0, ico_path, IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE)
        h_small = user32.LoadImageW(0, ico_path, IMAGE_ICON, 16, 16, LR_LOADFROMFILE)
        if h_big:
            user32.SendMessageW(hwnd, WM_SETICON, ICON_BIG, h_big)
            user32.SetClassLongPtrW(hwnd, GCLP_HICON, h_big)
        if h_small:
            user32.SendMessageW(hwnd, WM_SETICON, ICON_SMALL, h_small)
            user32.SetClassLongPtrW(hwnd, GCLP_HICONSM, h_small)
    except Exception:
        # Best-effort supplement only -- never let an icon-polish step
        # crash the app.
        pass


def _bind_real_drag_drop(window):
    """Real file drag-and-drop, using pywebview's DOM event API
    (pywebview>=5.0) rather than plain HTML5 drop events -- the
    standard browser File API never exposes a real filesystem path
    for security reasons (confirmed: this is true even for WebView2 on
    Windows, not just WebKitGTK on Linux -- it's a security decision,
    not a backend limitation). pywebview's own DOMEventHandler exposes
    the real path via event['dataTransfer']['files'][i]['pywebviewFullPath'].

    This binds on the Python side (not via evaluate_js), so it works
    independent of ordinary page JS. If the current renderer doesn't
    support window.dom (older pywebview, or a backend where DOM
    manipulation isn't wired up), this fails soft: drag-and-drop stays
    visual-only and Browse remains the working import path, rather
    than crashing the app.
    """
    try:
        from webview.dom import DOMEventHandler
    except ImportError:
        return

    def on_p2p_grid_drop(e):
        """v0.8.7 fix: this is the real element-scoped handler the old
        comment claimed already existed. Before this, P2P image drops
        only ever went through the document-wide on_drop() below, keyed
        off whichever sidebar page was 'active' -- meaning a drop
        *anywhere* on the P2P page (including while the From Text tab
        was showing, with no image grid visible at all) would silently
        try to add reference images. Binding directly to #p2pImageGrid
        makes only that box a real filesystem drop target, matching
        #embedCsvDropzone/#embedFolderDropzone below."""
        files = e.get("dataTransfer", {}).get("files", [])
        paths = [f.get("pywebviewFullPath") for f in files if f.get("pywebviewFullPath")]
        if not paths or bridge.api_instance is None:
            return
        result = bridge.api_instance.p2p_session.images.add_paths(paths)
        bridge.emit("p2p_images_dropped", result)

    def on_drop(e):
        files = e.get("dataTransfer", {}).get("files", [])
        paths = [f.get("pywebviewFullPath") for f in files if f.get("pywebviewFullPath")]
        if not paths:
            return
        if bridge.api_instance is None:
            return
        # v0.8.6: this used to always add into Meta Generator's session
        # no matter which page was showing -- a real latent bug that
        # surfaced once the Image to Prompt Generator page (with its
        # own dropzone) got built, since a drop there would have
        # silently landed in the wrong batch. Reads the currently
        # active sidebar page synchronously (evaluate_js) and routes to
        # the matching session/event name; falls back to Meta Generator
        # if that read fails for any reason, same fail-soft spirit as
        # the DOMEventHandler binding below.
        try:
            active_page = window.evaluate_js(
                "document.querySelector('.nav-item.active')?.dataset.page || 'meta'"
            )
        except Exception:
            active_page = "meta"
        if active_page == "prompt":
            session = bridge.api_instance.prompt_session
            event_name = "prompt_import_completed"
        elif active_page == "p2p":
            # v0.8.7/v0.8.8: P2P's "From Image" tab has its own image
            # grid, now bound as its own element-scoped drop target
            # (on_p2p_grid_drop above) -- this document-level fallback
            # is intentionally now a no-op for the P2P page rather than
            # routing every drop on the page (including on the From
            # Text tab, where there's no image grid at all) into the
            # image store. If the element-scoped binding below fails to
            # attach on some platform/renderer, this page simply loses
            # drag-and-drop for P2P (Browse still works) instead of
            # silently doing the wrong thing.
            return
        else:
            session = bridge.api_instance.session
            event_name = "import_completed"
        result = session.add_paths(paths)
        bridge.emit(event_name, result)

    def on_embed_csv_drop(e):
        files = e.get("dataTransfer", {}).get("files", [])
        paths = [f.get("pywebviewFullPath") for f in files if f.get("pywebviewFullPath")]
        if not paths or bridge.api_instance is None:
            return
        res = bridge.api_instance.load_csv_dropped(paths[0])
        bridge.emit("embed_csv_dropped", res)

    def on_embed_folder_drop(e):
        files = e.get("dataTransfer", {}).get("files", [])
        paths = [f.get("pywebviewFullPath") for f in files if f.get("pywebviewFullPath")]
        if not paths or bridge.api_instance is None:
            return
        res = bridge.api_instance.set_embed_folder_dropped(paths[0])
        bridge.emit("embed_folder_dropped", res)

    def on_automation_folder_drop(e):
        """Batch page's dropzone -- accepts one or more real folder
        paths in a single drop, unlike the single-folder Embed
        dropzone above. Mirrors the popup-window binding the Batch
        system used before it was embedded into the main window."""
        files = e.get("dataTransfer", {}).get("files", [])
        paths = [f.get("pywebviewFullPath") for f in files if f.get("pywebviewFullPath")]
        if not paths or bridge.api_instance is None:
            return
        res = bridge.api_instance.automation_add_folders_dropped(paths)
        bridge.emit("automation_folders_dropped", res)

    try:
        window.dom.document.events.dragenter += DOMEventHandler(lambda e: None, True, True)
        window.dom.document.events.dragover += DOMEventHandler(lambda e: None, True, True, debounce=200)
        window.dom.document.events.drop += DOMEventHandler(on_drop, True, True)
    except Exception:
        # Real fallback, not a silent lie: if binding fails on this
        # platform/renderer, drag-and-drop simply stays visual-only.
        pass

    # Element-scoped drop targets (v0.8.7): the Meta Embedder's "Load
    # CSV" and "File Location" steps, and P2P's image grid, each need a
    # drop handler that's specific to that box rather than the whole
    # document -- unlike the Meta/Prompt dropzones above (which cover
    # their entire page), these boxes live alongside other content on
    # the same page. window.dom.get_element() resolves a CSS selector
    # to a real bindable node (see webview/dom/dom.py); each get_element
    # call is independent, so a missing element (e.g. this page variant
    # not having that id) just skips that one binding rather than
    # aborting the rest.
    for selector, handler in (
        ("#embedCsvDropzone", on_embed_csv_drop),
        ("#embedFolderDropzone", on_embed_folder_drop),
        ("#p2pImageGrid", on_p2p_grid_drop),
        ("#automationDropzone", on_automation_folder_drop),
    ):
        try:
            el = window.dom.get_element(selector)
            if el:
                el.events.drop += DOMEventHandler(handler, True, True)
                el.events.dragover += DOMEventHandler(lambda e: None, True, True, debounce=200)
        except Exception:
            pass


if __name__ == "__main__":
    # Note: --diag is handled up top, before this module even finishes
    # importing webview/bridge/etc. -- it calls sys.exit() itself and
    # never falls through to here.
    main()
