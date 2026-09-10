// viewport-scale.js (v0.9.1)
//
// MetaZone's whole UI (base.css) is built on fixed-pixel values --
// panel widths, dropzone heights, font sizes -- tuned to look right in
// the app's reference window size (1300x900, see app.py). That's
// exact and correct on the display it was designed on, but the same
// fixed pixels take up a much bigger share of a smaller/lower-res
// screen (1366x768 and similar 720p-class monitors), which is what
// reads as the UI being "huge". This script does NOT change any of
// that pixel design -- it applies one uniform CSS `zoom` to the whole
// document so the entire UI scales down (or, up to 100%, back up)
// together, preserving every proportion exactly, to fit whatever
// window size the app actually ends up at on the current screen.
//
// CSS `zoom` (not `transform: scale`) is deliberate: unlike transform,
// zoom genuinely changes the effective viewport for vh/vw-based
// layout (this app leans on calc(100vh - ...) throughout) and for
// position:sticky/fixed/absolute -- so scaled content still reflows,
// scrolls and hit-tests correctly instead of just being visually
// stretched over unscaled layout math.
//
// Scale is derived from the window's own size vs. the 1300x900
// design reference, capped at 100% (never zooms IN past the design's
// native size -- a maximized window on a big/4K screen just shows the
// UI at its normal size with extra room around it, rather than
// blowing it up) and floored so it never shrinks past legibility.
(function () {
  var DESIGN_WIDTH = 1300;
  var DESIGN_HEIGHT = 900;
  var MIN_SCALE = 0.55;
  var MAX_SCALE = 1.0;

  var root = document.documentElement;

  // Graceful no-op on any engine that doesn't support CSS zoom (older
  // WebKitGTK builds) -- app simply keeps its pre-v0.9.1 sizing there
  // instead of risking a broken/partial scale.
  if (!root || !('zoom' in root.style)) return;

  // The API Manager / Meta Embedder utility popups load this same
  // index.html at their own small, already-appropriate window sizes
  // (see bridge.py) -- leave those alone entirely.
  if (new URLSearchParams(location.search).get('popup')) return;

  var resizeTimer = null;

  function applyScale() {
    // Reset to 1 first so the innerWidth/innerHeight read below is
    // always the window's true physical size, never a size already
    // distorted by a previously-applied zoom -- otherwise each
    // subsequent resize would compute its new scale from the wrong
    // (already-scaled) baseline.
    root.style.zoom = '1';
    var w = window.innerWidth || root.clientWidth;
    var h = window.innerHeight || root.clientHeight;
    if (!w || !h) return;

    var scale = Math.min(w / DESIGN_WIDTH, h / DESIGN_HEIGHT);
    scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));

    // Real bug this fixes: `100vh` does NOT automatically compensate
    // for a `zoom` applied higher up the tree (that was this file's
    // original, incorrect assumption) -- `vh` always resolves against
    // the actual physical window, not the zoomed one. So body's own
    // `height: 100vh` (and the couple of `calc(100vh - ...)` rules
    // elsewhere in base.css) sized themselves correctly in real
    // pixels, and THEN got visually shrunk again by zoom on top of
    // that -- the whole app (sidebar included, since it's a flex
    // sibling inside that same shrunk box) rendered smaller than the
    // actual window, leaving real, unstyled dead space below
    // everything rather than just some page's content running short.
    // Fix: expose the *already-scale-compensated* height/width as CSS
    // vars, and base.css uses those instead of raw vh/vw so nothing
    // gets shrunk twice.
    root.style.setProperty('--app-100vh', (h / scale) + 'px');
    root.style.setProperty('--app-100vw', (w / scale) + 'px');
    root.style.zoom = String(scale);
  }

  applyScale();
  // Re-measure once more after the DOM is actually ready, in case the
  // very first measurement (taken while <head> was still parsing) was
  // ever unreliable in a given environment -- cheap, and a no-op if
  // the number hasn't changed.
  document.addEventListener('DOMContentLoaded', applyScale);

  // Bug fix: on smaller/720p-class windows, pywebview's native window
  // is sometimes still mid-resize (settling into the smaller
  // win_w/win_h app.py requested) at the moment this script's very
  // first measurement runs -- window.innerWidth/innerHeight at that
  // instant can briefly report the *pre-resize* (larger, default)
  // size. That produces a scale that's too large for the window's
  // real final size, and because nothing after the initial paint was
  // guaranteed to trigger another 'resize' event on every platform,
  // the wrong (too-large) scale could stick: the UI renders as if the
  // effective viewport were taller than it really is, so content ends
  // before the real bottom edge of the window and everything below it
  // reads as empty space. These extra re-checks after load settles
  // catch and correct that -- cheap no-ops (applyScale resets to zoom:1
  // and recomputes) if the first measurement was already right.
  window.addEventListener('load', applyScale);
  setTimeout(applyScale, 200);
  setTimeout(applyScale, 600);

  // Debounced: a window drag-resize fires this rapidly; only rescale
  // once movement settles rather than on every intermediate frame.
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(applyScale, 80);
  });
})();
