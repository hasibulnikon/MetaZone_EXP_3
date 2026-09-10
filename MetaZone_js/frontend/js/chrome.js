// Global chrome shared across every page, matching the original app's
// persistent top bar.
//
// v0.8.4: the bottom status bar (done/failed/pending pills + ExifTool/
// Drag&Drop line) was removed from the UI per Hasib's explicit request.
// The live counts it displayed are still tracked here (liveCounts) in
// case a future page wants them, and get_status_bar() is still called
// once at startup so btnStopAll's initial visibility stays correct if
// a batch was already running -- but nothing renders the removed pills
// or ExifTool text anymore.

const btnStopAll = document.getElementById('btnStopAll');

let liveCounts = { done: 0, failed: 0, pending: 0 };

// Real counts, driven by the same card_update events the Meta
// Generator grid already listens to -- kept for any page that wants
// them later, not rendered anywhere right now.
BackendEvents.on('card_update', (p) => {
  if (p.result.status === 'done') liveCounts.done++;
  else if (p.result.status === 'failed') liveCounts.failed++;
  if (liveCounts.pending > 0) liveCounts.pending--;
});

BackendEvents.on('task_progress', (p) => {
  const remaining = Math.max((p.total || 0) - (p.done || 0), 0);
  if (remaining >= 0 && p.total) liveCounts.pending = remaining;
  btnStopAll.style.display = 'inline-block';
});

BackendEvents.on('task_completed', () => { btnStopAll.style.display = 'none'; });
BackendEvents.on('embed_completed', () => { btnStopAll.style.display = 'none'; });

async function loadStatusBar() {
  const res = await pywebview.api.get_status_bar();
  if (!res.ok) return;
  btnStopAll.style.display = res.meta_running ? 'inline-block' : 'none';
}

btnStopAll.addEventListener('click', async () => {
  await pywebview.api.stop_generation();
  btnStopAll.style.display = 'none';
});

document.getElementById('btnRefresh').addEventListener('click', () => {
  loadStatusBar();
  // Re-fire whichever page is currently visible's own refresh, if it has one.
  const visible = document.querySelector('.page:not([hidden])');
  if (visible && visible.id === 'page-dashboard' && typeof loadDashboard === 'function') loadDashboard();
});

loadStatusBar();
