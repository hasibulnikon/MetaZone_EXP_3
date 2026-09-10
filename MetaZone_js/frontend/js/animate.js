// Reusable animation helpers -- call these instead of writing ad-hoc
// class toggling in every feature file, so the whole app has one
// consistent animation vocabulary (per the "reusable animation
// system" requirement). Every helper here is opacity/transform only,
// runs in the 120-250ms range, and never delays the actual state
// change it's layered on top of -- callers still flip real state
// (hidden, textContent, etc.) immediately; these just make that
// change look smooth instead of jump-cutting.
const Animate = {
  // v0.9.x fix (Part 12): restarting a CSS animation class normally
  // needs *some* signal to the browser that the class was actually
  // removed before it's re-added (otherwise re-adding the same class
  // name is a no-op and the animation doesn't replay). The old way --
  // `void el.offsetWidth` -- works, but it's a synchronous forced
  // layout read, and this function fires on every single card
  // creation/update event. On a 500-1000 image batch that's hundreds
  // of forced layouts back-to-back during a completion burst, which is
  // exactly the "animation backlog" this rewrite is meant to avoid.
  // Two rAFs (browser paints between them) achieves the same "the
  // class removal is observed before re-adding" guarantee without ever
  // touching layout-triggering properties -- pure compositor-friendly
  // scheduling instead.
  _restart(el, cls) {
    el.classList.remove(cls);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add(cls)));
  },

  // v0.9.x (Part 14): burst guard shared by every animation below.
  // During a large-batch completion burst, dozens of cards can update
  // within the same ~100ms window; animating every single one adds up
  // to real, visible jank precisely when the UI most needs to stay
  // responsive. Once more than BURST_LIMIT animations have started in
  // the current BURST_WINDOW_MS window, further calls apply the
  // element's resting state immediately (no animation) instead of
  // queuing more compositor work -- the state change itself is never
  // delayed, only its cosmetic transition is skipped.
  _burstWindowStart: 0,
  _burstCount: 0,
  _BURST_WINDOW_MS: 100,
  _BURST_LIMIT: 12,
  _shouldAnimate() {
    const now = performance.now();
    if (now - this._burstWindowStart > this._BURST_WINDOW_MS) {
      this._burstWindowStart = now;
      this._burstCount = 0;
    }
    this._burstCount++;
    return this._burstCount <= this._BURST_LIMIT;
  },

  fadeIn(el) {
    el.classList.remove('fade-out-target');
    if (!this._shouldAnimate()) { el.classList.remove('fade-target'); return; }
    this._restart(el, 'fade-target');
  },
  popIn(el) {
    // cardTemplate's markup already has class="card pop-in" baked in
    // statically, so under burst load the fix is to REMOVE it (before
    // the browser gets a chance to paint the animation's start frame),
    // not add it -- there's nothing to add, it's already there.
    if (!this._shouldAnimate()) { el.classList.remove('pop-in'); return; }
    this._restart(el, 'pop-in');
  },
  fadeInUp(el) {
    if (!this._shouldAnimate()) { el.classList.remove('fade-in-up'); return; }
    this._restart(el, 'fade-in-up');
  },

  // v0.9.x: the card-update "flash" pulse (previously hand-rolled
  // inline in app.js with its own `void el.offsetWidth`) now lives
  // here too, so there's exactly one restart/burst-guard implementation
  // instead of two copies that could drift out of sync.
  flash(el, cls) {
    if (!this._shouldAnimate()) { el.classList.remove(cls); return; } // skip purely cosmetic flash under burst load
    this._restart(el, cls);
  },

  // Fades an element out, then runs `onDone` (typically hiding it /
  // removing it from the DOM) once the animation actually finishes --
  // not on a hardcoded timer, so it never drifts out of sync with the
  // CSS duration if that's tuned later.
  fadeOut(el, onDone) {
    const handler = () => { el.removeEventListener('animationend', handler); if (onDone) onDone(); };
    el.addEventListener('animationend', handler);
    this._restart(el, 'fade-out');
  },

  // Page-level crossfade helpers used by nav.js: pure opacity fade,
  // no transform -- a whole page shifting position while fading read
  // as the old page "sliding down" as the new one appeared, so these
  // are deliberately plain fade in / fade out only.
  pageFadeIn(el) { el.classList.remove('page-fade-out'); this._restart(el, 'page-fade-in'); },
  pageFadeOut(el, onDone) {
    const handler = () => { el.removeEventListener('animationend', handler); if (onDone) onDone(); };
    el.addEventListener('animationend', handler);
    this._restart(el, 'page-fade-out');
  },

  // Opens a collapsible panel (e.g. Advanced Options) by adding the
  // "open" class the panel's own CSS transition (max-height/opacity)
  // is keyed off -- purely a class toggle, so it composes with
  // whatever transition duration that panel's CSS defines.
  panelOpen(el, openClass = 'open') { el.classList.add(openClass); },
  panelClose(el, openClass = 'open') { el.classList.remove(openClass); },

  // Assigns short, capped stagger delays to a batch of freshly-
  // inserted items so they animate in as a gentle wave instead of all
  // at once (which reads as a flash) or one-by-one (which reads as
  // sluggish for large batches). Caps at 8 steps -- anything beyond
  // that shares the last, still-short delay rather than continuing to
  // grow, so a 200-item batch doesn't take a full second to finish
  // appearing.
  staggerIn(items, animClass = 'fade-in-up', maxSteps = 8) {
    items.forEach((el, i) => {
      el.classList.add(`stagger-${Math.min(i, maxSteps - 1)}`);
      this._restart(el, animClass);
    });
  },

  // Brief "this value just changed" pulse -- used for status text,
  // counters, and match-count previews so updates read as a smooth
  // transition rather than a jump cut, without needing a full
  // fade-out/fade-in round trip for a one-line text swap.
  pulse(el) { this._restart(el, 'pulse-update'); },

  // Momentary confirmation flash on a drop target after a successful
  // drag-and-drop (or equivalent Browse-triggered) import.
  dropSuccess(el) { this._restart(el, 'drop-success'); },
};
