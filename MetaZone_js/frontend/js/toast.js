// v0.9.4: shared, app-wide toast/notification system -- one
// implementation reused from app.js, promptgen.js, p2p.js, embed.js,
// settings.js instead of each page growing its own ad-hoc "flash a
// message" logic (the app already had this problem once: the status
// line at the top of Meta/Prompt pages was overloaded with both
// progress text AND transient one-off messages, which is exactly the
// kind of duplicate/competing-implementation this file exists to
// avoid repeating elsewhere). Follows the same `const Thing = {...}`
// singleton pattern as Animate (see animate.js) and BackendEvents (see
// events.js) so it reads consistently with the rest of the codebase.
//
// Usage:
//   Toast.show('15 images added');                       // info (default)
//   Toast.show('CSV exported', { type: 'success' });
//   Toast.show('3 images failed', { type: 'warning' });
//   Toast.show('Export failed', { type: 'error' });
//   Toast.show('Card removed', { action: { label: 'Undo', onClick: fn } });
//
// Design constraints from the spec this was built for: non-blocking,
// auto-dismiss, manually dismissible, consistent appearance, supports
// success/warning/error/info, never interrupts the workflow (no
// stealing focus, no modal backdrop), and doesn't animate excessively
// (a single opacity+transform transition per toast, respecting
// prefers-reduced-motion).
const Toast = (() => {
  let container = null;
  const REDUCE_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function ensureContainer() {
    if (container) return container;
    container = document.createElement('div');
    container.className = 'toast-stack';
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
    return container;
  }

  const ICONS = { success: '✓', warning: '⚠', error: '✕', info: 'ℹ' };

  // duration: ms before auto-dismiss. null/0 = stays until manually
  // dismissed (used for toasts with an action, e.g. Undo, so the
  // person has time to actually click it) -- but even then we still
  // give it a generous default (see callers) rather than truly forever,
  // per "keep Undo available for approximately 5-8 seconds".
  function show(message, opts = {}) {
    const { type = 'info', duration = 4000, action = null } = opts;
    const root = ensureContainer();

    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `
      <span class="toast-icon">${ICONS[type] || ICONS.info}</span>
      <span class="toast-message"></span>
      ${action ? `<button type="button" class="toast-action"></button>` : ''}
      <button type="button" class="toast-dismiss" title="Dismiss" aria-label="Dismiss">×</button>
    `;
    el.querySelector('.toast-message').textContent = message;
    if (action) {
      const actionBtn = el.querySelector('.toast-action');
      actionBtn.textContent = action.label;
      actionBtn.addEventListener('click', () => {
        action.onClick && action.onClick();
        dismiss(el);
      });
    }
    el.querySelector('.toast-dismiss').addEventListener('click', () => dismiss(el));

    root.appendChild(el);
    // Same double-rAF trick Animate._restart uses: guarantees the
    // browser has observed the initial (pre-transition) state before
    // the "in" class is added, so the transition actually plays.
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('toast-in')));

    let timer = null;
    if (duration) timer = setTimeout(() => dismiss(el), duration);

    function dismiss(node) {
      if (timer) clearTimeout(timer);
      if (!node.isConnected) return;
      if (REDUCE_MOTION) { node.remove(); return; }
      node.classList.remove('toast-in');
      node.classList.add('toast-out');
      node.addEventListener('transitionend', () => node.remove(), { once: true });
      // Safety net: if a transitionend never fires (e.g. display:none
      // ancestor), don't leak the node forever.
      setTimeout(() => node.remove(), 400);
    }

    return { dismiss: () => dismiss(el) };
  }

  // v0.9.4: shared import-result summary (item 2 of the UX spec) --
  // used by Meta Generator, Prompt Generator, and P2P's "From Image"
  // picker, all of which return the same {accepted, rejected} shape
  // from their respective add_paths() calls. One implementation here
  // instead of three near-identical copies.
  function showImportSummary(accepted, rejected) {
    const added = accepted ? accepted.length : 0;
    const reasons = { duplicate: 0, unsupported: 0, failed: 0 };
    (rejected || []).forEach(([, reason]) => {
      if (reason === 'duplicate') reasons.duplicate++;
      else if (reason === 'unsupported file type') reasons.unsupported++;
      else reasons.failed++;
    });
    if (!added && !reasons.duplicate && !reasons.unsupported && !reasons.failed) {
      show('No new images were added', { type: 'warning' });
      return;
    }
    if (added) show(`${added} image${added === 1 ? '' : 's'} added`, { type: 'success' });
    if (reasons.duplicate) show(`${reasons.duplicate} duplicate${reasons.duplicate === 1 ? '' : 's'} skipped`, { type: 'warning' });
    if (reasons.unsupported) show(`${reasons.unsupported} unsupported file${reasons.unsupported === 1 ? '' : 's'} skipped`, { type: 'warning' });
    if (reasons.failed) show(`${reasons.failed} file${reasons.failed === 1 ? '' : 's'} failed validation`, { type: 'warning' });
  }

  return { show, showImportSummary };
})();
