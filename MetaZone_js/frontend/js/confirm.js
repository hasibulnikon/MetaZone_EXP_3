// v0.9.4: shared confirmation modal, the "Confirm" utility called for
// in the UX spec's shared-architecture section. Used sparingly and
// deliberately -- only for genuinely destructive/risky actions (Clear
// All while generation is running being the first real caller), never
// for routine actions that Undo (see toast.js's action button) already
// covers more lightly. Promise-based so call sites read like:
//
//   const ok = await Confirm.show({
//     title: 'Generation is currently running',
//     message: 'Clearing the batch will stop the current generation and remove the current images and results.',
//     confirmLabel: 'Stop & Clear',
//     danger: true,
//   });
//   if (!ok) return;
//
const Confirm = (() => {
  function show({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'confirm-backdrop';
      backdrop.innerHTML = `
        <div class="confirm-dialog" role="alertdialog" aria-modal="true">
          <div class="confirm-title"></div>
          <div class="confirm-message"></div>
          <div class="confirm-actions">
            <button type="button" class="btn confirm-cancel"></button>
            <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'} confirm-ok"></button>
          </div>
        </div>`;
      backdrop.querySelector('.confirm-title').textContent = title || '';
      backdrop.querySelector('.confirm-message').textContent = message || '';
      backdrop.querySelector('.confirm-cancel').textContent = cancelLabel;
      backdrop.querySelector('.confirm-ok').textContent = confirmLabel;
      document.body.appendChild(backdrop);

      function close(result) {
        backdrop.removeEventListener('keydown', onKey);
        backdrop.classList.remove('confirm-in');
        setTimeout(() => backdrop.remove(), 150);
        resolve(result);
      }
      function onKey(e) {
        if (e.key === 'Escape') close(false);
        if (e.key === 'Enter') close(true);
      }
      backdrop.addEventListener('keydown', onKey);
      backdrop.querySelector('.confirm-cancel').addEventListener('click', () => close(false));
      backdrop.querySelector('.confirm-ok').addEventListener('click', () => close(true));
      // Clicking the backdrop itself (not the dialog) cancels -- same
      // "escape hatch always available" spirit as the Esc key above.
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(false); });

      requestAnimationFrame(() => requestAnimationFrame(() => {
        backdrop.classList.add('confirm-in');
        backdrop.querySelector('.confirm-ok').focus();
      }));
    });
  }
  return { show };
})();
