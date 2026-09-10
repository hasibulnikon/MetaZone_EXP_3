// Receives batched [ [eventName, payload], ... ] arrays pushed from
// backend/bridge.py's drain loop via window.evaluate_js(). This is
// the JS side of the same seam that used to be main_window.py's
// self._ui_action_queue + self.after() poll loops.
const BackendEvents = (() => {
  const listeners = {};
  function on(name, fn) {
    (listeners[name] = listeners[name] || []).push(fn);
  }
  // v0.9.4: added alongside Test All (item 15), which needs a
  // temporary listener for the duration of one batch -- without this,
  // every Test All click would leave its own listener registered
  // forever, and old ones would keep firing on every future key test.
  function off(name, fn) {
    if (!listeners[name]) return;
    listeners[name] = listeners[name].filter((f) => f !== fn);
  }
  function dispatch(batch) {
    for (const [name, payload] of batch) {
      (listeners[name] || []).forEach(fn => fn(payload));
    }
  }
  // v0.9.4.1: the actual fix for the Test All event-correlation bug --
  // a shared, testable predicate for "does this event belong to the
  // operation I'm tracking", used by settings.js's Test All handler
  // instead of that logic being duplicated (and possibly drifting)
  // inline. Pulled out here specifically so frontend/tests/
  // test_event_correlation.js can exercise the real function, not a
  // reimplementation of it.
  function matchesRequest(payload, requestId) {
    return !!payload && payload.request_id === requestId;
  }
  return { on, off, dispatch, matchesRequest };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BackendEvents };
}

window.__onBackendEvents = (batch) => BackendEvents.dispatch(batch);

// Shared helper for any page-load-time call to pywebview.api.* --
// calling the API before pywebview finishes injecting it is a real
// race (confirmed: caused Platform/File Type dropdowns and the key
// summary to silently never populate on a fresh page load). pywebview
// fires 'pywebviewready' once the bridge is actually ready; this
// handles both orders (listener attached before or after that event).
window.__pywebviewReady = false;
window.addEventListener('pywebviewready', () => { window.__pywebviewReady = true; });

function onPywebviewReady(fn) {
  if (window.__pywebviewReady || (window.pywebview && window.pywebview.api)) {
    fn();
  } else {
    window.addEventListener('pywebviewready', fn, { once: true });
  }
}
